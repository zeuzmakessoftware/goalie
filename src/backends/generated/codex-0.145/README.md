# Pinned Codex App Server protocol subset

These types were generated with:

```text
codex-cli 0.145.0
codex app-server generate-ts --experimental --out <directory>
```

Goalie pins only the initialization capability and messages in its fail-closed
allowlist rather than shipping the entire generated protocol surface. Runtime
Zod validation remains authoritative.
When the local server adds a message, update this snapshot and its validator in a
reviewed change; unknown requests and notifications continue to terminate the
adapter.
