# pi-dstack-notify synthetic example and test-data rules

No real credentials, chat destinations, user configuration, private hostnames/paths, state/logs or copied private native envelopes belong in pi-dstack-notify. The same future review requirement applies to pi-dstack-loop-tools; no loop implementation is exported here. These documentation examples are deliberately nonfunctional. They do not create a runtime profile, provision a destination or make a send.

Use `example.com`, `example.org`, `example.net` and reserved `.invalid`/`.test` namespaces for illustrative URLs. Illustrations below use `https://inbox.example.invalid/`. Loopback and malformed URL examples may be retained only as clearly synthetic negative tests with the exact rejection property preserved.

Schema illustration (not evidence of any native result):

```text
fixture_brand: SYNTHETIC_ONLY_DOCUMENTATION_NOT_NATIVE_EVIDENCE
profile_id: synthetic.example-profile
destination_id: synthetic.example-destination
session_id: synthetic-session
message_id: <GENERATED_SYNTHETIC_MESSAGE_ID>
thread_id: <GENERATED_SYNTHETIC_THREAD_ID>
url: https://inbox.example.invalid/#thread=<GENERATED_SYNTHETIC_THREAD_ID>
```

These placeholders intentionally are not canonical native IDs. Do not feed them into a production tool or weaken validation to accept them. Executable tests need structurally valid **fresh synthetic** IDs generated in the test harness, both stable identity fields and the real core's closed fake-client brand. Changing labels on an unbranded/live client is not sufficient. Preserve mismatched-ID, stale lifetime, wrong canonical target, foreign origin, malformed credential, cancellation and uncertain-outcome assertions.

Token-shaped source fixture strings are not automatically proven real secrets. Documented synthetic constants, regex declarations, type fields, timestamp limits, GitHub credential expression names and URL-userinfo rejection inputs must be distinguished from actual embedded credentials. Still regenerate potentially confusing retained fixture values consistently, without printing their old bytes, and retain exact policy/negative-case semantics.

Public vendor API endpoints required by runtime behavior are a separate category: `api.telegram.org` is not a private destination or an example domain. Preserve that transport contract rather than silently rewriting policy. Unicode standards/source URLs are attribution references, not permission to fetch or distribute data before licensing is resolved.
