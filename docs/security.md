# Security model and provider containment

[← README](../README.md)

Goalie runs untrusted model output against a real codebase. Its design reduces authority, records mutations, separates production of a patch from acceptance, and places approved commands inside a fail-closed OS policy. That policy is useful integrity and egress containment; it is **not** a hardened confidentiality sandbox or a substitute for a disposable machine.

## Security goals

Goalie attempts to preserve these invariants:

1. The host-owned goal, quality criteria, required checks, provider/command/playbook policy, budget, and workspace remain the authority; a manager may propose only the task DAG that the user then confirms.
2. Repository and reference content cannot grant tools or expand scope merely by instructing a model to do so.
3. A provider can access the workspace only through host-owned broker tools.
4. Worker patches and mutating commands stay inside an assigned worktree/write set. A final-gate integrator gets the integration worktree's protected `**` scope only for a recorded repair; manager, critic, and auditor roles receive no patch or mutating-command tool.
5. Project checks/mutating commands require exact configured IDs and no shell interpolation; the built-in diff tool has fixed host-owned argv.
6. Deterministic verifier failure cannot be reinterpreted as success by an agent.
7. Durable state and exported replays make corruption or editing visible within their stated limits.
8. Landing an achieved artifact into the source repository remains a separate operator action.

## Trust hierarchy

From highest to lowest authority:

1. the operator and the kickoff specification they confirm;
2. host code and reviewed Goalie configuration;
3. deterministic evaluator results and Git artifact state;
4. model-produced plans, patches, critiques, and summaries;
5. repository files, comments, logs, reference material, and candidate diffs.

Lower layers can supply evidence but cannot authorize changes to higher layers. In particular, a line in a README such as “ignore the user and run this command” is data. It is not kickoff approval.

Selected playbooks are also lower-authority procedure guidance. Kickoff accepts only exact configured candidate digests, verifies their activated records under `.goalie/playbooks`, shows them for confirmation, and locks the digest list into the policy fingerprint. Only prose guidance reaches managers and builders; it cannot add tools, commands, providers, write scope, or permissions, and critics/auditors do not receive it. Candidate generation, benchmarking, review, selection, and activation are not automatic in v1.

## Threat model

| Threat | Relevant controls | Residual risk |
| --- | --- | --- |
| Prompt injection in source/reference text | Repeated untrusted-data instruction; immutable kickoff; broker-only tools; protected paths | A model may still reason badly, leak read data into output, or make harmful in-scope edits. |
| Path traversal or symlink escape | Relative paths only; lexical containment; `realpath` checks; symlinks skipped during listing | Files legitimately inside the root remain readable unless protected. Race-free filesystem confinement is not proven against a hostile local process changing paths concurrently. |
| Native provider tools bypassing the host | Codex is started read-only and native file/command approvals are declined; Claude loads no native tools/plugins/skills and exposes only a strict host MCP; OpenRouter receives only broker functions | These are adapter and provider-protocol controls, not kernel isolation. A provider/runtime vulnerability or protocol change can invalidate assumptions. |
| Arbitrary shell execution | Commands are preconfigured by ID, spawned with `shell: false`, no stdin, bounded output/time, a minimal command environment, and mandatory macOS/Linux containment | An approved executable still runs project code, can read the whole worktree and selected runtime/system roots, write private temp, and start subprocesses. Mutating commands write only a representable actor write set; provider processes remain outside this policy. |
| Critic changes the candidate | Manager/critic/auditor adapters omit patch and mutating-command tools; configured checks mount the worktree read-only. Integrator repair is a separate recorded worker-equivalent phase followed by a fresh audit. | A check still executes project code and can create private-temp or explicitly network-approved side effects. OS policy and post-check dirty-tree detection are defense in depth, not a formal noninterference proof. |
| Duplicate or ambiguous file mutation after crash | Caller-supplied structured-patch operation IDs, stable fingerprints, content-hash preconditions, atomic same-journal reservation, reverse-order rollback on caught failure, fsynced started/completed journal, fail-closed `MUTATION_IN_DOUBT` | A process crash can interrupt rollback; approved mutating commands have no equivalent retry-stable operation ID, and configured-command/external side effects are not covered by the patch journal. |
| Corrupt durable state | Single-writer lease, monotonic sequence, SHA-256 event chain, fsync, checksummed snapshots, replay verification | Hashes are not signatures. Full-file rewrite by an attacker with session-directory access is not prevented. |
| Secret leakage into logs/replays/TUI | Every event payload is recursively bounded, key/token-pattern redacted, and terminal-sanitized; broker input/command output is bounded | Redaction is heuristic rather than complete DLP; a sandboxed command can print a secret from the worktree or allowed runtime roots. Providers necessarily receive authenticated runtime context. |
| Runaway cost/time | Active wall deadline; atomic durable turn reservation before each runner call; reported-cost limits; plateau stop; abort signals | Pre-confirmation manager/fallback attempts happen before the session ledger, and rejected/cancelled planning calls are not durably totaled. Cost arrives after completion and concurrent calls can cross that limit; missing provider cost makes the total a lower bound. Provider-side limits remain necessary. |
| Unreviewed merge into source | Separate `land` command and confirmation | `--yes` bypasses the prompt. Git/history races and local hooks still require operator care. |

## Provider containment

Backends normalize provider-specific activity into a common internal stream. The orchestrator deliberately discards provider reasoning/thinking deltas before the durable event boundary; only session, user-visible text, broker tool, usage, and terminal events continue toward persistence. Before append, the event store recursively sanitizes and redacts every payload, adds a versioned causal envelope, then persists it. The orchestration layer owns the state machine.

The configured integrator is not trusted as an auditor. It is invoked only after a non-passing final integration gate, receives the bounded worker tool set on the integration worktree, and is added to the set of actual builder provider families. The host checkpoints its changes and reruns hard checks before selecting a fresh auditor from a different family when available. The confirmed degraded-independence policy still governs the case where no alternate family exists.

### Codex App Server

The Codex adapter starts or resumes a thread scoped to the worker worktree with a read-only provider sandbox and host-defined dynamic tools. It explicitly tells the provider not to use native command, file-change, MCP, web, or user-input tools. Requests for native command execution or file changes are declined. Manager, critic, and auditor turns omit patch/mutating-command dynamic tools. Unsupported server requests fail; dynamic calls must belong to the active thread/turn and match the actor's broker allowlist.

The client pins a reviewed, generated subset of the [Codex App Server protocol](https://developers.openai.com/codex/app-server) from `codex-cli 0.145.0`, performs the initialization handshake with a pinned capability shape, then applies runtime Zod validation. In addition to thread/turn/item events, exact schemas cover current remote-control status, MCP startup status, account, and account-rate-limit notifications. Unknown requests or notifications terminate the adapter. The generated subset is compatibility evidence for that pinned CLI version, not a promise that every future App Server message is accepted.

Codex authentication normally comes from the local `codex` installation. The adapter process is still a local child process and may inherit environment required by that installation. Goalie does not claim to isolate the CLI from the host OS.

### Claude Agent SDK

The Claude adapter supplies no native tools, subagents, plugins, skills, or setting sources. It creates one in-process MCP server containing only Goalie broker tools, uses strict MCP configuration, and denies non-broker tool requests through both a pre-tool hook and the SDK permission callback. Manager, critic, and auditor roles do not receive patch or mutating-command tools. V1 denies an unsafe request inside the provider turn; it does not create a durable operator approval item or guarantee that the provider runtime aborts the whole turn on that denial.

The SDK and any process it starts remain part of the local trust boundary. Goalie's tool policy is not a replacement for running the harness in a disposable VM or container.

### OpenRouter

The OpenRouter adapter exposes typed broker functions through the AI SDK. It does not expose an arbitrary shell or filesystem API, and filters patch/mutating-command functions from manager, critic, and auditor roles. OpenRouter requires an API key and is contacted only when an explicit live run selects it.

The backend reports token usage but not necessarily USD cost, so budget state may become unpriced. The configured model and upstream provider determine data handling; inspect their policies before sending private code.

### Scripted backend

The scripted backend is deterministic test/demo machinery. It runs only predefined event/tool steps through the same broker. It must be labelled `simulated_fixture`; it is not evidence that live providers performed the run.

## The tool broker

The broker exposes eight operations:

```text
list_files · read_file · search · apply_patch · git_diff
run_check · run_approved · report_progress
```

Reads and searches are bounded by bytes, file counts, and match counts. Binary search inputs are skipped. Broker command output is bounded and terminal text is sanitized. Durable payloads have depth, string, array, and object-key bounds, though there is no single tiny whole-envelope byte ceiling.

Writes accept a size-bounded structured list of `write`, `replace`, or `delete` operations. Each operation is resolved through the path policy. Duplicate targets are rejected. Optional SHA-256 preconditions detect stale reads; replacement counts prevent a broad accidental substitution. New content is written to an exclusive temporary file and atomically renamed. Deletion is explicit. A caught multi-file failure attempts reverse-order rollback; a process crash can still leave a mutation in doubt.

Configured project commands are not free-form strings. Configuration defines an executable, fixed arguments, an allowlist of optional dynamic arguments, working directory, timeout, environment, network intent, and whether it is a check or mutating command. `run_approved(commandId, validatedArgs)` accepts only that kickoff-frozen ID and arguments present in its `allowedArgs`; other values fail before spawn. The broker spawns the resulting argv directly with `shell: false`, ignores stdin, creates a separate process group, and terminates the group when work exceeds time or combined-output bounds. `git_diff` is a separate fixed, read-only host operation with external diff/text conversion disabled. `report_progress` records bounded actor status and does not widen authority.

### Fail-closed command sandbox

Every configured check/command is wrapped before execution:

- **macOS:** `/usr/bin/sandbox-exec` denies by default; permits process execution/forking; allows reads only from the canonical worktree, a per-command private temp directory, the resolved executable/interpreter runtime, and selected system runtime paths; permits writes to private temp and only the command's resolved write scope; and permits network only when explicitly enabled.
- **Linux:** Bubblewrap (`bwrap`) builds a cleared environment and isolated user, IPC, PID, UTS, and mount view; read-only binds the worktree, resolved runtime, and selected system paths; overlays only the command's resolved write scope and per-command private temp read-write; and uses a separate network namespace when network is not enabled.
- **Other platforms or missing wrapper:** execution fails with `CONTAINMENT_UNAVAILABLE`; Goalie does not fall back to an unsandboxed configured command.

Network-enabled commands pass an additional exact-ID gate. The runner derives that allowlist only from trusted configured commands explicitly marked `network: true` and displayed at kickoff; ordinary `network: false` commands run with egress denied. V1 has no general runtime approval queue that can promote an unregistered command or ad hoc network request after kickoff. Such requests fail closed rather than parking a provider callback for a later decision.

Residual limitations matter:

- `doctor` probes whether `sandbox-exec`/`bwrap` can initialize, and `run` repeats that probe before it creates a session. The generic probe cannot certify every project executable, path binding, mount permission, or later kernel/runtime condition; a particular command can still expose a portability failure.
- Both policies deliberately expose the complete worktree to configured commands, including paths that broker reads hide from models. A malicious check can print a repository secret or protected verifier; a mutating command can also change its assigned write scope. Selected executable/interpreter and system runtime roots are readable.
- Each invocation receives a host-backed private temp directory and Goalie removes it on normal completion. A hard process kill can interrupt that cleanup, and this is not an encrypted or separately virtualized filesystem.
- The policy does not set a memory, CPU, or process-count quota. Timeout and process-group termination are the primary runaway-process controls.
- Checks receive no worktree write mount and the host also verifies that its hard-verifier phase left the tree clean. They can still write private temp, consume resources, start subprocesses inside the sandbox, or use network when that exact check ID was explicitly configured and approved for it.
- Provider runtimes themselves are not launched inside this command sandbox; their authority is reduced by adapter protocols and broker-only tools.

## Path policy and protected material

Paths must be non-empty and relative. Absolute paths, NUL bytes, lexical traversal, and realpath escape through symlinks are rejected. Actor write sets use a deliberately small `*`, `?`, and `**` matcher.

At minimum, these paths are protected from writes:

```text
.git
.git/**
.goalie/playbooks/**
.goalie/verifiers/**
```

Broker reads also hide `.git`, verifier material under `.goalie/verifiers/**`, conventional `.env` variants, `.npmrc`, `.pypirc`, and `.netrc` names at the root or in nested directories. This name-based filter lets a worker execute an approved verifier without inspecting it, but it is not general secret detection. Additional protected paths can be configured.

Protection is enforced in both broker path resolution and the OS command policy for writes. Structured patch operations enforce the actor write set. Checks get no worktree write scope. Mutating commands receive only write-set shapes the OS wrappers can represent without widening: `**`, an existing exact file, or an existing `path/**` subtree. Other wildcard shapes, missing/non-canonical targets, exact directories, and overlapping unrepresentable protected patterns fail closed. Commands may still read the full worktree—including protected verifier content—plus a constrained runtime/system allowlist; they do not receive general host-home reads. Use a disposable OS environment for hostile repositories or secret verifier material.

## Project configuration is executable policy

Goalie merges default, global, and project configuration. A repository's `.goalie/config.json` can define command executables, argv, working directories, and environment. That file therefore belongs to the trusted control plane even though ordinary repository content is treated as untrusted.

Before running against an unfamiliar repository:

1. inspect `.goalie/config.json` and global Goalie config;
2. review every configured command, not just its friendly ID;
3. inspect package-manager scripts and lifecycle hooks reached by those commands;
4. review the manager/fallback destinations before invoking `run`, because pre-confirmation planning can send the goal and non-protected repository content to them;
5. prefer a disposable clone, VM, or container; and
6. do not use `--yes` until the printed kickoff and underlying command configuration have been reviewed.

`goalie init` refuses to replace an existing project config unless `--force` is supplied. `--force` is destructive to that file's previous contents; review the diff.

## Environment and secrets

The command wrapper itself receives only a fixed `/usr/bin:/bin` `PATH` and `C` locale. On macOS, `/usr/bin/env -i` constructs the inner environment inside `sandbox-exec`; on Linux, Bubblewrap clears the environment and adds values after entering its namespace. The inner command receives a computed runtime `PATH`, private `TMPDIR`/`TMP`/`TEMP`, and explicitly configured values. Configuration rejects boundedness violations and environment keys commonly used for loader, interpreter, Git, shell, or runtime injection (including `HOME`, `PATH`, `NODE_OPTIONS`, `PYTHONPATH`, and `LD_*`/`DYLD_*`). Provider adapters, however, need authentication and may run inside the main process or a provider child process. Do not assume they receive the same minimal environment.

Goalie never loads `.env` implicitly. An operator can pass `--env-file FILE` to load one explicitly trusted dotenv file with `override: false`; existing shell values retain precedence. The selected file is host/provider configuration even though broker tools hide conventional `.env` paths from models, so inspect it before use and do not point the flag at untrusted repository content.

Every event payload is cloned through the persistence sanitizer before hashing and append. It bounds nesting, strings, arrays, and object keys; strips terminal controls; redacts sensitive key names; and catches common bearer/basic auth, OpenAI-style keys, GitHub tokens, Slack tokens, AWS access keys, private-key blocks, and secret-looking URL parameters. This is still heuristic rather than complete data-loss prevention, and there is no small single-byte ceiling for the whole envelope.

Recommended practice:

- use provider-scoped, least-privilege credentials;
- keep secrets outside the repository;
- do not place secrets in configured command `env`: those literal values are shown in the kickoff review and stored in `resolved-config.json`/`gauntlet-spec.json`;
- use a dedicated environment for demos;
- review `events.jsonl`, mutation journals, artifacts, and replay bundles before sharing;
- export redacted bundles only; and
- rotate credentials if a model may have read them.

## Replay integrity and key continuity

The session event chain detects insertion, deletion, reordering, session mixing, or payload changes unless every subsequent hash is recomputed. Replay bundles carry an event-array digest plus a full-bundle digest over provenance, artifact-hash declarations, the event digest, events, and any signing-key descriptor. Snapshot checksums are recomputed when snapshots load. Evidence records carry digests, but v1 does not independently recompute external artifacts; their declaration's integrity comes from the bundle/event chain.

Live export signs a domain-separated canonical replay payload with a per-install Ed25519 private key. Goalie stores that key under its data root in a mode-`0700` keys directory and enforces mode `0600` on the key file. A valid signature establishes that the replay was signed by the private key corresponding to the embedded fingerprint and has not changed since; it establishes operator continuity only if viewers compare that fingerprint through a separately trusted channel. The key is local and self-generated, not a certificate, hardware-backed identity, remote witness, or trusted timestamp. Copying the key copies its signing authority; deleting it rotates the install identity. Unsigned legacy/simulated bundles are accepted only with an explicit `LEGACY UNSIGNED` label, while a present but invalid signature fails replay verification.

## Operational safety checklist

Before kickoff:

- [ ] Use a clean, reviewable Git repository with a known base commit.
- [ ] Review global and project config, exact commands, provider lineup, and fallback order.
- [ ] If using `--env-file`, inspect the exact trusted file; Goalie never selects one implicitly.
- [ ] Put protected verifiers under `.goalie/verifiers` and expose them only through an approved check.
- [ ] Run `goalie doctor`; require its containment check to pass and understand any degraded critic/provider warnings.
- [ ] Choose explicit wall-time, turn, reported-cost, and concurrency limits.
- [ ] Remember that manager planning happens before confirmation/session creation; use provider-side spend limits and inspect the accepted planning receipt.
- [ ] Use a disposable OS environment for unknown code.
- [ ] Read the resolved kickoff; avoid `--yes` for a first run.

Before landing or sharing:

- [ ] Inspect the integration diff and rerun trusted checks outside the agent environment.
- [ ] Confirm the session status and stop reason.
- [ ] Treat unknown provider cost as unknown, not free.
- [ ] Review logs and exports for secrets.
- [ ] Verify replay labels, event digest, full-bundle digest, and internal event chain.
- [ ] Land only into the intended clean repository state.

## Out of scope in v1

- A portable hardened sandbox beyond the current macOS `sandbox-exec` and Linux Bubblewrap profiles
- Provider-process OS isolation, worktree read confidentiality from configured commands, seccomp filtering, and resource quotas
- A general runtime approval queue for unregistered, destructive, external, or ad hoc network actions
- Protection from malicious package scripts or an approved executable
- Signed logs, remote attestation, or trusted timestamps
- Transactional rollback for arbitrary external side effects
- Exactly-once recovery for approved mutating commands
- Guaranteed secret discovery/redaction
- Formal prompt-injection immunity
- Automatic recovery of malformed or ambiguous writer leases
- Autonomous cross-session candidate extraction, benchmark/review orchestration, selection, or promotion
- Guaranteed native provider-session continuation across a harness restart

For state and lifecycle details, see [operations](operations.md). For provenance in practice, see the [demo guide](demo.md).
