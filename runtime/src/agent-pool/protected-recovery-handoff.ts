/**
 * protected-recovery-handoff.ts – Bounded ordinary-turn handoff for protected recovery.
 *
 * A generic recovery that would require tool suppression is converted into one
 * internal ordinary continuation before the AgentPool call returns. The
 * continuation is never materialized as a timeline or queued-followup message.
 */

import { TOOL_ENABLED_RECOVERY_CONTINUATION_PROMPT } from "./context-pressure-retry.js";
import type { AgentOutput, RunAgentOptions, TurnOutput } from "./contracts.js";

/**
 * Run one prompt and, when required, exactly one internal tool-enabled turn.
 * The generated continuation never chains, even if its own recovery is also
 * protected. Caller-supplied run options (including intentional tool ceilings)
 * remain in force; only recovery's temporary all-tools suppression is absent.
 */
export async function runWithProtectedRecoveryHandoff(
  prompt: string,
  options: RunAgentOptions,
  run: (nextPrompt: string, nextOptions: RunAgentOptions) => Promise<AgentOutput>,
  onOutput?: (output: AgentOutput) => void,
): Promise<AgentOutput> {
  const bufferedTurns: TurnOutput[] = [];
  const originalOnTurnComplete = options.onTurnComplete;
  const shouldBufferInitialTurns = Boolean(originalOnTurnComplete)
    && !options.protectedRecoveryContinuation;
  const initialOptions = shouldBufferInitialTurns
    ? { ...options, onTurnComplete: (turn: TurnOutput) => bufferedTurns.push(turn) }
    : options;
  const initial = await run(prompt, initialOptions);
  onOutput?.(initial);

  if (
    !initial.requiresToolEnabledContinuation
    || options.protectedRecoveryContinuation
  ) {
    for (const turn of bufferedTurns) originalOnTurnComplete?.(turn);
    return initial;
  }

  // Preserve committed pre-tool progress from the protected run, but suppress
  // any unauthoritative terminal prose produced by legacy/injected runners:
  // only the ordinary continuation may close tool-dependent work. Generic
  // runtime recovery now hands off before making a tools-disabled request.
  for (const turn of bufferedTurns) {
    if (turn.followedByToolUse) originalOnTurnComplete?.(turn);
  }
  const continuation = await run(TOOL_ENABLED_RECOVERY_CONTINUATION_PROMPT, {
    ...options,
    protectedRecoveryContinuation: true,
  });
  onOutput?.(continuation);
  // The one-shot handoff has been spent. Preserve the continuation outcome,
  // but never expose a flag that a caller could accidentally chain again.
  if (!continuation.requiresToolEnabledContinuation) return continuation;
  const { requiresToolEnabledContinuation: _spent, ...terminal } = continuation;
  return terminal;
}
