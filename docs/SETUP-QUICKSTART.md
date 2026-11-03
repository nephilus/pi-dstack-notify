# fd0 setup quickstart (documentary; nothing executed)

Accepted installed fd0 remains inactive. This separate unpublished correction is not installed; no new pin/update is requested. Documentary setup path:

```sh
pi list
cd /absolute/verified/package-root
node ./pi-extension/admin.ts --help
node ./pi-extension/admin.ts scaffold
```

`pi list` identifies the package declaration; obtain its **actual root** from the installer's verified path or use an explicitly verified fd0 checkout containing `package.json`. Do not guess a cache path. Node **>=24** runs the relative packaged entry; there is no global admin binary or Pi slash command.

Scaffold exclusively creates **disabled** `~/.pi-dstack-notify/config.json` (0600, directory0700), with `{"version":1,"enabled":false,"projects":[]}`. Existing files are refused, not repaired. Alternate syntax is `scaffold --config /absolute/private/config.json`; that parent must already be safe/private. No profile, key, ledger, grants or activation is provisioned automatically.

## Prepare private files, remain disabled

Example canonical paths below are fictional: replace them with your own existing canonical project directory and private paths, not package-cache paths. All private files must be current-user-owned, single-link regular files, no symlinks/group/other permissions (normally0600); private storage parent0700. JSON rejects duplicate/unknown keys.

```json
{"version":1,"enabled":false,"projects":[{
  "project_path":"/srv/example/project","enabled":false,
  "profile_path":"/home/you/.private/notify/profile.toml",
  "ledger_path":"/home/you/.private/notify/ledger.sqlite",
  "policy":"notification_product",
  "inbox_base_url":"https://inbox.example.invalid/"
}]}
```

Private TOML profile:

```toml
[safety]
telegram_enabled = false
telegram_bot_token = "REPLACE_PRIVATELY"
telegram_chat_id = "REPLACE_PRIVATELY"
[notification_profile]
profile_id = "example.profile"
destination_id = "example.destination"
```

These placeholders cannot deliver. Under separate operational authority, use valid private credentials and `telegram_enabled=true`; both global **and** project JSON enable bits must also be true. Project selection requires **exact canonical cwd**, not subdirectories. Preserve stable identities/history. `notification_product`/FYIP needs v3; `explicit_attention` allows validated v2/v3. Pin the actual HTTPS Inbox base; example.invalid is nonworking.

Optional top-level `clef_config_path` names private Clef JSON with exactly `version:1`, `base_url` (HTTPS origin), `key_file` (absolute private key-file path), `model`, `expected_model`, `timeout_seconds` (>0, <=5). Use the shipped template and CONFIGURATION constraints; no Telegram/Clef credential ENV names or Pi-model inference exist.

```sh
node ./pi-extension/admin.ts validate --config /absolute/private/config.json
node ./pi-extension/admin.ts status --ledger /absolute/private/ledger.sqlite
```

Validate is structural, not readiness. Status inspects existing v2/v3 schema/fence with read-only SQLite; WAL/SHM effects are possible. Neither grants send permission.

Only if **all four assertions are externally true**, genuinely fresh history may use:

```sh
node ./pi-extension/admin.ts provision-fresh --ledger /absolute/private/ledger.sqlite --dispatch-disabled --all-old-writers-quiesced --wal-consistent-backup-verified --no-prior-history
```

The utility proves neither freshness, quiescence nor backup. Known legacy history is prior history and **cannot satisfy `--no-prior-history`**; absent files prove nothing. Existing/partial/unknown history is not a fresh-init case. Failures: preserve artifacts and stop. Replacing keys/DB is not retry permission. Initialization publishes an active fence, not configuration activation.

Normal `pi` selects persistent `~/.pi-dstack-notify/config.json`; optional `pi --notification-config /absolute/private/config.json` replaces it. Only **undefined** lookup falls back; invalid explicit values stay inert. Selection is captured once after binding: change it only in a fresh adapter/runtime, not via an invented Pi settings key.

On the identified Pi1.5.0 built-in MCP path, fd0 reads the wrong result layer: native CallToolResult is at `result.structuredContent`. SEND can take effect before decode rejects it and before canonical association. Configuration/provisioning does not fix this. This unpublished child corrects that named layout only; actual deployed wrapper/server identity remains unknown. No restart, configuration, provisioning or send occurred here.

Sources: [README](../README.md), [configuration](CONFIGURATION.md), [native contract](NATIVE-COMPATIBILITY.md); `pi-extension/admin.ts:10–96`, `adapter/config-selection.ts:5–19`.
