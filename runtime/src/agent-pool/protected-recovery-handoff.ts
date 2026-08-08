/**
 * protected-recovery-handoff.ts – Bounded ordinary-turn handoff for protected recovery.
 *
 * Legacy/non-durable callers consume one internal ordinary continuation. Durable
 * web roots may explicitly externalize the handoff, while the resulting durable
 * child may consume one internal resume only after successful recovery compaction.
 */

import { TOOL_ENABLED_RECOVERY_CONTINUATION_PROMPT } from "./context-pressure-retry.js";
import type { AgentOutput, RunAgentOptions, TurnOutput } from "./contracts.js";

function withoutContinuationFlag(output: AgentOutput): AgentOutput {
  const {
    requiresToolEnabledContinuation: _spent,
    protectedRecoveryHandoff: _evidence,
    ...terminal
  } = output;
  return terminal;
}

/**
 * Run one prompt and enforce the caller's explicit protected-recovery policy.
 * Omitted mode preserves the legacy internal one-shot behavior.
 */
export async function runWithProtectedRecoveryHandoff(
  prompt: string,
  options: RunAgentOptions,
  run: (nextPrompt: string, nextOptions: RunAgentOptions) => Promise<AgentOutput>,
  onOutput?: (output: AgentOutput) => void,
  isCancelled?: () => boolean,
): Promise<AgentOutput> {
  const bufferedTurns: TurnOutput[] = [];
  const originalOnTurnComplete = options.onTurnComplete;
  const alreadyGeneratedLegacyContinuation = Boolean(options.protectedRecoveryContinuation)
    && !options.protectedRecoveryHandoffMode;
  const shouldBufferInitialTurns = Boolean(originalOnTurnComplete)
    && !alreadyGeneratedLegacyContinuation;
  const initialOptions = shouldBufferInitialTurns
    ? { ...options, onTurnComplete: (turn: TurnOutput) => bufferedTurns.push(turn) }
    : options;
  const initial = await run(prompt, initialOptions);
  onOutput?.(initial);

  if (isCancelled?.()) return withoutContinuationFlag(initial);

  if (!initial.requiresToolEnabledContinuation || alreadyGeneratedLegacyContinuation) {
    for (const turn of bufferedTurns) originalOnTurnComplete?.(turn);
    return initial;
  }

  // Preserve committed pre-tool progress, but suppress unauthoritative terminal
  // prose from the transient all-tools-disabled protected attempt.
  for (const turn of bufferedTurns) {
    if (turn.followedByToolUse) originalOnTurnComplete?.(turn);
  }
  if (isCancelled?.()) return withoutContinuationFlag(initial);

  if (options.protectedRecoveryHandoffMode === "durable_externalize") {
    return initial;
  }

  if (options.protectedRecoveryHandoffMode === "durable_continuation"
    && (!initial.protectedRecoveryHandoff?.afterSuccessfulCompaction
      || options.protectedRecoveryInternalResume)) {
    // The durable external allowance has already been spent. Return typed
    // evidence to the durable owner so it can close visibly without recursion.
    return initial;
  }

  const continuation = await run(TOOL_ENABLED_RECOVERY_CONTINUATION_PROMPT, {
    ...options,
    protectedRecoveryContinuation: true,
    protectedRecoveryInternalResume: true,
  });
  onOutput?.(continuation);

  // The internal one-shot has been spent. Legacy callers retain the historical
  // stripped result; durable children keep typed evidence so their owner can
  // persist a deterministic refusal/failure cause.
  if (!continuation.requiresToolEnabledContinuation) return continuation;
  return options.protectedRecoveryHandoffMode === "durable_continuation"
    ? continuation
    : withoutContinuationFlag(continuation);
}
