# Accepted-input operation protocol

Piclaw must keep one durable operation for every accepted input until that input has one durable terminal disposition. Queue entries and timers are wake-up hints; they do not own accepted work.

This protocol defines the target contract for the audit remediation. It extends the existing durable chat state and does not introduce an independent recovery coordinator.

## Evidence baseline

The remediation branch started from the audited commit without source changes:

| Field | Value |
|---|---|
| Audit commit | `8fbbc6ebf5e9033c1138bec31d0a587d9dd51e46` |
| Worktree | `/workspace/piclaw-wt-queue-liveness` |
| Branch | `fix/queue-self-continuation` |
| Tracking branch | `origin/main` |
| Recorded HEAD | `8fbbc6ebf5e9033c1138bec31d0a587d9dd51e46` |

HEAD and `origin/main` matched when the branch was created. No commit after the audit baseline had fixed a finding at that point.

### Finding map

`Open` means the validated failure still exists. `Partial at baseline` records a guard that narrows the failure without satisfying the lifecycle invariant.

| # | Validated finding | Current symbols | Baseline tests and gap | Baseline state |
|---:|---|---|---|---|
| 1 | A running queue item cannot enqueue its same-ID successor. | `runtime/src/queue.ts`: `AgentQueue.hasQueuedId()`, `enqueue()`, `executeItem()` | `runtime/test/queue/queue.test.ts` covers duplicate, retry and shutdown behaviour but has no same-ID self-continuation case. | Open |
| 2 | Generic wake clears and skips a failed frontier. | `runtime/src/channels/web/runtime/process-chat-control-runtime.ts`: `selectProcessChatMessage()` and `stale_failed_run_cleared` | `runtime/test/channels/web/runtime/process-chat-control-runtime.test.ts` asserts the destructive clear-and-advance behaviour. | Open |
| 3 | Restart recovery clears ownership separately from recovery output writes. | `runtime/src/channels/web/runtime/recovery.ts`: `recoverInflightRuns()`; `runtime/src/db/chat-cursors.ts`: crash-recovery helpers | `runtime/test/channels/web/recovery.test.ts` and `web-channel-recovery-state.test.ts` cover recovery outcomes, but do not inject a crash between ownership clear and terminal write. | Open |
| 4 | An intermediate row followed by an empty final result can complete without a terminal row. | `runtime/src/channels/web/handlers/agent.ts`: `persistedIntermediateOutput` and empty-final handling | `runtime/test/channels/web/web-channel.test.ts` covers intermediate and draft fallbacks, but not an intermediate-only terminal closure invariant. | Open |
| 5 | Cross-session abort compares an ephemeral turn ID and can act after ownership changes. | `runtime/src/runtime/startup.ts`: session-control abort; `runtime/src/channels/web/agent/agent-control-plane-service.ts`: active `turn_id` comparison | Existing control-plane tests cover request routing and active turn checks. No test pauses alias resolution, replaces the owner, then delivers a stale abort. | Open |
| 6 | Session mutations bypass one per-chat serialisation boundary. | `runtime/src/agent-pool/runtime-facade.ts`: `applyControlCommand()`, `applySlashCommand()`; `runtime/src/channels/web/handlers/agent.ts`: direct command paths; `runtime/src/agent-pool/run-agent-orchestrator.ts`: prompt and maintenance paths | Command and orchestrator tests cover each path separately. They do not prove mutual exclusion across prompt, compact, rotate, retry and command execution. | Open |
| 7 | `/abort` cancellation is chat-scoped and mutable rather than operation-scoped and durable. | `runtime/src/agent-control/handlers/control.ts`: `handleAbort()`; `runtime/src/agent-pool/abort-provenance.ts` | Abort and provenance tests cover immediate session effects. They do not bind cancellation to a durable operation or reject stale cancellation. | Open |
| 8 | Idle compaction can delay a successful turn before durable terminal output. | `runtime/src/agent-pool/run-agent-orchestrator.ts`: `scheduleIdleAutoCompaction` and `maybeAutoCompactSessionAfterTurn()`; enabled by `runtime/src/channels/web/handlers/agent.ts` | Orchestrator and compaction tests cover maintenance execution, but not the ordering invariant that terminal output commits first. | Open |
| 9 | Some accepted steers remain selectable persisted messages. | `runtime/src/channels/web/handlers/agent.ts`: `shouldPersistSteerRequest()`, `persistSteer`, `is_steering_message`; `runtime/src/channels/web/runtime/pending-steering.ts` | `runtime/test/channels/web/web-channel.test.ts` covers persisted peer steers and invisible deferred steers. It does not require every accepted steer to receive a non-selectable durable disposition. | Open |
| 10 | Preflight completion can fail to enqueue a wake when ownership changed. | `runtime/src/channels/web/runtime/process-chat-preflight-runtime.ts`: deferred compaction `.finally()`, `releaseOwner()`, `enqueueResume()` | Preflight runtime tests cover ownership and resume paths, but no race where physical settlement follows an ownership change and still requires a harmless wake. | Open |
| 11 | Slash-command output uses a channel-global interaction ID. | `runtime/src/channels/web.ts`: `lastCommandInteractionId`; `runtime/src/channels/web/handlers/agent.ts`: set/clear around `applySlashCommand()`; `runtime/src/channels/web/post-mutations.ts` | Endpoint and post-mutation tests assert the shared field. No concurrent command test proves operation-local output attribution. | Open |
| 12 | Deferred follow-up exhaustion deletes content and emits `consumed`. | `runtime/src/channels/web/runtime/process-chat-control-runtime.ts`: `materializeDeferredFollowups()`, `process_chat.materialize_followup_drop`, `broadcastConsumedFollowup()` | `runtime/test/channels/web/web-channel.test.ts` asserts retry persistence and terminal drop. There is no dead-letter retry/discard contract. | Open |
| 13 | Recovery can classify deterministic conflicts or abort fallout through generic budget handling. | `runtime/src/agent-pool/automatic-recovery.ts`: `classifyOpaqueAgentFailure()`, `decideAutomaticRecovery()` | `runtime/test/agent-pool/automatic-recovery.test.ts` covers classifier ordering. `compaction_in_progress` and `session_corruption` already short-circuit before budget at the baseline; typed operation cancellation and all deterministic conflicts do not. | Partial at baseline |
| 14 | Queue retry exhaustion has no durable blocked or exhausted disposition. | `runtime/src/queue.ts`: `scheduleRetry()` and `shouldRetry()` | `runtime/test/queue/queue.test.ts` checks retry metrics and shutdown. It does not assert a durable terminal or blocked outcome after exhaustion. | Open |
| 15 | Timed-out compaction quarantine can leave accepted work dependent on an in-memory settlement callback. | `runtime/src/agent-pool/compaction.ts`: timeout quarantine; `runtime/src/agent-pool/run-agent-recovery-phase.ts`: compaction recovery | Compaction and recovery-phase tests cover timeouts and late settlement, but not restart at each quarantine boundary. | Open |
| 16 | Recovery relies on rendered error text and elapsed budgets rather than durable ownership state. | `runtime/src/agent-pool/automatic-recovery.ts`: `classifyOpaqueAgentFailure()`, `decideAutomaticRecovery()` | Automatic-recovery tests cover known strings and budgets. They cannot prove lifecycle safety after restart or adapter wording changes. | Open |
| 17 | Protected internal recovery continuation is not crash-durable. | `runtime/src/agent-pool/protected-recovery-handoff.ts`; `runtime/src/agent-pool/contracts.ts`: `protectedRecoveryContinuation`; `runtime/src/channels/web/handlers/agent.ts` | `runtime/test/agent-pool/protected-recovery-handoff.test.ts` and web tests prove one internal tool-enabled handoff without a synthetic user row. They do not restart before, during or after that handoff. | Partial at baseline |

The audit also rejected broad claims that all thread identity, callback capture, all compaction timeouts or every successful terminal path were broken. This protocol addresses the validated lifecycle failures without treating those rejected claims as requirements.

## Durable operation

Each accepted source gets one generated `operation_id`. The ID is written in the same transaction that accepts the source and is never regenerated during retry, recovery, rotation or restart.

An operation records at least:

- `chat_jid`;
- `operation_id`;
- source kind and stable source identity;
- source order at the chat frontier;
- phase and phase epoch;
- cancellation state and cause;
- terminal disposition and terminal row reference, when present.

The source can be a user message, queued follow-up, steer, slash/control command or protected internal continuation. Runtime control does not require a synthetic user message. A protected continuation remains a phase of its source operation and cannot become a second source.

`operation_id` is the owner token for session and chat-state mutation. Every mutating transition compares the expected token with the durable current owner. A stale owner receives an explicit no-op or conflict result.

## States

The durable phase uses this small set:

| State | Meaning |
|---|---|
| `pending` | The source is durable and waits at or behind the frontier. |
| `preflight` | The operation owns selection, introspection and bounded pre-prompt work. |
| `running` | The operation owns prompt, tool and stream effects. |
| `waiting` | The operation owns a durable retry, compaction, rotation or protected-continuation wait. |
| `blocked` | Automatic progress stopped. The source retains ownership until explicit retry or skip. |
| `terminal` | One durable disposition exists. The operation cannot change again. |

`phase_epoch` increments before an asynchronous phase effect starts. Completion callbacks must compare both `operation_id` and `phase_epoch`. Late callbacks from retries, compaction, rotation, watchdogs or remote control cannot mutate a successor.

## Frontier

The chat frontier is the earliest accepted non-terminal source in durable source order. Later prompt-bearing work cannot pass it.

A queue wake asks the gateway to inspect the frontier. It does not advance the frontier, clear a failure or prove completion. Duplicate wakes are harmless because claim and promotion compare `operation_id` and phase.

A steer accepted for the running operation is marked non-selectable when accepted. Its durable intent records `pending`, `applied`, `failed` or `discarded`; visibility in the timeline does not change selection semantics.

## Legal transitions

All transitions run through one `chat:<jid>` gateway, except the compare-and-act abort signal described below.

| From | To | Condition |
|---|---|---|
| source absent | `pending` | Accept the source and operation atomically. |
| `pending` | `preflight` | Claim the frontier with an owner compare-and-set. |
| `preflight` | `running` | Promote the same owner after preflight settles. |
| `preflight` or `running` | `waiting` | Persist the next retry, compaction, rotation or continuation phase before releasing execution. |
| `waiting` | `running` | Resume only when owner and phase epoch still match. |
| any non-terminal state | `blocked` | Persist a deterministic failure or exhausted policy while retaining the source. |
| `blocked` | `pending` | Explicit retry creates a new phase epoch for the same operation. |
| `blocked` | `terminal` | Explicit visible skip/discard writes a terminal disposition. |
| any non-terminal state | `terminal` | Atomic completion writes one disposition and commits the frontier. |

There is no transition out of `terminal`. Repeating a completed transition returns the stored result. A later source never clears or replaces the frontier operation.

## Terminal invariant

A consumed source has exactly one terminal disposition:

- `succeeded`;
- `tool_complete`;
- `failed`;
- `interrupted`;
- `cancelled`;
- `skipped`;
- `dead_lettered`.

Terminal completion is one idempotent transaction. It:

1. verifies `chat_jid`, `operation_id`, phase and expected version;
2. stores or promotes exactly one terminal output row when the disposition requires visible output;
3. disposes of source-bound steer, command, follow-up and continuation intent;
4. stores the terminal disposition and row reference;
5. advances the frontier;
6. releases durable ownership.

The transaction can return the existing terminal result after a retry. A terminal output write failure leaves the operation non-terminal and recoverable. An intermediate row alone is not a terminal disposition; completion must promote the last eligible row or append one closure.

## Cancellation

Cancellation belongs to `operation_id`. The first accepted cancellation cause wins and is durable.

Remote abort requires `expected_operation_id`. The control path resolves the target alias, reads the current durable owner, compares the expected ID and only then sends the abort signal. Missing, terminal or mismatched owners return explicit no-op results. A stale abort cannot affect a successor operation.

The gateway checks cancellation before preflight promotion, retry, rotation, protected continuation, tool admission and terminal commit. `/abort` is the only session mutation allowed outside the gateway, and only after the operation comparison succeeds. Aborting compaction does not resume or reclassify a cancelled source.

## Session mutation gateway

Prompt, compact, retry, model/session changes, prompting slash commands, rotation and maintenance execute through the per-chat gateway. Each command carries `operation_id` and phase epoch.

Maintenance starts only after terminal output commits and no accepted user work is pending. It uses an internal operation identity and cannot occupy or advance a user frontier.

## Crash recovery

Restart recovery reads durable operations before scheduling queue work.

- A durable `pending`, `preflight`, `running` or `waiting` operation retains the source. Recovery either resumes an idempotent phase or moves it to `blocked`/`terminal` through the same compare-and-set primitives.
- Recovery never clears ownership before terminal output and disposition commit.
- A partial or intermediate-only run receives one durable `interrupted` closure unless an existing eligible row can be promoted atomically.
- A no-output run remains owned until retry, visible failure or explicit skip commits.
- Deferred follow-up exhaustion creates a durable dead letter with content, media and retry metadata. It emits `failed`, not `consumed`.
- Protected continuation intent is written before the internal prompt starts and cleared only by atomic terminal completion.
- Queue retry exhaustion writes `blocked` or `failed`; it cannot end with only an in-memory metric.
- Replaying recovery before or after any database or session boundary yields the same owner and terminal result.

These rules require fault tests at every ownership, output, intent and frontier write boundary. Startup can enqueue redundant wakes after physical preflight or compaction settlement because durable compare-and-set checks make them harmless.
