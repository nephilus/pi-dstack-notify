# pi-dstack-notify private configuration — no activation by installation

This document describes the existing schema, not a provisioning/activation procedure. No real configuration/profile/credential/ledger files belong in the package. Do not commit private files, `.env`, state, logs or captured native envelopes.

## Configure once; persist state separately

`notification-config` is a string flag selecting an explicit canonical absolute configuration filename. The adapter resolves the flag once after host binding, at startup or the first explicit operation. It never discovers credentials from the environment, searches home directories for a destination or accepts one through tool arguments. Without a valid selected path it stays inert; rebinding does not silently activate it.

Persistent operator configuration lives outside the package and package caches. Enabled delivery is a separate operational authorization. The service revalidates configuration, selected project, private profile, ledger and canonical evidence across operation/lifetime boundaries. A config change is not authority to reuse a stale operation or resend an uncertain delivery.

## Schema-only disabled illustration

All paths below are **synthetic placeholders**, not paths observed on any host. They must not be created or used by copying this block. Even disabled project entries require existing canonical project directories and canonical private parent paths when actually loaded.

```json
{
  "version": 1,
  "enabled": false,
  "projects": [{
    "project_path": "/absolute/synthetic-example/project",
    "enabled": false,
    "profile_path": "/absolute/synthetic-example/private/profile.toml",
    "ledger_path": "/absolute/synthetic-example/private/delivery.sqlite",
    "policy": "notification_product",
    "inbox_base_url": "https://inbox.example.invalid/"
  }]
}
```

`explicit_attention` and `notification_product` are existing policy labels, not destination selectors. The latter participates in FYIP policy; neither enables unavailable ROOT Owner/reminder/poke tools. Future `pi-dstack-loop-tools` reminders may use notify delivery; its independently enabled bounded SAME-session continuation must not depend on this configuration, Inbox, Telegram or reminders. That extraction is not implemented. The Inbox base is pinned independently of model input. `api.telegram.org` is the fixed public vendor endpoint used by the existing transport, not a private URL to redact or substitute in runtime code. Test/example domains use reserved namespaces; source validation must preserve rejection cases for forbidden origins/userinfo/paths.

## Private profile schema (illustration only)

```toml
# SYNTHETIC SCHEMA ONLY: deliberately invalid credential placeholders.
[safety]
telegram_enabled = false
telegram_bot_token = "<SYNTHETIC_NONCREDENTIAL_PLACEHOLDER>"
telegram_chat_id = "<SYNTHETIC_NONDESTINATION_PLACEHOLDER>"

[notification_profile]
profile_id = "synthetic.example-profile"
destination_id = "synthetic.example-destination"
```

These values cannot validate for live delivery. Both stable identity fields are part of policy identity, not proof of approval or a real destination. Runtime `test-only.` branding is reserved for the core's closed test boundary and is rejected as a production profile prefix. Tests must verify both IDs and actual closed fake brands, not merely label a live-capable client as fake.

Private file checks require canonical nonsymlink spellings, regular owner-readable files owned by the current user, no group/other permissions, one hard link and bounded size. They do not provision directories, rotate credentials or make arbitrary files safe. Do not weaken them to make examples load.

## Ledger and continuity

An existing validated ledger is required for an enabled operation. Do not create, initialize, migrate, reset or substitute a ledger during package installation or ordinary publication. Administrative helpers in shared source are not automatic setup or rollback commands. Claims and unknown outcomes are durable; never delete them to force retries.

FYIP candidates are explicitly curated milestones/outcomes/material risks/plan changes. Admission/classification and labeled fallback semantics remain core-owned. This package does not grant model-provider selection or a background model loop. Configured service behavior, classifier endpoint/credential provisioning and production fallback policy require separate review; this package does not provision them.
