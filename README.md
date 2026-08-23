# Goalie CLI

> An evidence-driven, long-horizon coding gauntlet: manager, worker, critic, hard checks, durable state, and a terminal match broadcast.

Goalie turns one coding goal into a confirmed quality contract, then runs an iterative build–verify–critic loop in isolated Git worktrees. A positive critic trajectory scores a terminal **GOAL**; a negative one triggers a **SAVE** and another attempt; an uncertain verdict goes to **VAR**. The animation is the broadcast layer. Deterministic checks and the final artifact remain the source of truth.

Goalie is a v1 research prototype. It has a working H1 loop, an H2 durability substrate, and a conservative H3 playbook-promotion library. A run can consume explicitly selected, previously activated procedure guidance after verifying its content-addressed record and showing it at kickoff. Goalie does **not** autonomously draft, evaluate, review, select, or activate playbooks. It also does not provide a hardened OS sandbox or make a model verdict equivalent to proof. Read the [architecture](docs/architecture.md) and [threat model](docs/security.md) before using it on valuable repositories.

## What happens in a match

```text
goal
  → host proposal (goal + criteria + checks + budget + providers)
  → read-only manager planning (structured DAG; one repair attempt)
  → kickoff review (exact DAG + ownership + models + planning receipt)
  → explicit confirmation
  → dependency-ready, disjoint worker lanes run in bounded waves
  → per-lane deterministic checks + fresh, read-only critic verdict
  → retry failing lanes on their largest evidence gap
  → squash passing lanes into integration in proposal order
  → integration checks + fresh audit before each wave completes
  → if the final gate fails: bounded integrator repair → checkpoint → fresh audit
  → achieved, paused, blocked, or failed
```

Manager planning happens before confirmation so the operator can review the actual task DAG and ownership sets. These are real provider calls: the selected manager receives the goal and can inspect non-protected repository content before the confirmation prompt. Each attempted provider can consume one turn, or two if structured output needs its single repair attempt, even when the operator later cancels; fallback candidates can add more calls. The planner has read-only broker tools and cannot change the host-defined goal, criteria, checks, provider policy, or budget. If no configured manager returns a valid DAG, Goalie shows a yellow card and uses a safe single-lane proposal.

After confirmation, the kickoff contract is recorded as the first durable event and the accepted planner's receipt is imported into the session's turn/token/cost ledger exactly once. Calls made by rejected planning candidates, and every call made when kickoff is cancelled, currently remain outside the session ledger; provider-side limits are still required. Repository files, comments, and supplied references are treated as untrusted data, not as authority to change that contract. A failed required verifier cannot be waived by a critic.

## Quick start

Requirements:

- Node.js 22 or newer
- `pnpm`
- Git
- a clean Git worktree for `run`

Install and verify the project:

```sh
pnpm install
pnpm check
pnpm dev doctor
```

Run the integrity-checked simulated Penalty Ledger replay first. It does not contact a live model provider:

```sh
pnpm dev demo
```

The interactive presentation is paced across five minutes of active playback. Press `P` to pause at any point and `P` again to resume; paused time does not advance the match clock. Use `--speed 5` for a one-minute rehearsal.

For a machine-readable run without the TUI:

```sh
pnpm dev demo --headless
```

The default demo bundle is deliberately labelled **SIMULATED FIXTURE — NO ACTIVE AGENTS**. Live providers are opt-in with `demo --live` or an explicit `run` command. If the bundle is absent from a development checkout, the command fails explicitly instead of silently substituting a live run.

## Live providers are opt-in

Copy the example environment only for providers you intend to use:

```sh
cp .env.example .env
pnpm dev doctor --env-file .env
```

Goalie never loads `.env` implicitly. `--env-file FILE` explicitly loads a trusted dotenv file without overriding variables already inherited from the shell. Omit it when your provider CLI or process environment is already authenticated.

To run every role through one OpenRouter model—including the builder that edits the fixture—use:

```sh
pnpm dev demo --live --env-file .env --openrouter-only --openrouter-model deepseek/deepseek-v4-flash
```

Grok coding alternative:

```sh
pnpm dev demo --live --env-file .env --openrouter-only --openrouter-model x-ai/grok-code-fast-1
```

Replace the model slug with any current tool-capable OpenRouter model. `--openrouter-only` is deliberately disclosed at kickoff as `DEGRADED INDEPENDENCE`: fresh critic sessions are still used, but they share the builder's provider/model family.

- OpenRouter requires `OPENROUTER_API_KEY`.
- Codex uses the locally installed and authenticated `codex` CLI through its App Server protocol; `OPENAI_API_KEY` is optional when that installation uses API authentication.
- Claude uses the local Claude Agent SDK/CLI authentication; `ANTHROPIC_API_KEY` is optional when local authentication is already configured.

The generated v1 profile uses an OpenRouter manager, Codex builder/integrator, and Claude critic, with configured fallbacks. Git merging remains host-owned. The configured integrator is dispatched only when the final integrated artifact fails a mandatory check or fresh audit; it patches the integration worktree through the same broker, the host checkpoints the result, and a fresh auditor judges it again. Repeated identical failures stop at the confirmed plateau window, and all repairs remain budget-bound. Change the active lineup in `.goalie/config.json` or with provider flags. Provider independence may degrade when only one family is available; `goalie doctor` reports that condition.

From the Goalie checkout, point the development entrypoint at a clean target repository:

```sh
pnpm dev run --cwd /absolute/path/to/target \
  "Implement the requested behavior and prove it with focused tests"
```

After `pnpm build`, the equivalent from the target repository is `node /absolute/path/to/goalie/dist/cli.js run "…"`. A linked or installed package exposes the shorter `goalie run "…"` form used below.

Goalie calls the selected kickoff manager read-only, then prints the resolved goal, criteria, checks, task DAG, write ownership, exact commands/environment, provider/model lineup, fallback chain, budget, and planning receipt before asking for confirmation. `--yes` is intended for automation after that exact specification has been reviewed. It skips the prompt; it does not skip or make the pre-confirmation planning call free.

## Command surface (v1)

| Command | Purpose |
| --- | --- |
| `goalie run [goal]` | Propose, confirm, and run a gauntlet in the current Git repository. |
| `goalie resume [session]` | Verify durable state and continue a non-terminal session. |
| `goalie list` | List recorded sessions and statuses. |
| `goalie replay <session\|bundle>` | Play a recorded session or exported replay without active agents. |
| `goalie demo [--live]` | Replay the scripted Penalty Ledger fixture, or run it live; live mode can opt into a declared post-checkpoint crash. |
| `goalie doctor` | Check Node, Git, command containment, provider availability, workspace access, and critic independence. |
| `goalie init [--force]` | Write a project `.goalie/config.json`. |
| `goalie land <session>` | Explicitly bring an achieved integration result back to the source repository. |
| `goalie export <session>` | Export a provenance-labelled replay bundle. |
| `goalie gc [session]` | Confirm and remove eligible terminal session data. |
| `goalie help` / `goalie version` | Show CLI help or version. |

Important flags:

- global/provider setup: `--env-file FILE` explicitly loads a trusted dotenv file; it is never implicit
- `run`: `--prompt-file FILE`, `--yes`, `--headless`, `--manager`, `--builder`, `--critic`, `--max-minutes`, `--max-turns`, `--max-cost`, `--concurrency`, `--no-motion`
- `resume`: `--headless`, `--max-minutes`, `--max-turns`, `--max-cost`, `--no-motion` (provider and concurrency overrides are refused)
- `replay`: `--speed N`, `--headless`
- `demo`: `--live`, `--crash-after-checkpoint` (live only), `--headless`, `--yes`
- `export`: `--output FILE`

See [operations](docs/operations.md) for configuration precedence, storage, statuses, budget semantics, and command details.

## TUI controls

| Key | Action |
| --- | --- |
| `1`–`9` / `Option+1`–`9` | Jump to an agent tab. |
| `Tab` / `Shift+Tab` | Cycle agent tabs while not composing. |
| `Ctrl+N` / `Ctrl+P` | Cycle agents from anywhere. |
| `T` / `A` / `E` | Live feed / tactics / evidence panes. |
| `I` or `/` | Enter coach prompt mode in a live session; `Esc` leaves it. |
| `R` / `Ctrl+R` | Replay the last critic animation. |
| `P` | Pause/resume replay playback; gracefully checkpoint/stop a live session. |
| `?` | Toggle help. |
| `Q` twice within four seconds | Confirm a checkpointed live-session stop; one `Q` only arms the prompt. |
| `Ctrl+C` | Immediately request graceful checkpoint/cancellation, including while composing. |

The layout adapts from wide broadcast to a minimal scoreboard. `--no-motion` and `GOALIE_NO_ANIMATION=1` use text-only verdict labels; `GOALIE_REDUCED_MOTION=1` holds one static final frame. `NO_COLOR` and `GOALIE_ASCII=1` support no-color and ASCII-only terminals. Navigation works during interactive live sessions and replay/demo playback; `--headless` emits a non-interactive transcript.

## Evidence, durability, and safety

- Session events are append-only JSONL records with sequence numbers and a SHA-256 hash chain.
- Snapshots are checksummed atomic caches; the verified event log is the source of truth.
- Only one event writer can hold a session lease.
- The accepted execution policy is fingerprinted inside the hash-chained specification. Resume refuses a changed provider/model/command/environment/protected-path/playbook policy; only explicit budget amendments and display preferences are applied at that boundary.
- Worker changes happen on per-task, session-owned Git branches/worktrees outside the source repository. The scheduler runs at most three dependency-ready lanes concurrently, and only when their declared write sets are disjoint.
- Structured patches use caller-supplied operation IDs, content preconditions, atomic per-file replacement, and an fsynced mutation journal. Approved mutating commands do not yet have the same retry-stable operation identity and are not covered by the patch journal.
- Providers receive only the eight host-owned broker operations: `list_files`, `read_file`, `search`, `apply_patch`, `git_diff`, `run_check`, `run_approved`, and `report_progress`. Brokered file operations use lexical/realpath containment; structured patches and mutating commands enforce protected paths and actor write sets, with unrepresentable command scopes failing closed.
- Project checks/mutating commands are selected by kickoff-approved IDs and executed without a shell, with bounded time/output and fail-closed OS containment; the separate `git_diff` tool uses fixed host-owned argv.
- The exported `goalie/core` library includes a versioned evaluator registry for approved commands, tests, builds, type checks, bounded Git diffs, file/tree hashes, and golden-output comparisons. The CLI runner still routes its kickoff checks through the direct approved-command evaluator path in v1.
- Manager, critic, and auditor lanes cannot patch files or invoke mutating approved commands.
- Provider reasoning/thinking streams are discarded before the durable event boundary; the transcript keeps user-visible text, tool activity, and evidence rather than hidden chain-of-thought.
- Every event payload is recursively bounded, terminal-sanitized, and checked for common secret keys/patterns before persistence; redaction remains best-effort.

On macOS, approved commands require `sandbox-exec`; on Linux, they require Bubblewrap (`bwrap`). `doctor` probes that boundary, and coding runs with configured commands fail before session creation when it cannot initialize. Missing containment fails closed, and other platforms are unsupported for command execution in v1. The outer wrapper receives only a fixed locale and system `PATH`; the inner command receives a computed runtime `PATH`, private temp variables, and reviewed configured environment entries, with loader/runtime injection keys rejected. Sandboxed commands can still read the complete worktree plus selected runtime/system roots, while provider processes are outside this command sandbox and may inherit authentication context. This is not a hardened confidentiality boundary; see the full [safety model and limitations](docs/security.md).

## Honest demos and replays

Every exported replay declares whether it came from a `recorded_live` run or a `simulated_fixture`, whether it was edited, when it was recorded, a harness version and backend-version map, base/final SHAs, fixture name, and redaction state. Live exports derive reported or explicitly unresolved backend versions from durable provider events; the simulated fixture records its scripted backend version. Bundles carry both an event-array digest and a canonical full-bundle digest covering provenance, artifact-hash declarations, the event digest, and the events. Live export also signs that canonical record with a per-install Ed25519 key; legacy and simulated bundles remain readable but are visibly labelled unsigned.

A verified signed bundle has matching event and full-bundle digests, a valid non-empty session-event hash chain beginning with `session.created`, and a valid Ed25519 signature for its displayed key fingerprint. This authenticates continuity with that key only. It does not identify who controls the key, attest a timestamp, prove the original run was truthful, or independently verify artifact declarations. Replays never imply active agents.

Use the [Penalty Ledger demo script](docs/demo.md) for a judge-facing walkthrough and the [architecture notes](docs/architecture.md) for the H1/H2/H3 mapping and current limitations.

## Why Goalie

Goalie is inspired by the worker/critic orchestration and measurable visual gates documented in [Claude of Duty](https://github.com/mshumer/Claude-of-Duty). It is designed around the [AGI House long-horizon technical primer](https://blog.agihouse.org/posts/long-horizon-agents-a-technical-primer): progress over many coupled decisions, recovery across context boundaries, deterministic evidence, explicit stopping rules, and honest evaluation. Goalie was built for the [Long Horizon Agents Build Day](https://app.agihouse.org/events/long-horizon-agents-build-day).

## Documentation

- [Architecture and H1/H2/H3](docs/architecture.md)
- [Operations, commands, metrics, and resume](docs/operations.md)
- [Safety, provider containment, and threat model](docs/security.md)
- [Penalty Ledger demo and replay provenance](docs/demo.md)

## License

[MIT](LICENSE)
