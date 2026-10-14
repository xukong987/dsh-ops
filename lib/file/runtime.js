import { definition, FILE_TOOLS } from './contract.js'
import { invoke, failure } from './worker.js'

const messageOf = error => String(error?.message ?? error)

/**
 * The native Rust file tools, published once per session.
 *
 * A session's context is a SIBLING of the plugin row's context, and DSH resolves
 * services up the chain, so a registration made on the plugin row exists in the
 * registry but is visible to no agent — the tools appear "published" and are
 * uncallable from every session. Each live session therefore gets its own
 * publication under `agent.ctx`, the same shape the session bash surface uses,
 * released with that session.
 *
 * The authority services (`sandboxPolicy`, `subprocess`) are still read from the
 * context this surface was mounted on: the mount gated on them there, and only
 * the caller's identity — not the services — is per session. `invoke` re-resolves
 * the authoritative policy for the calling session on every call, so a session
 * whose mode changed is never served under a stale permission.
 */
export class NativeFileTools {
  /**
   * @param {object} options - the surface inputs.
   * @param {object} options.ctx - this plugin's own mounting context, which resolved the authority services.
   * @param {object} options.config - the resolved plugin configuration plus `workerPath`.
   * @param {(message: string, level?: string) => void} [options.report] - where asynchronous events are reported.
   */
  constructor({ ctx, config, report }) {
    this.ctx = ctx
    this.config = config
    this.report = report ?? (() => {})
    this.file = undefined
    /** Live sessions with their own publication; keyed by agent. */
    this.agents = new Map()
    this.active = new Set()
    this.stopped = false
  }

  /**
   * Resolve the worker and serve every session that already exists.
   * @returns {Promise<string[]>} the public names this surface serves, per session.
   */
  async start() {
    this.file = this.config.workerPath
    if (!this.file) {
      if (this.config.required) throw new Error('Native file worker path is unavailable.')
      return []
    }
    for (const agent of this.ctx.get('agents')?.list?.() ?? []) this.attachAgent(agent)
    return FILE_TOOLS.map(name => `ops_${name}`)
  }

  /**
   * Serve one session.
   *
   * The registration is owned by a child fiber of `agent.ctx`: it inherits that
   * agent's scope tag, so exactly that session sees the tools, and it is disposed
   * with the agent even if no `agent/disposed` listener ever runs. Attaching an
   * agent that is already attached is a no-op.
   * @param {object} agent - the live DSH agent.
   * @returns {void}
   */
  attachAgent(agent) {
    if (this.stopped || !agent?.ctx || this.agents.has(agent)) return
    const entry = { ctx: undefined, fiber: undefined, names: new Set(), disposers: [] }
    this.agents.set(agent, entry)
    try {
      entry.fiber = agent.ctx.plugin(child => {
        // The agent's own registry may not be injected at `agent/created`;
        // registering before it exists would publish outside the session scope.
        child.inject(['tools'], toolsCtx => {
          entry.ctx = toolsCtx
          this.refreshAgent(agent)
        })
      })
    } catch (error) {
      // A session that cannot own its scope gets no tools at all rather than a
      // registration stranded where no session can see it.
      this.agents.delete(agent)
      this.report(`dsh-ops: native file tools could not attach to a session: ${messageOf(error)}`, 'warn')
    }
  }

  /**
   * Reconcile one session's publication.
   *
   * Idempotent per name: a tool already published for this session is never
   * registered again (the registry rejects a duplicate inside one scope), and a
   * name whose earlier attempt failed is retried. The published SET does not
   * depend on the permission mode — a read-only session still sees `ops_replace`
   * and is refused inside the call, which re-resolves the authoritative policy
   * every time — so a mode change republishes nothing and cannot open a window
   * in which a session momentarily has no file tools.
   * @param {object} agent - the live DSH agent.
   * @returns {void}
   */
  refreshAgent(agent) {
    const entry = this.agents.get(agent)
    if (!entry?.ctx || this.stopped) return
    for (const rawName of FILE_TOOLS) {
      if (entry.names.has(rawName)) continue
      try {
        entry.disposers.push(entry.ctx.tools.register(definition(rawName, (args, exec) => this.call(rawName, args, exec))))
        entry.names.add(rawName)
      } catch (error) {
        // The name belongs to something else in this exact scope: never shadow
        // its owner, and never let one refusal strand the other three.
        this.report(`dsh-ops: native file tool ops_${rawName} is not published for this session: ${messageOf(error)}`, 'warn')
      }
    }
  }

  /** Reconcile every attached session; a permission change republishes nothing. */
  refreshAgents() {
    for (const agent of this.agents.keys()) this.refreshAgent(agent)
  }

  /**
   * Release one session's tools.
   * @param {object} agent - the live DSH agent.
   * @returns {Promise<void>|undefined} resolves once the session's fiber is gone.
   */
  detachAgent(agent) {
    const entry = this.agents.get(agent)
    if (!entry) return
    this.agents.delete(agent)
    for (const dispose of entry.disposers.splice(0)) dispose()
    entry.names.clear()
    return entry.fiber?.dispose()
  }

  async call(tool, args, exec) {
    if (this.stopped) return failure('POLICY_DENIED', 'Native file component is disposed.')
    const controller = new AbortController()
    const abort = () => controller.abort(exec?.signal?.reason)
    if (exec?.signal?.aborted) abort()
    else exec?.signal?.addEventListener?.('abort', abort, { once: true })
    this.active.add(controller)
    try { return await invoke(this.ctx, this.file, tool, args, exec, controller.signal, this.config) }
    finally {
      this.active.delete(controller)
      exec?.signal?.removeEventListener?.('abort', abort)
    }
  }

  /** Unregister every session's tools, then drop what was still in flight. */
  async stop() {
    this.stopped = true
    for (const controller of this.active) controller.abort(new Error('Native file component unloaded'))
    await Promise.allSettled([...this.active])
    await Promise.all([...this.agents.keys()].map(agent => this.detachAgent(agent)))
  }
}
