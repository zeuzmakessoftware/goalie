# Operations: setup, commands, state, and metrics

[← README](../README.md)

This guide describes the v1 command surface and its operational boundaries. Examples use the development entrypoint:

```sh
pnpm dev <command>
```

After `pnpm build`, the equivalent packaged entrypoint is:

```sh
node dist/cli.js <command>
```

## Installation and preflight

```sh
pnpm install
pnpm check
pnpm dev doctor
```

`doctor` checks:

- Node.js 22 or newer;
- Git availability;
- optional local `codex` and `claude` installations;
- optional `OPENROUTER_API_KEY`;
- current workspace readability/writability;
- availability and initialization of the platform command-containment wrapper; and
- whether at least two provider families are available for a less-correlated critic.

Node, Git, workspace access, and command containment are required checks. A live match also needs the backends selected by its lineup or fallback chain. `doctor` does not execute a model call or certify remaining provider quota. On macOS it probes `/usr/bin/sandbox-exec`; on Linux it probes `bwrap`; unsupported, missing, or non-initializing containment fails the check.

## Configuration

Configuration is merged in this order, with later values winning:

1. built-in defaults;
2. global config at `$GOALIE_CONFIG_DIR/config.json`, `$XDG_CONFIG_HOME/goalie/config.json`, or `~/.config/goalie/config.json`;
3. project config at `<workspace>/.goalie/config.json`;
4. the `OPENROUTER_MODEL` environment override; and
5. CLI overrides.

Goalie never auto-loads `.env`. `--env-file FILE` explicitly loads one trusted dotenv file before configuration resolution, with `override: false`, so values already inherited from the shell win. Broker tools hide conventional `.env` names from model reads, but the explicitly selected file is still host/provider configuration; inspect it before use.

Durable data defaults to `$XDG_DATA_HOME/goalie` or `~/.local/share/goalie`. Set `GOALIE_DATA_DIR` to move it. Home-directory expansion is supported for the config/data environment variables.

Create the full project default:

```sh
pnpm dev init
```

Existing config is preserved unless `--force` is supplied. Because config defines executable commands, inspect it as trusted code. See [project configuration is executable policy](security.md#project-configuration-is-executable-policy).

Configured command `env` values are literal policy, displayed at kickoff and persisted in resolved session files. Do not put secrets there; keep provider credentials in the process/provider authentication environment.

Important configuration groups:

- `providers`: manager, builder, critic, integrator, and fallback order;
- `models`: OpenRouter model plus optional Codex/Claude model overrides;
- `budget`: minutes, turns, reported USD, concurrency, and plateau cycles;
- `commands`: exact executable/fixed argv/allowed dynamic args/cwd/timeouts/environment and check-vs-mutating classification;
- `protectedPaths`: additional path patterns;
- `playbooks`: exact SHA-256 candidate digests of already activated project playbooks to verify and propose at kickoff;
- `motion`: `full`, `reduced`, or `none`; and
- `allowDegradedCritic`: policy for the final audit when an independent backend is unavailable.

Concurrency is active but conservative. The scheduler admits only dependency-ready tasks with pairwise disjoint declared write sets, in deterministic priority order. `concurrency` is an upper bound, and the runtime caps a wave at three worker lanes even if configuration accepts a larger value. Dependencies, overlaps, task availability, and stop rules can reduce the actual width below that limit.

Git merging is host-owned. The configured `integrator` provider is dispatched only after all required lanes pass but the final combined artifact still fails a mandatory check or fresh audit. It gets worker-equivalent broker tools over the integration worktree, not Git authority. Each completed or provider-failed repair is host-checkpointed, hard checks are rerun, and a fresh auditor is selected with the repair provider treated as another builder family for independence. The loop stops on the global budget, the confirmed repeated-fingerprint plateau window, or unavailable configured/fallback providers.

Configured commands with `network: false` run inside an OS policy with egress denied. A trusted configuration can mark an exact command ID with `network: true`; only those IDs pass the broker's additional network gate. `run_approved(commandId, validatedArgs)` accepts optional arguments only when each value is present in the command's kickoff-frozen `allowedArgs`. There is no v1 runtime queue that can approve an unregistered executable, argument, destructive action, or ad hoc network request; those fail closed. Command containment requires `sandbox-exec` on macOS or `bwrap` on Linux. `doctor` probes it, and `run` repeats the availability check before repository validation, kickoff planning, or session creation. A failed preflight therefore cannot leave behind a nominal coding session.

Checks always receive a read-only worktree and private writable temp. Mutating commands receive only write sets the OS wrappers can represent without widening: `**`, an existing exact file, or an existing `path/**` subtree. Unsafe or ambiguous scopes fail closed before the executable starts.

## `run`

```sh
goalie run [goal]
  [--prompt-file FILE]
  [--env-file FILE]
  [--yes]
  [--headless]
  [--manager PROVIDER]
  [--builder PROVIDER]
  [--critic PROVIDER]
  [--max-minutes N]
  [--max-turns N]
  [--max-cost USD]
  [--concurrency N]
  [--no-motion]
```

`run` requires a clean Git source worktree. It discovers approved non-mutating package checks in the order `verify`, `typecheck`, `test`, and `build`; if none match, it falls back to the first configured command. The proposal shows friendly check IDs plus the exact fixed argv, configured environment, network/mutation flags, and manager-proposed task ownership.

Before confirmation, Goalie calls the selected manager with read-only broker tools to inspect the clean repository and propose a structured one-to-eight-task DAG. Each provider candidate gets one plan attempt and at most one structured-output repair. Availability/runtime/validation failure moves visibly through the configured fallback chain; if no candidate succeeds, the proposal uses one safe `**` lane. The kickoff review includes the resulting DAG, exact ownership/check assignment, resolved provider/model, and the successful planner's usage/plan-hash receipt.

This boundary sends the goal and any non-protected repository content the manager chooses to read to a provider, and can spend provider resources before the operator accepts the run. Failed planning candidates and a cancelled kickoff are not stored in a session ledger; only the accepted successful planner receipt is imported exactly once after confirmation. Review the selected manager/fallback policy before invoking `run`, and use provider-side spend controls, especially with `--yes`. Once confirmed, Goalie creates durable session metadata and per-task worktrees, then runs dependency-aware worker/critic waves. Passing lanes integrate in proposal order; each completed wave includes integration checks and a fresh audit. A non-passing final gate enters the bounded integration-repair/checkpoint/re-audit loop described above.

Use `--prompt-file` for multiline goals without shell quoting. It takes precedence over positional goal text. With neither, `run` reads piped stdin or errors on an interactive TTY.

`--headless` emits a non-interactive representation suitable for logs and CI. `--no-motion` selects text-only verdict labels with no ASCII-frame choreography; it does not remove verdict events. `GOALIE_REDUCED_MOTION=1` instead holds one static final frame.

## `resume`

```sh
goalie resume [session]
  [--env-file FILE]
  [--headless]
  [--max-minutes N]
  [--max-turns N]
  [--max-cost USD]
  [--no-motion]
```

Session IDs may be resolved by an unambiguous prefix. When the session argument is omitted, Goalie selects the newest catalog entry; use `goalie list` first and verify that target.

Resume verifies the hash chain, reconstructs reducer state, verifies/reuses the expected worktrees, and makes interrupted work eligible for a fresh attempt. It also reloads recorded coach steering and the latest non-passing critic gap for the next worker prompt. `achieved` and `safety_halt` are not resumable. A reviewed `user_stopped` or `failed` session can resume if its durable state and worktrees still satisfy the recovery checks. Budget flags are extensions/overrides applied at the resume boundary; prior turns, accounted wall time, reported cost, and usage telemetry remain durable.

The accepted specification contains a fingerprint of the resolved profile, provider/fallback lineup, models, command executables/arguments/environment/policy, protected paths, selected playbook digests, and degraded-critic rule. Resume recomputes that fingerprint from `resolved-config.json` and refuses a mismatch. Provider and concurrency flags are rejected on `resume`; explicit `--max-minutes`, `--max-turns`, and `--max-cost` values create a versioned budget amendment, while motion remains presentation-only. Goalie can record and expose provider session references, but the orchestrator does not currently feed them back into every resumed turn or guarantee native provider-context continuation.

Resume can stop for environmental reasons before a model is called:

- event-log corruption;
- an existing writer lease;
- missing/mismatched worktree or branch;
- an irreversible `achieved` or `safety_halt` status;
- dirty or conflicting Git state; or
- unavailable selected/fallback backends.

A hard process crash can leave `writer.lock`. On the next writer open, Goalie clears it only if the lock contains a numeric PID that the OS reports as absent and the file has not been replaced during recovery. Malformed, ambiguous, or apparently live leases remain blocked. Verify there is no running Goalie writer before any manual intervention; deleting a live lease can create two writers and invalidate durability guarantees.

## `list`

```sh
goalie list
```

Lists parseable session metadata, newest first. Partially-created or future-schema session directories are skipped rather than guessed at. Live runs durably refresh metadata on every session-status event, so the catalog follows active state; after an abrupt crash, the verified event-log reducer remains authoritative if the final event landed before its metadata mirror. Use the catalog as a selector and verify event-backed state before resume, export, landing, or cleanup.

## `replay`

```sh
goalie replay <session-or-bundle> [--speed N] [--headless]
```

Replay is presentation only. It reconstructs the broadcast from recorded events and does not run providers, tools, tests, or file mutations. `--speed` changes playback timing, not event content. Interactive TTY playback supports the same tab/pane navigation and motion or text-only preferences as the live broadcast; `--headless` prints a summary. A replay banner begins with one of these provenance meanings:

- `SIMULATED FIXTURE — NO ACTIVE AGENTS`
- `REPLAY — RECORDED LIVE RUN — NO ACTIVE AGENTS`
- `REPLAY — RECORDED LIVE RUN — NO ACTIVE AGENTS — EDITED`
- `REPLAY — DURABLE SESSION — NO ACTIVE AGENTS`

Bundle-backed banners then show either `AUTHENTICATED KEY <fingerprint-prefix>` after successful Ed25519 verification or `LEGACY UNSIGNED`. A durable-session replay is read directly from the local hash-chained event store rather than an export bundle, so it has neither suffix.

The replay library can label an unverified bundle, but the v1 CLI rejects an event-array or full-bundle digest mismatch, invalid event envelope, empty/non-`session.created` first event, broken event chain, or invalid present signature instead of rendering it. Live exports are Ed25519-signed; legacy/simulated bundles remain readable with a `LEGACY UNSIGNED` label. A valid signature proves continuity with its displayed install key, not human identity, time, or artifact truth. Do not use replay output as a substitute for rerunning checks on the artifact.

## `demo`

```sh
goalie demo [--headless]
goalie demo --live [--headless] [--crash-after-checkpoint]
```

Without `--live`, the demo replays an integrity-checked deterministic fixture bundle and must be labelled simulated. It is safe for rehearsing the TUI and provenance flow without provider spend. If the bundle is not installed, the CLI fails and suggests `--live`; it never upgrades silently. With `--live`, it creates the deliberately flawed Penalty Ledger repository, invokes the configured manager before the normal kickoff confirmation to produce the reviewable DAG, and invokes the remaining configured lineup only after acceptance. Cost, latency, and result quality are real and variable; pre-confirmation manager calls are real too.

`--crash-after-checkpoint` is meaningful only with `--live`. After the first lane checkpoint's Git commit and event are durably recorded, Goalie prints a declared fault-injection banner and sends itself an uncatchable `SIGKILL`. This intentionally leaves the session without a graceful terminal event and may leave a stale writer lease; `goalie resume <session>` clears that lease only after proving its PID is dead, verifies the event chain/Git state, and continues from the checkpoint. Use the flag only in a disposable demo run, expect the first command to exit by signal, and preserve the printed session ID.

See the complete [Penalty Ledger demo script](demo.md).

## `land`

```sh
goalie land <session> [--yes]
```

Landing is the explicit boundary between Goalie's durable integration artifact and the source repository. It requires an achieved session, a clean source still at the recorded base SHA, and an integration branch head matching both metadata and the durable checkpoint; the final merge is fast-forward-only. Review the diff and rerun trusted checks before confirming.

`--yes` bypasses the interactive landing prompt. It should be used only when automation has independently verified the target repository, base, session status, and integration commit.

Goalie does not publish a remote branch or open a pull request.

## `export`

```sh
goalie export <session> [--output FILE]
```

Creates a `goalie.replay.v1` JSON bundle with explicit provenance, a canonical event-array hash, a canonical full-bundle hash, declared artifact hashes, recorded events, and an Ed25519 signature. The first live export creates a per-install PKCS#8 key at `$GOALIE_DATA_DIR/keys/replay-signing-ed25519.pk8` (default `~/.local/share/goalie/keys/`); Goalie enforces a mode-`0700` key directory and mode-`0600` key file. The full-bundle hash covers every content field except itself and signature bytes, including provenance, artifact-hash declarations, and the signer descriptor. The signature covers a domain-separated canonical record containing that full bundle hash. Export derives backend-version entries from durable provider resolution/activity events; a value may explicitly say that the backend did not report a version. Export does not turn a simulated fixture into a live run. Live v1 writes `redaction: redacted` to describe its best-effort persistence pipeline, but the reader does not prove that arbitrary evidence is secret-free. Review the bundle before sharing.

Artifact hash fields are declarations in the bundle. The reader proves that those declarations have not changed relative to `bundleHash` and, for signed exports, the install-key signature, but it does not fetch or hash external artifact files. When the final SHA is valid, live v1 `artifactHashes.git-tree` is SHA-256 over `git ls-tree -r --full-tree -z <finalSha>`—a manifest of paths, modes, types, and Git object identities. Preserve the referenced Git commit so third parties can recalculate it and inspect the actual result. The self-generated key is not remotely anchored or identity-certified, and the signature provides no trusted timestamp. Back up the key if install continuity matters; copying it also copies signing authority.

## `gc`

```sh
goalie gc [session] [--yes]
```

Garbage collection is destructive session-data cleanup and requires confirmation unless `--yes` is supplied. The v1 CLI permits removal only for metadata statuses `achieved`, `failed`, `safety_halt`, or `user_stopped`; a merely `blocked` session remains resumable and is not eligible. With no session argument, it selects only `achieved` and `safety_halt` entries; `failed` or `user_stopped` cleanup requires an explicit session. Treat session worktrees, event logs, mutation journals, snapshots, and artifacts as one recovery unit.

Before cleanup, export anything needed for audit, confirm the source/integration result was landed or intentionally abandoned, and verify no live writer owns the session.

## `help` and `version`

```sh
goalie help
goalie version
goalie --help
goalie --version
```

The CLI help is authoritative for parser syntax in the checked-out version. These docs describe the v1 surface.

## Session data layout

With default storage, sessions live below `~/.local/share/goalie/sessions/<session-id>/`. A session can contain:

```text
resolved-config.json           resolved provider, budget, and command policy
gauntlet-spec.json             accepted proposal and task list
resolved-config.resume-*.json  versioned resume policy amendments
metadata.json                 catalog status and workspace identity
events.jsonl                 append-only hash-chained source of truth
snapshot.json                atomic checksummed reducer cache
writer.lock                  exclusive writer lease
<actor>-mutations.jsonl      fsynced structured-patch journal
artifacts/                   session/export artifacts
worktrees/<run>/<lane>/      integration and worker Git worktrees
```

Exact lane names are normalized and branches use `goalie/<run>/<lane>`. Data and directories are created with owner-oriented permissions where the platform supports them.

Do not edit event logs, snapshots, metadata, mutation journals, or worktree internals during a run. Replay verification can detect many edits, but not all hostile full-directory rewrites.

## Status interpretation

| Status | Meaning | Typical next action |
| --- | --- | --- |
| `created` / `planning` | Pre-execution state. | Inspect kickoff/runtime startup. |
| `running` | Writer is actively progressing or was interrupted before recording a pause. | Wait, stop, or carefully recover. |
| `achieved` | Required checks and final audit passed under the recorded contract. | Review and optionally `land`/`export`. |
| `paused_budget` | An inclusive configured limit was reached. | Inspect usage/evidence; extend deliberately or stop. |
| `paused_plateau` | The configured window repeated one failing criterion/verifier fingerprint without enough score or passed-criterion improvement. | Change evidence, goal assumptions, provider, or human guidance. |
| `paused_approval` | A host/operator decision is required. | Review the requested boundary. |
| `blocked` | The scheduler cannot proceed, or neither the configured integrator nor its confirmed fallback could complete a required final repair. | Inspect the reason and evidence before resuming. |
| `safety_halt` | A safety invariant stopped the run. | Do not auto-resume; investigate. |
| `user_stopped` | Operator ended the match with durable state preserved. | Export/inspect, resume after review, or clean it up. |
| `failed` | Runtime error ended the session. | Fix the cause, inspect artifact state, then resume or clean it up. |

“Achieved” means the configured gates passed; it is not a warranty that the software is correct, secure, deployable, or production-ready.

## Budget and cost semantics

Turn, active-wall-time, and reported-cost comparisons are inclusive. Runner turns are reserved before launch; tokens and cost come from backend completion usage, and no later wave starts after a resulting stop is observed.

For runner calls, the turn boundary is stricter than completion-time telemetry: the scheduler serializes an fsynced one-turn reservation with the max-turn check before the provider sees a request. Completion usage records zero additional turns, so parallel lanes cannot race above the durable runner-turn ceiling. The accepted kickoff-planning receipt is imported after session creation and can exhaust that ceiling before the first worker call. Planning attempts that failed before a fallback succeeded, and every call made before a cancelled kickoff, are not currently included in the durable total.

Wall time has an active deadline. Goalie records elapsed match time into durable `budget.wallTimeMs`, carries it across `resume`, arms a timer for the remaining allowance, and aborts the shared run signal when it expires. Backend adapters interrupt the in-flight provider turn; the host checkpoints every dirty lane before recording `paused_budget`. `Ctrl+C`, `P`, and a confirmed double-`Q` request the same graceful dirty-lane checkpoint path but end as `user_stopped`. Cancellation remains cooperative at the provider/runtime boundary.

Cost handling is intentionally conservative:

- `reportedCostUsd` sums only values a provider reported;
- a turn reservation is `pending`, neither reported `$0` nor unpriced;
- completion settles pricing as `reported` or `unknown`; missing cost is never converted to provider-reported zero;
- `costKnown=false` means some usage was unpriced;
- `unpricedUsageEvents` counts those gaps; and
- the live runner enforces the USD stop only while `costKnown=true`; once any usage is unpriced, it preserves the reported lower bound but does not claim that comparing it with the cap can contain actual spend.

Set provider-side spend limits as well. Goalie's reported-cost budget is telemetry and a stop rule, not a billing guarantee.

## Manual playbook lifecycle

The exported `goalie/playbooks` library can quarantine prose-only candidates, record externally produced matched baseline/candidate benchmark results, require a fresh cross-provider review, and activate an immutable hashed record after explicit confirmation. Those lifecycle steps are not CLI commands and are not called automatically by the orchestrator. Goalie v1 does not draft candidates, create held-out tasks, execute benchmarks/reviews, choose candidates, or automatically activate records.

An already activated project record can be reused by listing its 64-character candidate digest in configuration:

```json
{
  "playbooks": ["<candidate-sha256>"]
}
```

Kickoff loads `.goalie/playbooks/<candidate-sha256>.json`, verifies both its candidate content and activation-record digest, and fails before manager planning if the record is missing or altered. The confirmation review names each selected playbook, and its digest is part of the immutable execution-policy fingerprint. Goalie supplies only the verified prose procedure to the manager and builders as advisory context; it cannot widen their tools, commands, providers, write sets, or protected paths. Critics and integration auditors do not receive this guidance.

## Coding evaluator library

The exported `goalie/core` entrypoint includes `createCodingEvaluatorRegistry()` with versioned approved-command, test, build, typecheck, bounded Git-diff, artifact/file/tree hash, and golden-output evaluators. It uses the same typed evidence contract intended for future domains. In v1 this is a library API: the CLI automatically creates only approved-command checks and runs them through its broker path; there is no project-config selector for the other registry definitions yet.

## Metrics for a credible evaluation

For each run, capture:

| Metric | Why it matters |
| --- | --- |
| Final status and reason | Separates achieved, plateaued, budgeted, blocked, and runtime failure. |
| Required-check pass rate by attempt | Shows whether revisions improve objective behavior. |
| Critic score/direction by attempt | Shows the feedback trajectory; compare it with hard checks for calibration. |
| Turns and accounted active match time to first hard-check pass | Measures efficiency, not just success. |
| Input/output tokens and reported cost | Makes the economic tradeoff visible. Always report `costKnown`. |
| Checkpoint count and changed paths | Shows artifact progress and churn. |
| Wave count, maximum active lanes, and integration-audit result | Shows whether concurrency was safe and whether combined changes survived the gate. |
| Non-improving streak / plateau exit | Tests whether stopping rules prevent empty looping. |
| Provider fallbacks and critic independence | Surfaces degraded evaluation and backend instability. |
| Integration regressions | Detects worker success that does not survive merge. |
| Human interventions | Keeps “autonomous” claims honest. |

For comparisons, pin the fixture/base SHA, Goalie commit, provider/model identifiers, configuration, check commands, and replay provenance. Run multiple trials; one successful trajectory is a demonstration, not a reliability estimate.

Continue with the [demo script](demo.md) or [threat model](security.md).
