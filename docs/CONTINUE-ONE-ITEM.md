# CONTINUE: existing material, opaque archive, ONE current setup item

This successor of public1493 is source support, not operational acceptance. Installed1493 is inactive. Only the Installer may later use the reviewed release against authorized private files, stage configuration, register the ordinary-user runtime and perform the one genuine model-invoked acceptance. No activation/publication is performed by this document or by startup. Historical native/setup documents remain historical; this guide supersedes their fresh-only limitation.

## What is admitted

The Owner's current explicit authorization of **one genuinely new setup acceptance event** is positive origin evidence for that item. A private operator selects its exact text, key, revision, optional review link, actual caller session, canonical existing project and pinned Inbox base. That file is administrative authority, NOT a tool argument, timestamp, generated key, or general novelty claim. There is no model/API option to create/rearm/replace it. No repeated per-notification binding ceremony or authenticated producer is added: future generic novelty is simply not established by this bounded release.

The shared v3 ledger claim checks that complete intent and the exact selected profile bytes. Changed text/link/key/revision/purpose/project/session/base/profile fails `continuation_one_item_mismatch`. FYIP/owner/reminder/ambiguous old/future/reopened items have no current-item authority. Existing confirmed delivery suppresses; in-flight becomes terminal unknown; unknown never retries. Known opaque legacy exact-key fingerprints hold with `continuation_legacy_exact_key`, independent of new profile labels, revision or purpose. This is **not** universal semantic deduplication. A different spelling of an arbitrary old event cannot enter because it is not the one authorized intent.

## Private operator specification

Prepare one private, single-link, nonsymlink UTF-8 JSON file (maximum65536 bytes), with no duplicate/extra fields. Keep it and all bound inputs unchanged for the lifetime of this ledger. Every source/input parent and output parent must already be canonical, current-user-owned0700; files are private/current-user-owned and single-link. No directory, mode or ownership repair is provided.

Exact root fields:

| Field | Value |
|---|---|
| version | integer1 |
| origin | literal `owner-current-one-new-setup-acceptance` |
| current_request | private nonempty record of the actual current authorization, <=1024 characters |
| selected_source_commit | exact reviewed release's lowercase40-hex Git commit; verified externally by Installer, not inferred by CLI |
| env_path / env_sha256 | authorized existing credential file's canonical absolute path and expected exact-byte lowercase SHA256 |
| pair_sha256 | expected current-pair commitment: SHA256 of UTF-8 `pi-dstack-existing-env-pair-v1` + NUL + token + NUL + chat |
| legacy_path / legacy_sha256 | declared existing JSONv1 archive source and expected exact-byte SHA256 |
| profile_path | NEW private canonical profile output path; no preexisting TOML or pasted credentials required |
| profile_id / destination_id | stable prospective labels following existing profile grammar; not historical lineage or novelty |
| intent | exact object below |

`intent` has exactly `text`, `decision_key`, `revision`, `project_root`, `session_id`, `inbox_base_url`; optional `review_link` uses the existing `{label,url}` contract. Text/key/revision/link follow ordinary attention validation. Project is the actual canonical existing authorized cwd, not a managed worker or temporary staging directory. Session is the actual selected ordinary-user session. Inbox base is private operator input. Do not place real inputs, commitments, URLs, credentials or history in public fixtures, prompts, issue comments or command lines. The Installer privately computes/verifies commitments using the shipped helper's `parseLegacyEnv` and `legacyPairCommitment` functions, never shell evaluation or process-ENV fallback; do not print returned pairs.

The configured launcher's exact grammar is **two distinct literal assignments**, `TELEGRAM_BOT_TOKEN=...` and `TELEGRAM_CHAT_ID=...`, either order, optional final newline and Python universal-newline handling. No comments, blank lines, export, quotes, interpolation, trimming or shell parsing. Token follows the launcher's digit/colon/URL-safe grammar; chat is a positive decimal STRING. The existing stricter Core credential bounds must also hold. The helper creates a0600 TOML using those SAME strings, then rereads it with the existing profile loader and verifies equality. It never consults ambient credentials, rotates material or changes destination.

## Actual shipped command

From the explicitly verified release ROOT, with Node>=24:

```sh
node ./pi-extension/admin.ts adopt-one-current-intent \
  --ledger /absolute/private/delivery.sqlite \
  --spec /absolute/private/operator-spec.json \
  --dispatch-disabled --all-old-writers-quiesced --wal-consistent-backup-verified
```

The three declarations must already be externally true. They are **not proven by this utility**. It neither accepts nor passes `noPriorHistory:true`. Known prior history remains prior history; `provision-fresh` is unchanged and cannot be used instead. Do not launch old writers to inspect caches. Preserve the old unknown/volatile uncertainty rather than call it zero.

Under the SAME exclusive admin lock, before SQLite, adoption refuses DB/fence/sidecars (`-journal/-wal/-shm`) and output collisions; verifies source hashes, pair commitment, strict ENV and strict legacy `{version:1,requests:{sha256:{at:int,message_id:int}}}`; checks the selected key; creates the private profile and exact-byte `.opaque-json-v1.archive`; creates the SAME v3 schema with no invented old canonical tuples; and publishes a distinct `opaque-continuation` fence. It does not enable config, dispatch, contact a service or send anything.

Fence `adoption` metadata separately describes the opaque archive byte hash/count, current material/profile/spec bindings, destination hash and bounded intent digest. Existing `original_count=0` / empty identity digest STILL describe zero `legacy_unmapped` canonical associations, NOT zero prior history, old sends or archive rows. Archive rows remain unattributed. Historical exact canonical/project/profile/credential lineage is unproven; current pair equality does not prove it. MCP's old success-only60s/max256 process-local cache and old unknown attempts remain `unavailable`, not zero. No archive pruning, replay/reset, guessed mapping, destination-wide hold or second policy/ledger is introduced.

All claims/effect fence checks reread bound files and reject drift. Keep originals, generated profile, archive, spec and fence private. Dispatch retains canonical SEND association before full READ and existing abort/late/pending/secret/FYIP semantics. A failed READ can therefore leave a known canonical association plus terminal delivery uncertainty; do not call again to repair it.

On any creation/fsync/fence/SQLite/lock-release failure: nonzero, `retry:false`, preserve artifacts and STOP. Partial profile/archive/DB/fence/lock may exist, including a visibly active fence without proven durability. No cleanup, overwrite, automatic retry or alternate ledger is safe. A successful CLI exit means administrative completion only, not provenance/runtime/delivery acceptance. `validate` and `status` are diagnostic, not permission; status may create SQLite sidecars.

## Later runtime and native boundary

Installer alone binds the selected release ROOT, actual session/canonical cwd, package-owned config default, current private profile and ledger. The private spec persists the selected pin and caller intent before effects; the Core claim is the crash-durable single-attempt fence, not a transcript entry or volatile host allowance. No spec mutation/rearming after an ambiguous attempt.

The inherited strict Core accepts only bounded native SEND correlation and full READ verification. The declared existing native executable release0.28.30 reports MCP serverInfo1.0.0. SEND's required body plus generated project/session/host/name/idempotency fields and READ's message/thread/project/session/format-full fields are within the measured strict schemas; source handlers return SEND IDs/project/url and READ `{thread,url}` as expected. Full READ can mark native state. Pi1.5's built-in wrapper carries the complete native envelope at host `result.structuredContent`, minus `_meta`. No native call/startup/probe/shim/fallback is authorized by source tests.

Ordinary-host MCP selection, registrations, permissions, actual wrapper/after-hooks and real recipient acceptance remain Installer-owned. The two publishers remain model-only/sequential with fixed SEND/READ reach; they are not codemode/`ctx.executeTool` callable. Source offline SDK guards are in-process, not an OS sandbox. Synthetic admin tests really open temporary SQLite and spawn only guarded CLI children; those are separate from SDK zero-effect startup proof.
