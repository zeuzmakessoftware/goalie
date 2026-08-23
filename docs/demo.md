# Penalty Ledger demo: the judge-facing match script

[← README](../README.md)

The Penalty Ledger is a deliberately flawed TypeScript fixture that records penalty shots in append-only JSONL. Its small public API violates four protected behaviors:

1. a duplicate shot ID can be accepted more than once under concurrent writers;
2. a torn final append crashes replay; and
3. tied standings depend on insertion order instead of a deterministic tie-break; and
4. the CLI replay does not match its exact golden JSON output.

The two ordinary tests pass. Four protected verifier cases fail, for six cases total. That gap is the point: a plausible green test run is weaker than an explicit, adversarial success contract.

## Choose the provenance before the demo

### Deterministic rehearsal (recommended)

```sh
pnpm dev demo
```

This replays an integrity-checked scripted fixture bundle and must show:

```text
SIMULATED FIXTURE — NO ACTIVE AGENTS
```

It is reproducible, fast, and has no model spend. It demonstrates the harness, TUI, recorded checks, critic trajectory, and replay UX—not live model capability. If that bundle is absent from a development checkout, `demo` fails explicitly; it does not fall through to providers.

The default interactive replay is paced to five minutes of active presentation time. `P` toggles pause/resume and paused time does not advance the match clock. For a quick one-minute rehearsal, run `pnpm dev demo --speed 5`.

### Live gauntlet

```sh
pnpm dev doctor --env-file .env
pnpm dev demo --live --env-file .env
```

For a single-model OpenRouter demonstration using a current coding-capable model:

```sh
pnpm dev demo --live --env-file .env --openrouter-only --openrouter-model deepseek/deepseek-v4-flash
```

For Grok Build 0.1, substitute `--openrouter-model x-ai/grok-build-0.1`. This mode routes manager, builder, critic, and integrator through OpenRouter, disables cross-family fallback, and explicitly records the same-provider critic waiver as `DEGRADED INDEPENDENCE` at kickoff.

This invokes configured providers, so latency, usage, cost, patches, and verdicts are real and variable. Review the kickoff, provider availability, and exact check command first. Never describe a rehearsal capture as live.

The live command invokes the manager read-only *before* confirmation so the task DAG can be reviewed. Each provider candidate may use one planning turn plus one repair turn, and fallback attempts can add calls. A cancelled kickoff has no session ledger; only the successful accepted planner receipt is imported after confirmation. Treat this pre-confirmation work as real spend.

For a projector or CI transcript:

```sh
pnpm dev demo --headless
pnpm dev demo --live --headless --yes --env-file .env
```

The live headless form needs `--yes` because a non-TTY cannot answer the kickoff question. It still performs manager planning and prints the resolved kickoff before starting; use it only after that exact fixture policy and provider lineup have been reviewed.

Goalie does not auto-load `.env`; the examples pass an explicit trusted file. Omit `--env-file` when authentication is already inherited from the shell/provider CLI.

### Genuine crash/resume capture

For a declared, real fault after durable artifact state exists:

```sh
pnpm dev demo --live --crash-after-checkpoint --headless --yes --env-file .env
# note the printed session ID; the process exits by SIGKILL
pnpm dev resume <session-id> --headless --env-file .env
```

The fault flag is demo-live-only. It waits until the first lane checkpoint's Git commit and hash-chained event are fsynced, prints `DECLARED FAULT INJECTION`, then sends the Goalie process `SIGKILL`. The first command is expected to exit by signal and cannot record a graceful terminal status. Resume proves the recorded PID is dead before clearing its stale lease, verifies the event/Git state, and continues from durable facts. Run this in a disposable rehearsal; it is intentionally disruptive.

## What the fixture proves

The baseline implementation does this:

```text
record(shot)
  → replay the whole file
  → reject if the ID already exists
  → append one JSON line
```

Two callers can both replay before either append, so both accept the same ID. Replay parses every non-empty line, including a torn final line. Standings sort only by goals, so ties inherit map insertion order.

The shallow suite covers a single record/replay and a sequential duplicate. The protected suite adds 24 concurrent writers, a deliberately torn final record, a deterministic tied ranking, and exact golden CLI output. In the broken fixture:

```sh
node --experimental-strip-types --test tests/ledger.test.ts
# passes 2

node --experimental-strip-types --test tests/ledger.test.ts verifiers/crash-and-concurrency.test.ts
# the 4 protected cases fail; with the 2 shallow cases, 6 cases run in total
```

The exact repair is intentionally left to the worker. A credible solution must preserve the public API and pass all protected behavior, not merely edit expectations or skip the verifier.

## Five-minute walkthrough

### 0:00 — Open with the claim

Say:

> “Goalie is not one giant prompt. It is a host-owned improvement loop: immutable goal, isolated artifacts, deterministic evidence, fresh critics, exact stop rules, and resumable state.”

Show `goalie doctor`. Point out the required command-containment result, which providers are available, and whether the critic is independent. For the scripted demo, explicitly say that no provider is active.

### 0:35 — Show the false green

Open the fixture README and the two shallow tests. Run or cite the shallow suite. Then show the protected verifier names without revealing implementation details to a live worker if they are installed under `.goalie/verifiers`.

Say:

> “The easy test is green, but the goal is not achieved. The kickoff contract includes the verifier that represents the real behavior.”

### 1:05 — Enter the goal and kick off

Run:

```sh
pnpm dev demo
```

On a live run, pause on the kickoff review. Call out:

- exact immutable goal;
- correctness, intent, and scope criteria;
- mandatory `verify` check;
- manager-proposed task DAG, dependencies, and write ownership;
- provider/model lineup, manager planning receipt, and any fallback/degraded-independence warning;
- exact approved commands and configured environment;
- wall-time, turn, reported-cost, concurrency, and plateau limits; and
- the rule that repository/reference content is untrusted.

Only then confirm.

Type this into the editable TUI prompt:

> Repair the Penalty Ledger so shot ingestion is exactly-once and replay is crash-safe and deterministic.

Press Enter. The standard demo is a clearly labelled recorded fixture; do not call it a live provider run.

### 1:30 — Tour the broadcast and pause it

On an interactive TUI—including the default replay—use the visible controls:

- `1`–`9` or `Tab` to move between manager, worker, critic, integrator, and evidence tabs;
- `T` for the live feed;
- `A` for the current tactic/agent progress;
- `E` for deterministic evidence; and
- `?` for the shortcut sheet.

Press `P` once and point to `PAUSED // HALFTIME`; the match clock stops. Explain that replay pause is presentation-only and does not mutate evidence. Press `P` again to resume.

`Ctrl+C` exits the recorded presentation immediately. In replay mode, `Q` exits with one press; in a live session, the first `Q` arms a safe stop and a second `Q` within four seconds confirms it. Do not press either until you are ready to leave.

Explain that tabs are role/lane views. The scheduler can run at most three dependency-ready worker lanes together, and only when their declared write sets are disjoint; manager, critic, auditor, integrator, and evidence tabs do not imply five simultaneous writers. Replay navigation changes only the presentation of recorded state; it never wakes an agent or mutates the artifact.

The focused transcript contains provider-visible answers, broker activity, diffs, and verifier evidence. Provider reasoning/thinking streams are discarded before persistence and are never presented as hidden chain-of-thought.

### 2:20 — Let the critic make a save

When a required check fails, the host records evidence and forces the normalized verdict to fail even if model text is optimistic. A negative trajectory plays the goalkeeper **SAVE** animation and identifies one largest blocking gap for the next attempt.

Point out:

- the check output and evidence ID;
- critic score and per-criterion statuses;
- attempt number;
- latest blocking gap; and
- non-improving/plateau behavior.

The soccer animation is a compact trajectory signal, not an evaluation in itself.

### 3:10 — Show the repair, then the goal near 4:00

A positive lane critic verdict plays **GOAL**, but the match is not yet landed. After the wave settles, the host squash-integrates passing lanes in proposal order, reruns hard checks on the combined integration artifact, and requests a fresh audit before recording the wave complete. If that final gate fails, the configured integrator gets one blocking gap, repairs through the same broker, and the host checkpoints and re-audits; repeated identical failures or budget exhaustion pause the loop.

Say:

> “A worker goal advances the ball. `achieved` requires the integration checks and final audit; landing remains a separate human boundary.”

### 4:15 — Finish on durability and provenance

This section applies to `demo --live`. The default `demo` is already replaying an exported simulated bundle; it does not create a new session-catalog entry and therefore cannot be resumed or exported again by session ID.

For a live run, use a second terminal if time permits:

```sh
pnpm dev list
pnpm dev replay <session-id>
```

Call out the session ID, event-backed status, event count/sequence, checkpoint, usage, and stop reason. Explain that live runs update catalog metadata on each session-status event, the JSONL chain is authoritative if a crash interrupts that mirror, and the snapshot is only a cache. If demonstrating resume, stop at a non-terminal boundary and use:

```sh
pnpm dev resume <session-id>
```

The scripted fixture includes a declared `session.restarted` event so the default replay can explain H2 mechanics, but it is not evidence of a live process kill. For that evidence, use the opt-in `demo --live --crash-after-checkpoint` flow above and preserve its real event/session artifacts. A hard kill leaves no graceful terminal event and can leave a writer lease; Goalie clears a recorded lease only when its PID is provably dead, while ambiguous ownership still requires operator inspection. Wall expiry and graceful user interruption checkpoint dirty lanes before recording their paused/stopped status.

### Post-demo audit — Export honestly

This section also applies to a completed live session. The default simulated demo bundle already carries its own provenance.

```sh
pnpm dev export <session-id> --output penalty-ledger-replay.json
pnpm dev replay penalty-ledger-replay.json
```

Read the provenance banner aloud. For a live run it should say recorded live and no active agents; for the default demo it must say simulated fixture. Inspect the bundle provenance to disclose its editing and redaction declarations. The live v1 `redacted` value describes the best-effort persistence pipeline; it is not a verified guarantee that arbitrary evidence contains no secrets.

End with the integration diff and verifier result, not with the animation.

## What the provenance labels mean

A `goalie.replay.v1` bundle records:

| Field | Meaning |
| --- | --- |
| `source` | `recorded_live` or `simulated_fixture` |
| `edited` | Whether the presented trace was modified after capture |
| `recordedAt` | Declared trace timestamp; live v1 uses the session metadata update time, not export wall-clock time |
| `harnessVersion` | Goalie version used for the export |
| `backendVersions` | Declared backend/runtime versions derived from durable provider events; values can be explicitly unreported |
| `baseSha` / `finalSha` | Git identities declared for the artifact trajectory |
| `redaction` | Declared `redacted` or `unredacted` state; not independently verified by the reader |
| `fixture` | Named scenario, here `penalty-ledger` |
| `eventLogHash` | Canonical SHA-256 digest of the bundled event array |
| `bundleHash` | Canonical SHA-256 digest of all bundle content except this field, including provenance and artifact-hash declarations |
| `artifactHashes` | Declared digests; live v1 `git-tree` hashes Git's recursive tree manifest at `finalSha` |
| `signature` | Optional Ed25519 algorithm, public key, SHA-256 key fingerprint, and signature; live exports include it, while legacy/simulated fixtures may be unsigned |

For signed bundles, `bundleHash` also covers the signing algorithm, public key, and fingerprint, but not the signature bytes. The signature covers a domain-separated canonical payload containing the complete unsigned bundle including `bundleHash` plus that signer descriptor. The reader recalculates `eventLogHash` and `bundleHash`, parses every event envelope, requires the non-empty event chain to begin with `session.created`, verifies that chain, and authenticates any present signature. The v1 CLI rejects a failed integrity or signature check before rendering it; valid unsigned legacy/simulated bundles render with `LEGACY UNSIGNED`.

This verification is deliberately narrow:

- it proves only that the bundle fields/events match their recorded digests and the event array is an internally valid chain;
- a valid signature proves possession of the matching install key, not the human or organization controlling it;
- it does not independently fetch or verify external artifacts;
- it does not prove that a `recorded_live` label is truthful against a remote witness; and
- it does not provide a trusted timestamp or remote attestation; and
- it does not rerun checks.

Keep the source repository, base/final commits, config, and check commands when a third party needs a reproducible audit.

## Metrics to put on the final slide

Report a table like this for every live trial:

| Metric | Trial value |
| --- | --- |
| Goalie commit / fixture base SHA | … |
| Provider and model per role | … |
| Critic provider independent from builder? | yes / no / degraded |
| Final status and reason | … |
| Attempts to first protected-verifier pass | … |
| Required checks passed / total | … |
| Critic scores by attempt | … |
| Turns | … |
| Accounted active match wall time | … |
| Input / output tokens | … |
| Reported cost | `$…` or “partially unknown” |
| Unpriced usage events | … |
| Checkpoints / files changed | … |
| Scheduling waves / maximum active lanes | … |
| Integration repair turns / final audit count | … |
| Human interventions | … |
| Declared fault injection / successful resume | yes / no / not run |
| Integration regression? | yes / no |

Run multiple live trials from the same base commit. Report the success distribution and failure categories. The scripted demo is one deterministic product walkthrough and should not be included as a live-agent success sample.

## Expected questions and straight answers

**“Is this actually self-improving?”**

Within a session, yes in the bounded H1 sense: each attempt is followed by deterministic evidence and the next attempt receives the latest critic gap. Resume restores that gap and recorded coach steering alongside the artifact. Across projects, Goalie has a manual H3 promotion substrate for externally drafted procedure guidance, externally produced matched-benchmark results, independent review, and explicit activation. A later run can explicitly select a verified activated digest and supply its prose-only guidance to the manager and builders. Goalie does not itself draft playbooks, create or run the held-out evaluations, review, choose, or activate candidates, so it is not a continuous or autonomous learning loop.

**“Are those agents all running in parallel?”**

Not indiscriminately. A deterministic wave can contain at most three dependency-ready worker lanes with disjoint declared write sets. Dependencies and overlaps serialize later work; passing lanes integrate in proposal order, then the host runs full integration checks and a fresh audit before the wave is complete. Manager, critic, and auditor phases remain read-only. The integrator is a separate mutation phase invoked only for a non-passing final gate, and its output is always checkpointed and independently re-audited.

**“Does the replay prove the demo happened?”**

A signed live export proves that its canonical bundle was signed by the private key matching the displayed install-key fingerprint and has not changed since. It is not a human identity certificate, remote attestation, trusted timestamp, or proof that a provenance or artifact declaration is honest. Compare the fingerprint through a separately trusted channel when continuity matters.

**“Is the provider sandbox safe for hostile repositories?”**

Goalie narrows provider tools and paths, and configured commands fail closed into macOS `sandbox-exec` or Linux Bubblewrap with network denied by default. Checks see the worktree read-only; mutating commands receive only a representable assigned write scope. Commands can still read the entire worktree and selected runtime/system roots, use private temp, and provider runtimes sit outside the command sandbox. Use a disposable VM/container for hostile or confidential code.

**“Why a separate critic?”**

It reduces builder self-grading and focuses revision on one evidence gap. It is still probabilistic, so required deterministic checks override it.

**“Why soccer?”**

Long sessions need legible progress. GOAL/SAVE/VAR makes critic direction visible at a glance while the evidence pane preserves the serious record.

## Demo failure recovery

- **No provider available:** use the scripted demo and label it; do not fake a live run.
- **Only one provider family:** disclose the degraded critic and show the doctor warning.
- **Unknown USD cost:** report the known lower bound and `costKnown=false`; never print `$0` as if it were exact.
- **Cancelled kickoff:** disclose that pre-confirmation manager/fallback calls may already have consumed provider resources even though no session was created.
- **Terminal too small or animations distracting:** add `--no-motion` or set `GOALIE_NO_ANIMATION=1` for text-only verdicts, use `GOALIE_REDUCED_MOTION=1` for a static final frame, or add `--headless` for a non-interactive transcript. `GOALIE_ASCII=1` changes glyph compatibility, not motion.
- **Live run plateaus:** show the repeated gap and stop rule. A correctly detected plateau is a meaningful harness outcome.
- **Integration repair pauses or blocks:** show the worker-vs-integration distinction, the repeated fingerprint/budget/provider stop, and the latest fresh audit. Do not relabel the session achieved.
- **Replay hash mismatch:** the v1 CLI rejects an event, full-bundle, or event-chain mismatch before rendering. Preserve the original export, investigate the mismatch, and never suppress it for a presentation.

For the mechanics behind the demo, read [architecture](architecture.md). For claims you should not make, read the [security model](security.md).
