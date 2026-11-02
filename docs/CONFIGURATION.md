# Private configuration and explicit administration

## Selection on ordinary starts (NEW source revision)

The package ROOT selects `path.join(os.homedir(), '.pi-dstack-notify', 'config.json')` when `getFlag('notification-config')` is **undefined**. Only a valid absolute lexical override replaces it. Empty/relative/nonstring/erroring lookup stays unavailable, never falls back. Path is captured once after SDK flag binding, at session_start or first operation after binding. No startup filesystem lookup/provisioning occurs; subsequent binding cannot activate/reselect. Existing file bytes are read and fingerprint/lifetime checked during operations. Missing/disabled config produces no delivery, profile/key/ledger lookup or initialization. Plain `pi` repeats PACKAGE default selection—not persistent Pi extension-flag settings. No config/credential ENV selector or launcher is supplied.

Old public2539167 has no default/admin/JSON-Clef key. Its explicit `--notification-config` must be repeated per process; new interfaces below require this new source revision.

## Exact JSON

Minimal safe document: `{"version":1,"enabled":false,"projects":[]}` ([file](../examples/config.disabled.json)). Root requires version1, boolean enabled, projects array (<=128); permits only optional `clef_config_path` in the NEW revision. Duplicate/unknown JSON keys are rejected. Optional means absent, not null/empty. Project entries still require exactly:

| Key | Meaning |
| --- | --- |
| project_path | Existing canonical absolute directory, exact canonical host cwd/session-manager cwd match; no recursive subdirectory/role mapping. Duplicate roots rejected. |
| enabled | Boolean; both project and global enabled must be true. |
| profile_path | Canonical absolute private TOML; canonical parent exists, file checked when selected. |
| ledger_path | Canonical absolute path to existing validated storage; not a create-on-send target. |
| policy | `explicit_attention` permits validated v2/v3; `notification_product` requires v3 even for attention and is required for FYIP. |
| inbox_base_url | Pinned literal HTTPS base. No userinfo/query/fragment/percent/backslash/whitespace/control/non-ASCII; a path is permitted. Exact spelling must equal SEND/READ URL prefix before `#thread=<id>`. |

Disabled projects still undergo declaration/canonical-parent validation, without profile opening. Optional top-level clef_config_path must name a canonical absolute path with existing canonical parent. The private Clef file/key is opened only for admitted enabled production FYIP, never attention. JSON and constructor-only Clef paths both present is rejected as ambiguous before effects; there is no precedence/reselection. Old JSON without the key remains compatible with constructor-only test/integration seams. Closed-fake transport mode rejects a production selector; fake brands and both test-only identity restrictions stay intact.

Config/profile/Clef/key reads require canonical absolute normalized paths, no symlink components/leading //, backslash/control/DEL, <=4096 characters; regular current-UID-owned single-link files, owner-readable and no group/other permissions, <=65536 bytes, strict UTF-8. Typical private modes are directory0700/file0600. Ledger parent must be owner-rwx private; DB and existing WAL/SHM must be regular nonsymlink owned single-link owner-rw private files. No permission repair is performed.

## Telegram and Clef

Private profile uses only `[safety] telegram_enabled=true`, telegram_bot_token and telegram_chat_id, plus `[notification_profile] profile_id/destination_id`. Stable IDs follow lowercase dotted/hyphenated grammar and cannot use production-reserved test-only prefix. Token/chat validation remains strict; do not change identities to bypass history. [Disabled template](../examples/profile.disabled.toml) intentionally cannot publish: fill credentials privately only under separate authority. **No credential ENV names.** Existing production HTTPS POST to api.telegram.org uses the private Bot API token/chat; not an MCP sender.

Optional Clef JSON ([template](../examples/clef.template.json)) requires exactly version1/base_url/key_file/model/expected_model/timeout_seconds. base_url is an HTTPS **origin** (no trailing slash/path/userinfo/query/fragment). key_file is canonical private; key raw size1..4096, trimmed printable nonspace ASCII length12..4096. model/expected_model match full-string `[A-Za-z0-9_./:-]{1,200}`; timeout finite >0 and <=5 seconds. HTTPS POST is origin + `/v1/systemone`, Bearer key-file authorization. No Pi model-provider inference or credential ENV names. Configure only via new optional key; templates use reserved nonworking domains, not real endpoints.

Service resolves one Clef path per operation and rechecks that SAME path/key-byte fingerprint before classification and delivery. Key loss/rotation/config/profile/host drift aborts instead of borrowing/reclassifying decisions. Initially unavailable remains honestly labeled fallback_unavailable. Valid NO suppresses quietly; admitted unavailable/error/invalid/uncertain can be eligible labeled fallbacks—not guaranteed sends. Attention bypasses classification and reads no key.

## Shipped CLI and history

From an explicitly located NEW revision root with Node>=24, run `node ./pi-extension/admin.ts --help`; it is a real packaged file, not a global bin/Pi slash command. [README](../README.md) gives exact scaffold/validate/status/provision-fresh commands. Scaffold creates only disabled JSON exclusively and, at default only, its private package directory; alternate parents must already be safe. Existing/linked/symlink/noncanonical/unsafe files/directories are refused, never overwritten/repaired. No profile/key, enabled project or ledger is generated by scaffold/install/startup.

Validate is parser/private-config structural validation, not profile/transport readiness. Status uses existingDatabase(readOnly=true), strict schema/version and dispatch fence—not DeliveryLedger's WAL-mutating constructor. SQLite may create/touch WAL/SHM; no row/schema mutation, missing DB creation or readiness guarantee is intended. Structurally compatible v2/v3 can retain identity-specific unknown/unmapped holds; these are not corruption or universal policy changes. A matching identity may still be blocked. Disabled/mismatched fences, locks, partial/v1 layouts fail closed. No upgrade option is shipped.

Provision-fresh requires ALL literal switches `--dispatch-disabled --all-old-writers-quiesced --wal-consistent-backup-verified --no-prior-history`. These must ALREADY be externally true. The utility proves none, adds no witness/attestation, and missing DB/fence/sidecars is not history evidence. It refuses existing DB/WAL/SHM/fence/lock, calls existing initializeLedgerV3 exactly once and retains its normal active-fence publication. Externally disabled dispatch does not mean initialization produces a permanently disabled fence; scaffold remains disabled separately. Existing v2/v3: status only. V1/partial/prior-or-unknown history: no fresh provisioning, resetting, alternate path or implied migration recipe.

Exit0 means only requested administrative action completed; exit2 invalid args/missing assertions; exit1 held/ambiguous failure. Errors contain controlled code, no secrets/raw paths, `retry:false` and preserve-artifacts guidance. Any failure may leave a lock/partial state; preserve DB/WAL/SHM/fence/lock and stop. No auto retry, repair, initialization fallback, migration, upgrade, downgrade, restore, re-enable, deletion or overwrite. Unknown delivery/classification rows remain terminal across restart.

## Native contract and operational boundary

Fixed SEND/READ tool names and generated native argument keys are described in [BOUNDARIES](BOUNDARIES.md). Registration/reachesTools is not a grant, MCP server install or bypass. Publisher tools are model-only, sequential; native dependencies must be callable in ctx.tools under existing host permissions. Telegram/Clef are direct HTTPS, not nested tools. Existing canonical body/project/session/author/attachment/readback gates remain strict.

Retained sanitized authoritative source excerpts support the expected envelopes, but running-server source/version/path and deployed host wrapper argument/full-result mapping are **unestablished**. A package listing alone proves neither compatibility nor a missing shim. Source-derived fixtures are not production proof. No native calls/captures/probes are performed. OWNER decoding is not required for attention/FYIP. Setup completion, active-role grants/hotload, actual configured end-to-end delivery and recipient reachability are separate and unproven here. Treat operational receipts as potentially sensitive correlation metadata.
