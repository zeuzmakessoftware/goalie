# Penalty Ledger

This deliberately flawed fixture records penalty shots in an append-only JSONL
ledger. Repair it so duplicate shot IDs are accepted exactly once under
concurrency, a truncated final record is recoverable after a crash, and replayed
rankings plus CLI output remain deterministic.

The two ordinary tests are intentionally shallow. Goalie's protected verifier
adds four cases—concurrent exactly-once ingestion, torn-record recovery,
deterministic tied rankings, and exact golden CLI output—for six cases total.
Those protected cases are the match officials.
