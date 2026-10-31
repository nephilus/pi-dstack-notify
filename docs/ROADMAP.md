# pi-dstack-loop-tools roadmap — no extraction implemented

Settled products/repos are exactly **pi-dstack-notify** and **pi-dstack-loop-tools**. Notify is first-release export scope: attention/FYIP plus canonical Inbox/Telegram delivery, classification and dedupe ONLY, without automatic reminder/poke controllers. Neither product is a general scheduler, arbitrary cron service, ownership coordinator or permission engine. There is no third product/repository proposal.

Future loop-tools groups two **independently enabled** capabilities:

- **Reminders:** durable pending OWNER/hourly/snooze/answer behavior; may use notify as a delivery provider under a separately reviewed trusted contract.
- **Bounded SAME-session continuation:** advisory poke independent of Inbox, Telegram and reminders. Optional coinstalled coordination must not create mandatory notification configuration, reminder READY or load-order dependencies.

The complete existing loop implementation remains preserved in the original source. Shared code and internal regression tests are not independent packaging or operational acceptance. No loop split/refactor/provider implementation is part of the current notify export work.

Actual extraction is more than registration or new names: service composition, shared busy/lifetime gates, original canonical enrollment, same-transaction claim/reservation/capacity, durable controls/occurrences, strict v3 DDL/marker/fences and delivery confirmation are coupled. Retain one policy and authoritative storage semantics; do not silently add a second ledger or transfer OWNER authority to a caller. Actual production OWNER decoding is currently unsupported. Supporting it is a separate trust/semantic change, not a switch unlocked by packaging.

Potential future reminders remain constrained by persisted original identity, verified supported answers, snooze controls, per-slot durable once-only admission, lifecycle/scope fences and uncertainty holds. Advisory continuation must never override a real wait, owner decision, delegation, completion or absence of authority. No automatic request manufactures permission to call a tool, retry a send or take over work.

Default notify ROOT packaging must expose only the two accepted tools unless a later release explicitly changes that contract. Do not enable a hidden FULL inner manifest as a shortcut. Future loop-tools work is not a prerequisite to shipping separately validated notify scope. The notify metadata request returned HTTP 404 (no accessible repository, not guaranteed availability); the loop-tools name remains unqueried. No repository creation follows from this roadmap.
