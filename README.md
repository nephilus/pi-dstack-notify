# pi-dstack-notify

> Release candidate: independent privacy/package/code/provenance review is required before publication. This package is inert without explicitly selected private configuration.

Deliberate attention and curated FYIP notifications for Pi, backed by one shared TypeScript notification core and its existing fail-closed policy. Settled product scope is exactly **pi-dstack-notify** and future **pi-dstack-loop-tools**, not three packages. Neither is a general scheduler. Notify has no automatic reminder/poke controllers. Future loop-tools groups reminders and bounded SAME-session continuation as independently enabled capabilities: reminders may use notify delivery; continuation must not require Inbox, Telegram or reminders. No loop extraction is implemented here.

## Default package scope

The ROOT Pi manifest selects only `./pi-extension/minimal.ts`:

| Route | Default ROOT package |
| --- | --- |
| `notification_publish` | Deliberate explicit-attention submission |
| `notification_publish_fyip` | Explicit curated FYIP candidate submission |
| OWNER requests | Unavailable |
| Reminder ticks/automatic reminders | Unavailable |
| Advisory poke/automatic continuation | Unavailable |

Both exposed tools are model-only and sequential. Their fixed native reach is `mcp__plannotator_inbox__send_message` and `mcp__plannotator_inbox__read_thread`. Tool registration is not permission to deliver, approve decisions, schedule work, retry uncertain sends or wake an agent. The normal MCP host must provide the native operations when separately authorized; this package does not install a native Inbox provider.

Shared Owner/reminder/poke modules remain only where the minimal entry imports their shared factory/types/core. The ROOT entry does not construct their controllers, start their timers, register their tools or install a model automation route. Regression tests of internal shared code do not make those routes public features. No inner FULL activation manifest is included.

## Inert by default; persistent private configuration

With no `notification-config` flag, startup remains inert: no notification service, private profile/ledger or delivery is needed. The string flag must name an explicit canonical absolute private configuration path. The adapter resolves its flag once, after host binding at startup or the first explicit operation. Missing, relative, non-string or unreadable flag access stays disabled for that adapter instance; later rebinding is not an activation mechanism. Restart deliberately after changing configuration selection.

An explicitly configured operation still requires enabled matching project policy, a private profile, an existing validated ledger and exact native evidence. Configuration is persistent operator-owned data outside the package—not an environment fallback, destination passed by the model or disposable install artifact. See [configuration](docs/CONFIGURATION.md) and [boundaries](docs/BOUNDARIES.md). The documentation samples are synthetic and intentionally do not provision a working destination.

## Compatibility and evidence status

| Component | Declared baseline | Final sanitized export measurement |
| --- | --- | --- |
| Node.js | `>=24.0.0`, builtin `node:sqlite` required | 24.22.1 (isolated offline validation) |
| Pi | Host peer; planned validation against public SDK 1.4.0 | 1.4.0 (public SDK, package-root load) |
| TypeBox | Host `typebox` peer | 1.3.27 (real host module) |

Final-candidate offline validation uses TypeScript 5.8.3, strict whole-source no-emit checks, unit and actual-entry/core tests with closed fakes, and an isolated actual SDK **package-ROOT** no-send load/start/shutdown/dispose measurement. Exact final-byte hashes, commands, test counts and runtime inputs are recorded in the external candidate packet. This is producer evidence, not independent clearance. No CLI/Git-install, configured delivery, network, live Inbox/Telegram or operational continuity proof is claimed.

## Distribution proposal—not installation instructions for a published package

Settled repository names: `pi-dstack-notify` and `pi-dstack-loop-tools`; notify is the first export, loop-tools remains future scope. A bounded authenticated metadata request for `nephilus/pi-dstack-notify` at 2026-10-31T20:40:47Z returned HTTP 404: no accessible repository was found, **not guaranteed name availability**. Actual owner, visibility, size and emptiness remain unknown. No loop repository was queried. No repository creation or upload was performed by this export task.

See the conditional [installation instructions](docs/INSTALLATION.md). Only a new sanitized **single parentless** publication history may be proposed, to the exact reviewed destination after independent clearance. Original ancestry must never be uploaded. Optional user installation is separate and **not a prerequisite to shipping**. Shipping, configuration/activation and legacy continuity are distinct decisions.

## Roadmap and attribution

[Loop-tools roadmap](docs/ROADMAP.md) describes independently enabled reminder/continuation capabilities in the settled second product, not a general scheduler. Required MIT attribution is preserved verbatim in `LICENSE`; the legal notice is not rebranded. Unicode-derived mapping and approved-age data retain their original attribution and the complete applicable Unicode License v3 notice in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). See [provenance](docs/PROVENANCE.md).
