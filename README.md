# pi-dstack-notify

Deliberate attention and curated FYIP notifications for Pi: **Inbox SEND → durable canonical correlation → independent full READ verification → Telegram**. The package ROOT registers only `notification_publish` and `notification_publish_fyip`, both model-only and sequential. One existing core owns policy, classification and deduplication. No automatic loop/reminder controller or production OWNER workflow is enabled or needed for these two tools.

**This uninstalled successor of public1493 adds bounded CONTINUE adoption, not fresh-history provisioning.** The accepted installed1493 package remains inactive; no live acceptance is claimed. [CONTINUE one-item guide](docs/CONTINUE-ONE-ITEM.md) describes the shipped secure existing-ENV reuse, exact opaque archive, and private operator-selected ONE current setup intent. The same v3 ledger, policy, canonical and terminal-unknown rules apply. Fresh provisioning remains strict. The inherited Pi 1.5.0 adapter extracts the complete native CallToolResult from host `result.structuredContent`; outer/host/native checks remain intact. The built-in wrapper omits native `_meta`. Intended ordinary-host registration, permissions and after-hooks remain Installer-owned/unproven. See the historical [native contract](docs/NATIVE-COMPATIBILITY.md); the new CONTINUE guide supersedes historical fresh-only setup limitations, not their preservation warnings.

## Setup from an explicitly located new-revision package root

Use an explicit checkout of the reviewed new revision, or an actual package path measured by your installer; `cd` to that directory containing package.json. Do not guess a Pi cache path. Node **>=24** is required. These are operator interfaces, not instructions already executed on your machine.

1. **Create a disabled configuration**, with no credentials, project activation or ledger creation:
   ```sh
   node ./pi-extension/admin.ts --help
   node ./pi-extension/admin.ts scaffold
   ```
   This exclusively creates `~/.pi-dstack-notify/config.json` (0600) in its private directory (0700), containing `{"version":1,"enabled":false,"projects":[]}`. It never overwrites/repairs. Alternatively `scaffold --config /absolute/private/config.json` requires an existing safe private parent.
2. **Prepare private operator configuration** using [CONFIGURATION](docs/CONFIGURATION.md) and [safe templates](examples/). Keep disabled until separately ready. Exact canonical working directory, both enable bits, stable identities, private profile, pinned Inbox base and a validated ledger are required. Telegram uses private TOML; optional Clef uses private JSON/key files. No credential ENV names or Pi model-provider fallback exist.
   ```sh
   node ./pi-extension/admin.ts validate --config /absolute/private/config.json
   ```
   Validation is structural/private-file validation, not transport/destination readiness.
3. **Preserve history; choose existing versus genuinely fresh storage externally.** Inspect an existing v2/v3 ledger with:
   ```sh
   node ./pi-extension/admin.ts status --ledger /absolute/private/ledger.sqlite
   ```
   Only for genuinely fresh history, when ALL four assertions are already externally true:
   ```sh
   node ./pi-extension/admin.ts provision-fresh --ledger /absolute/private/ledger.sqlite --dispatch-disabled --all-old-writers-quiesced --wal-consistent-backup-verified --no-prior-history
   ```
   The utility does NOT prove those assertions. Known legacy history is prior history and cannot satisfy `--no-prior-history`. Missing storage proves no history fact. It calls existing v3 initialization once; refuses existing DB/WAL/SHM/fence/lock; never resets/upgrades/restores/retries/deletes locks. Initialization publishes the existing **active fence**; the dispatch-disabled assertion is a prerequisite, not permanent fence state or configuration activation. Failure preserves artifacts; stop rather than retry. Status is read-only SQLite/schema/fence inspection, with possible WAL/SHM effects, not send permission or global dedupe-policy changes.
4. **Normal Pi starts select the persistent package default** `~/.pi-dstack-notify/config.json`; no repeating flag or Pi settings trick. An explicit override remains:
   ```sh
   pi --notification-config /absolute/private/config.json
   ```
   Only undefined flag lookup selects the default. Invalid explicit selection stays unavailable. Selection is captured once after binding; startup reads/creates no private config, profile, key or DB. Actual operations perform strict checks and byte/lifetime rechecks. Restart deliberately to change selection. Missing/disabled default stays inert. Configuration activation, grants, native compatibility and actual delivery verification remain separate operator actions—not effects of install/scaffold/status.

## Existing release versus this candidate

Public `2539167a0e23835fa96a508ea0122729039bad9e` remains unchanged: inert-installable, scoped source/offline validated, **no** packaged admin CLI, persistent default or notification-JSON Clef selector. Its startup flag is not remembered by Pi. Do not apply this candidate's new key/commands to that release. Exact old-pin installation and one explicitly authorized corrected guarded installed-ROOT SDK startup/shutdown/disposal passed with zero guarded effects. The original harness model-shape failure remains a failure, not a source defect. A shared npm-log/cache-namespace preservation exception remains unresolved; this source work neither investigates nor repairs it. Current-session hotload, role grants and configured end-to-end readiness are not established here. This source candidate does not update an installation or public repository.

Fixed native reach is `mcp__plannotator_inbox__send_message` and `mcp__plannotator_inbox__read_thread`: declaration is **not** a grant, MCP installation or permission bypass. These dependencies must be available in `ctx.tools`; model-only publishers cannot be called via codemode/another tool's executeTool. Telegram/Clef use direct HTTPS, not nested MCP sends. No `dry_run`, destination/config/provider override or raw sender is a public tool argument.

`unknown` is terminal uncertainty, **not retry permission**; `sent` is not approval or verified recipient reachability. FYIP NO quietly suppresses; admitted unavailable/error/invalid/uncertain classifier outcomes may use labeled fallbacks after delivery gates. [Synthetic arguments](docs/SYNTHETIC-EXAMPLES.md), [configuration](docs/CONFIGURATION.md), [scope/evidence](docs/PROVENANCE.md), [installation boundaries](docs/INSTALLATION.md).

Declared Node baseline is >=24; offline checks target Node24.22.1 / Pi1.4.0 / real host TypeBox1.3.27 / TS5.8.3. External exact-byte candidate evidence records measured results, not configured production delivery. In-process guards are not an OS sandbox. Optional installation is not a shipping prerequisite.

MIT attribution is preserved in [LICENSE](LICENSE); original Unicode ©2023/trademark and complete applicable notice are in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Future `pi-dstack-loop-tools` remains separate, unimplemented scope; continuation must not require notifications. Necessary dormant shared core/v3 safeguards are retained honestly, not described as decoupled.
