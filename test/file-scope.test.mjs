/**
 * The four native file tools are published PER SESSION.
 *
 * Issue #52: they used to be registered on the plugin row's context, which is a
 * SIBLING of every session's context. DSH resolves services up the chain, so the
 * registration succeeded and was visible to no agent at all. These checks assert
 * the scope, the release path and the execution contract against the real host.
 *
 * No FastCtx runtime is needed: the file component only needs a worker
 * executable, and the fixture below is one, so a scope regression is caught even
 * on a machine that cannot run the PTC runtime suite.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createScope } from '@deepseek-ai/dsh-scope'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { applyComponent } from '../lib/index.js'
import { FILE_TOOLS, publicToolName } from '../lib/policy.js'
import { assert, report, test, waitFor, withTempDir } from './lib/harness.mjs'
import { bootHost, registryNames, scopedToolNames, shutdown } from './lib/host.mjs'

const EXPECTED = FILE_TOOLS.map(publicToolName).sort()

/**
 * A worker executable that answers one call with a JSON result, without Rust.
 *
 * Only the execution check below spawns it, and that check is POSIX-only: the
 * fixture is a shebang script. Every other check merely resolves the file, which
 * is why they hold on any platform.
 */
function stageWorker(dir) {
  const file = path.join(dir, 'file-worker-under-test')
  fs.writeFileSync(file, `#!/usr/bin/env node
let input = ''
process.stdin.on('data', chunk => { input += chunk })
process.stdin.on('end', () => {
  const request = JSON.parse(input)
  process.stdout.write(JSON.stringify({
    status: 'completed',
    tool: request.tool,
    path: request.args.path,
    readOnly: request.read_only === true,
    scope: request.scope,
  }))
})
`)
  if (process.platform !== 'win32') fs.chmodSync(file, 0o755)
  return file
}

/** The authority services the mount gates on, exactly as the real host provides them. */
async function authority(ctx) {
  await ctx.plugin(Subprocess)
  await ctx.plugin(Sandbox, {})
  await ctx.plugin(inner => inner.provide('sandboxPolicy', {
    resolve: ({ session }) => ({ mode: session.mode, workspaceRoot: session.header.cwd, sessionId: session.id }),
  }))
}

/** One real session scope, the way an agent owns one. */
function session(ctx, id, cwd, mode = 'danger-full-access') {
  const agent = { id, session: { id, mode, header: { cwd } } }
  const scope = createScope(ctx, agent)
  agent.ctx = scope.ctx
  return { agent, scope }
}

async function announce(ctx, agent) {
  await ctx.serial('agent/created', { agent, source: 'startup' })
}

async function visible(ctx, agent) {
  await waitFor(() => EXPECTED.every(name => scopedToolNames(ctx, agent).includes(name)), { timeoutMs: 5000, what: `the file tools in session ${agent.id}` })
}

/**
 * Mount the file component against a staged fixture worker.
 * @param {object} ctx - the host context.
 * @param {string} worker - an absolute path to the fixture worker.
 * @param {object} [config] - extra row config.
 * @returns {Promise<object>} the plugin fiber.
 */
async function mountFile(ctx, worker, config = {}) {
  return ctx.plugin({ name: 'fixture-file-scope', apply(inner) {
    return applyComponent(inner, { toolCallTimeoutMs: 5000, binaryPath: worker, ...config }, 'file')
  } })
}

await test('the four file tools register inside each session scope and never globally', async () => {
  await withTempDir('file-scope-registration', async dir => {
    const worker = stageWorker(dir)
    const { ctx } = await bootHost()
    try {
      await authority(ctx)
      const fiber = await mountFile(ctx, worker)
      // Mounting alone publishes nothing: there is no session to publish into.
      assert.deepEqual(registryNames(ctx), [], 'a plugin-row registration would be the #52 regression')

      const { agent: first } = session(ctx, 'scope-first', dir)
      await announce(ctx, first)
      await visible(ctx, first)
      for (const name of EXPECTED) {
        assert.ok(scopedToolNames(ctx, first).includes(name), `${name} must be visible to its session`)
        assert.equal(ctx.get('tools').get(name, first) !== undefined, true, `${name} resolves through the session chain`)
        // The global view is the plugin row's own view: nothing may appear there.
        assert.equal(ctx.get('tools').get(name), undefined, `${name} must not be globally registered`)
      }
      assert.deepEqual(registryNames(ctx), [], 'no file tool may reach the shared registry')

      const { agent: second } = session(ctx, 'scope-second', dir)
      await announce(ctx, second)
      await visible(ctx, second)
      assert.ok(scopedToolNames(ctx, first).includes(publicToolName('glob')), 'a later session does not evict an earlier one')
      assert.deepEqual(registryNames(ctx), [], 'a second session still publishes nothing globally')

      // A session that never announced itself inherits nothing, because the
      // plugin row is not an ancestor of it.
      const { agent: silent } = session(ctx, 'scope-silent', dir)
      assert.equal(scopedToolNames(ctx, silent).some(name => EXPECTED.includes(name)), false, 'an unannounced scope must not see the tools')

      await fiber.dispose()
      assert.equal(scopedToolNames(ctx, first).some(name => EXPECTED.includes(name)), false, 'component disposal releases every session')
    } finally { await shutdown(ctx) }
  })
})

await test('a disposed session releases its tools, and its scope owns them', async () => {
  await withTempDir('file-scope-release', async dir => {
    const worker = stageWorker(dir)
    const { ctx } = await bootHost()
    try {
      await authority(ctx)
      const fiber = await mountFile(ctx, worker)
      const { agent: kept } = session(ctx, 'release-kept', dir)
      const { agent: gone } = session(ctx, 'release-gone', dir)
      await announce(ctx, kept)
      await announce(ctx, gone)
      await visible(ctx, kept)
      await visible(ctx, gone)

      await ctx.serial('agent/disposed', { agent: gone })
      await waitFor(() => !scopedToolNames(ctx, gone).some(name => EXPECTED.includes(name)), { timeoutMs: 5000, what: 'the disposed session to lose its tools' })
      assert.ok(scopedToolNames(ctx, kept).includes(publicToolName('grep')), 'the surviving session keeps its tools')
      // Disposal is idempotent: a repeated event must not disturb the survivor.
      await ctx.serial('agent/disposed', { agent: gone })
      assert.ok(scopedToolNames(ctx, kept).includes(publicToolName('grep')))

      // The registration is owned by a child of the session's own scope, so
      // tearing the scope down releases it even without an `agent/disposed`.
      const { agent: orphan, scope: orphanScope } = session(ctx, 'release-orphan', dir)
      await announce(ctx, orphan)
      await visible(ctx, orphan)
      await orphanScope.dispose()
      assert.equal(scopedToolNames(ctx, orphan).some(name => EXPECTED.includes(name)), false, 'the session scope owns the registration, so its disposal releases the tools')

      await fiber.dispose()
      assert.equal(scopedToolNames(ctx, kept).some(name => EXPECTED.includes(name)), false, 'component disposal releases the survivor too')
    } finally { await shutdown(ctx) }
  })
})

await test('one session never registers a name twice, across re-announcement and mode changes', async () => {
  await withTempDir('file-scope-idempotent', async dir => {
    const worker = stageWorker(dir)
    const { ctx } = await bootHost()
    try {
      await authority(ctx)
      const registry = ctx.get('tools')
      const published = []
      const realRegister = registry.register
      registry.register = function (definition) {
        if (EXPECTED.includes(definition.name)) published.push(definition.name)
        return realRegister.call(this, definition)
      }
      const fiber = await mountFile(ctx, worker)
      try {
        const { agent } = session(ctx, 'idempotent', dir)
        await announce(ctx, agent)
        await visible(ctx, agent)
        assert.deepEqual([...published].sort(), EXPECTED, 'exactly one registration per name on the first announcement')

        // A duplicate `agent/created` (rollback/resume shapes exist) must be a
        // no-op, not a second registration or a registry conflict.
        await announce(ctx, agent)
        const { agent: sibling } = session(ctx, 'idempotent-sibling', dir)
        await announce(ctx, sibling)
        await visible(ctx, sibling)
        agent.session.mode = 'read-only'
        await ctx.serial('session/event', agent.session, { type: 'sandbox/mode' })
        agent.session.mode = 'workspace-write'
        await ctx.serial('session/event', agent.session, { type: 'sandbox/mode' })
        await new Promise(resolve => setImmediate(resolve))

        assert.deepEqual([...published].sort(), [...EXPECTED, ...EXPECTED].sort(), 'only the two sessions registered, once each')
        const names = scopedToolNames(ctx, agent).filter(name => EXPECTED.includes(name))
        assert.deepEqual(names, EXPECTED, 'each name appears exactly once in the session view')
      } finally {
        registry.register = realRegister
        await fiber.dispose()
      }
    } finally { await shutdown(ctx) }
  })
})

await test('registration to the session scope still runs through the authority gate', async () => {
  if (process.platform === 'win32') return
  await withTempDir('file-scope-execution', async dir => {
    const worker = stageWorker(dir)
    fs.writeFileSync(path.join(dir, 'data.txt'), 'before\n')
    const { ctx } = await bootHost()
    try {
      await authority(ctx)
      await mountFile(ctx, worker)
      const { agent } = session(ctx, 'execution', dir, 'workspace-write')
      await announce(ctx, agent)
      await visible(ctx, agent)
      const exec = { agent, signal: new AbortController().signal }

      // A successful fixture answer proves `subprocess` and `sandboxPolicy` still
      // resolve for a definition registered in the session's own scope: the
      // worker only answers because DSH spawned it.
      const read = await ctx.get('tools').get(publicToolName('inspect_local_file'), agent)
        .execute({ path: 'data.txt' }, exec)
      assert.equal(read.status, 'completed', JSON.stringify(read))
      assert.equal(read.tool, 'inspect_local_file')
      assert.equal(read.path, path.join(dir, 'data.txt'), 'the worker sees the session cwd resolved path')
      assert.equal(read.readOnly, false)
      assert.equal(read.scope, 'execution')

      // Read-only keeps the original semantics: the tool stays visible and the
      // CALL is refused before anything is spawned.
      agent.session.mode = 'read-only'
      await ctx.serial('session/event', agent.session, { type: 'sandbox/mode' })
      const replace = ctx.get('tools').get(publicToolName('replace'), agent)
      assert.ok(replace, 'ops_replace remains visible in a read-only session')
      const refused = await replace.execute({ path: 'data.txt', pattern: 'before', replacement: 'after' }, exec)
      assert.equal(refused.error.code, 'POLICY_DENIED', JSON.stringify(refused))
      assert.equal(refused.status, 'rejected')
      assert.equal(refused.changed, undefined, 'a refused call reports no change count')
      assert.equal(fs.readFileSync(path.join(dir, 'data.txt'), 'utf8'), 'before\n', 'a refused replace never writes')

      // The same call in workspace-write reaches the worker with read_only false.
      agent.session.mode = 'workspace-write'
      await ctx.serial('session/event', agent.session, { type: 'sandbox/mode' })
      const allowed = await ctx.get('tools').get(publicToolName('replace'), agent)
        .execute({ path: 'data.txt', pattern: 'before', replacement: 'after' }, exec)
      assert.equal(allowed.status, 'completed', JSON.stringify(allowed))
      assert.equal(allowed.tool, 'replace')
      assert.equal(allowed.readOnly, false)
    } finally { await shutdown(ctx) }
  })
})

await test('an agent registry that already has sessions is served at mount time', async () => {
  await withTempDir('file-scope-existing', async dir => {
    const worker = stageWorker(dir)
    const { ctx } = await bootHost()
    try {
      await authority(ctx)
      const { agent } = session(ctx, 'existing', dir)
      await ctx.plugin(inner => inner.provide('agents', { list: () => [agent] }))
      const fiber = await mountFile(ctx, worker)
      await visible(ctx, agent)
      assert.deepEqual(registryNames(ctx), [], 'the pre-existing session is served without a global registration')
      await fiber.dispose()
      assert.equal(scopedToolNames(ctx, agent).some(name => EXPECTED.includes(name)), false, 'disposal releases a pre-existing session too')
    } finally { await shutdown(ctx) }
  })
})

report('file-scope')
