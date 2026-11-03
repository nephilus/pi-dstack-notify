# Named Pi 1.5.0 built-in MCP contract (unpublished fd0-child)

This child is source/offline work, **unpublished and not installed**. The accepted installed public fd0 remains inactive. On the identified Pi1.5.0 built-in path, fd0 returns the wrong result layer; SEND may persist before strict decode rejects it and before canonical association. Configuration or ledger provisioning cannot fix that defect. No new pin/update, native call, model prompt, activation or ordinary-host acceptance is implied.

## Three layers, no fallback

The identified public `@earendil-works/pi-coding-agent`1.5.0 implementation:

- `dist/extensions/mcp/tools.js:203–217,255–266`: `createMcpToolDefinition` passes arguments to `client.callTool`; `convertMcpResult` returns host **W** with model-facing `content`/`details` and `structuredContent: R`, where **R** is the complete native CallToolResult **minus `_meta`**. Its own content/structuredContent/isError remain together, not flattened or parsed from prose. Model-facing text conversion/truncation is separate.
- `dist/core/extensions/runner.js:696–720`, `dist/core/agent-session.js:397–432,2863`, `dist/core/nested-tool-calls.js:102–174`, and public `@earendil-works/pi-agent-core`1.5.0 `dist/agent-loop.js:565–648`: `ctx.executeTool` returns **O** `{result:W,isError:boolean,...}` without unwrapping. Hooks may alter/drop structured content or errors.

The corrected adapter requires outer `O.isError===false`, an object host result, host `isError` absent/false only, and object `W.structuredContent`. It passes **that complete R** to unchanged Core. No direct-or-nested guessing, text/JSON parsing, guessed IDs, selector or runtime injection seam is added. Core independently rejects native error envelopes and malformed content/structured data.

Layout validation is **not registration provenance**. Actual deployed Inbox artifact/version, callable registration, after-hooks and wrapper identity remain unknown. Custom wrappers and other versions are outside this demonstrated support claim. Historical fd0 ROOT checks target Pi1.4.0, not this1.5 contract. Source-derived offline fixtures are not production captures.

## Fixed requests and unchanged canonical checks

SEND `mcp__plannotator_inbox__send_message` receives exactly body/idempotency_key/project_path/agent_session/agent_host=`pi`/agent_name=`Pi notification publisher`. READ `mcp__plannotator_inbox__read_thread` receives exactly message_id/thread_id/project_path/agent_session/format=`full`. Signal stays in host options. Names/reachesTools do not install a server, grant permissions or change publisher model-only exposure.

Native R must have nonempty text-only content and object structuredContent, native isError absent/false. SEND structured data must supply canonical message/thread IDs, project id/root, empty attachments and exact pinned URL. Full READ must independently contain matching thread/project/root and exactly one original message with the exact id/project/thread/body/agent host/session, no persisted attachments/inline images (omitted or empty, never null), and matching URL. Revision is a sole exact final body marker assertion, not a native event hash or approval. All native scalar strings, including ignored metadata, pass the secret gate. See unchanged `pi-extension/core/inbox.ts` and `core/safety.ts` for full validations.

Core stores validated SEND correlation **before** full READ verification. A failed READ retains that association and produces terminal uncertainty, never retry permission or authorization to reset keys/storage. Telegram remains gated on full verification, unchanged classification/admission/config/private-byte/host-lifetime checks and durable claims. Full native READ may mark checked/ack/tag-read state; it is not a side-effect-free probe.

## Argument normalization is not admission

Pi1.5.0 `pi-ai/dist/utils/validation.js:1–15,49–61` uses pi-schema with formats/coerce=true and clones raw arguments. Host-normalized values, not raw model JSON, reach the adapter. Optional null may disappear; scalar strings/booleans/arrays may be coerced. Host schema success does not imply safe body, semantic evidence, exact full-match identity/revision, literal HTTPS review link, secret safety, authority or delivery. Those gates remain explicit in adapter/Core, not TypeBox-only refinements/codecs/custom formats. Focused actual-validator offline records accompany this candidate separately. No exposure change is needed to test the model-only publisher schemas.
