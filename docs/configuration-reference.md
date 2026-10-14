# Configuration reference

Every configuration key, and **which component row owns it**.

---

## Where configuration lives

In DSH's configuration editor, find the corresponding `dsh-ops/shell`, `dsh-ops/file`, `dsh-ops/background`, `dsh-ops/ptc` or `dsh-ops/linux` row, adjust `config`, then save; unknown configuration keys cause errors naming the key.

The bundle declares five independently toggled components. On first installation, the first two are enabled by default; PTC and the Linux component are opt-in:

| Row `name` | Component | Default |
| --- | --- | --- |
| `dsh-ops/shell` | Terminal and shell | On |
| `dsh-ops/file` | Rust file tools | On |
| `dsh-ops/background` | Background tasks | Off |
| `dsh-ops/ptc` | Native PTC batches | Off |
| `dsh-ops/linux` | Linux host surface: the file tools and the machine's own bash | Off |

---

## 🔴 Which key belongs to which component

The table below gives the **owning component** for each key. Putting a key on a row that does not own it is rejected by configuration validation, which names the offending key.

| Key | Type | Default | Owning component |
| --- | --- | --- | --- |
| `configUpdateVersion` | non-negative integer | `0` | any (migration marker) |
| `serverName` | string, `[A-Za-z0-9_-]{1,32}` | `fastctx` | legacy compatibility |
| `binaryPath` | string path | — | background / ptc |
| `bashPath` | string path | — | shell / linux |
| `enableShellTools` | boolean | `true` | background |
| `publishBashTool` | boolean | `true` | shell / linux |
| `promptPolicy` | boolean | `true` | all |
| `extraGuidance` | string | empty | all |
| `toolCallTimeoutMs` | positive integer (ms) | `300000` | background / file |
| `required` | boolean | `false` | all |
| `shellPolicy` | `advise` \| `deny-host-shell` | `advise` | shell |
| `deniedHostTools` | string array | `[pwsh, bash, pwsh_persistent]` | shell |
| `allowSystemShellFallback` | boolean | `false` | shell / linux |
| `denyCredentialReads` | boolean | `true` | file / linux / ptc |

---

## Examples

The `dsh-ops/shell` row:

```yaml
config:
  promptPolicy: true
  publishBashTool: true
  shellPolicy: advise
  allowSystemShellFallback: false
  # bashPath: 'C:\tools\bash.exe'
```

The `dsh-ops/background` row (its market row is disabled by default):

```yaml
config:
  promptPolicy: true
  enableShellTools: true
  required: false
  toolCallTimeoutMs: 300000
  # binaryPath: 'C:\tools\fastctx.exe'
  # Managed update metadata; do not remove after the first startup self-check
  # configUpdateVersion: 1
```

---

## Key by key

- `enableShellTools`: deployment switch for the background component; enabling it still requires session `danger-full-access` to publish the four background tools. The file component never publishes command tools.
- `publishBashTool`: publish `ops_bash` using current session policy; restricted modes require the host sandbox, full access uses the host subprocess service.
- `promptPolicy`: whether to inject the component's runtime guidance; use `extraGuidance` to append instructions.
- `toolCallTimeoutMs`: FastCtx RPC wait timeout; it does not mean server-side work has terminated. Ceiling `2147483647`.
- `required`: whether to reject activation when the runtime is unavailable.
- `shellPolicy`: defaults to `advise`; `deny-host-shell` rejects host shells in `deniedHostTools` (default `[pwsh, bash, pwsh_persistent]`). This also disables third-layer pwsh; enable cautiously.
- `allowSystemShellFallback`: defaults to `false`. Without a bundled/provisioned bash, do not discover system PATH or well-known installations; background commands cannot bypass this through FastCtx discovery either. Explicit `true` opts into an unpinned system bash that the operator must trust and maintain. Explicit `bashPath` is a separate operator selection, not an automatic fallback. See the update configuration modification area in the [usage guide](usage.md) for the first-start migration.
- `denyCredentialReads`: defaults to `true`. The file tools refuse paths inside a credential location (`~/.ssh`, `~/.aws`, `~/.kube`, `~/.dsh/.credentials.yaml`, `.npmrc`, `.netrc`, `.git-credentials`, private-key names, credential-shaped files, `.env`), in every permission mode and for a batch operation root as well. Writes were already fenced by the permission mode; this closes the read direction, because the DSH filesystem layer does not fence those paths and a repository tool has no job that needs one. Set `false` per row to allow a specific deployment's file, or add paths with `DSH_OPS_DENY_READ` (which only widens the list, never opens it).
- `shellPolicy` is independent: `deny-host-shell` masks/refuses host tools; disabling fallback constrains the plugin's bash resolver, not the host's own `pwsh`, and is not a filesystem sandbox.
- `binaryPath` / `bashPath`: optional explicit paths; unavailable paths cause an error rather than silently switching executors. Usually no configuration is needed.
- `deniedHostTools`: the host tool names refused by the `deny-host-shell` policy.
- `serverName`: the legacy FastCtx server identity, kept for existing deployment rows; server instructions are no longer published as a separate prompt section.
- `configUpdateVersion`: completion marker for the one-time configuration migration. Do not remove it, or the self-check runs again.

---

## Prompt registration

Prompts are registered as independent runtime sections, **not written to AGENTS.md**: shell OFF withdraws bash/pwsh routing; file OFF withdraws native file guidance; background OFF withdraws background tools and owned-job guidance. The file component uses its independent Rust worker; FastCtx is retained only by the disabled background component. Four native file tools and `ops_bash` are added by default; duplicate foreground `ops_run` is not published. These changes reduce fixed declaration costs. The Minimal preset overrides additional system sections; PTC mode calls the underlying tools through the SDK with unchanged permission gates.

---

## See also

- [Usage](usage.md) — install, update, remove, CLI
- [Component reference](component-reference.md) — components and tools
- [Troubleshooting](troubleshooting.md) — errors and diagnosis
