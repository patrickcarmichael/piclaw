import type { AgentSession } from "@earendil-works/pi-coding-agent";

import type { AttachmentInfo } from "./attachments.js";
import {
  inspectBlankTurnSessionDelta,
  isBlankTurnSessionDelta,
} from "./blank-turn-detection.js";
import { classifyOpaqueAgentFailure, type RecoveryAttemptSnapshot } from "./automatic-recovery.js";
import type { AgentFailureCategory, AgentOutput, RunAgentOptions } from "./contracts.js";
import type { MutationQuarantine } from "./mutation-quarantine.js";
import { consumeAgentAbortCause } from "./abort-provenance.js";
import { getAutoCompactionTokenStatusForSession } from "./compaction.js";
import { debugSuppressedError, type StructuredLogger } from "../utils/logger.js";

export interface PromptAttemptFinalizationInput {
  session: AgentSession;
  sessionEntryBaseline: number | null;
  chatJid: string;
  timeoutMs: number;
  timedOut: boolean;
  staleProgressAbortFailed: string | null;
  staleProgressInterrupted: boolean;
  finalText: string;
  finalAttachments: AttachmentInfo[];
  finalUsage: unknown;
  lastAssistantState: {
    stopReason?: string | null;
    rawStopReason?: string | null;
    errorMessage?: string | null;
    hadTextContent?: boolean;
    hadThinkingContent?: boolean;
    hadToolCallContent?: boolean;
  } | null;
  promptThrownError: string | null;
  turnError: { errorMessage: string } | null;
  latentStateError: string | null;
  hadToolActivity: boolean;
  hadPartialOutput: boolean;
  hadCompletedTurnOutput: boolean;
  hadTerminalTurnOutput: boolean;
  sawAssistantToolCallMessage: boolean;
  onlyReadOnlyToolActivity: boolean;
  hasUnresolvedToolExecution: boolean;
  sawTerminalSideEffectToolActivity: boolean;
  hadToolFailure: boolean;
  hadToolFailureBeforeSoftStop: boolean;
  hadToolFailureAfterSoftStop: boolean;
  toolUseSoftStopApplied: boolean;
  toolUseBudgetExceeded: boolean;
  mutationQuarantine?: MutationQuarantine | null;
  toolExecutionCount: number;
  assistantToolUseMessageCount: number;
  toolUseMessageBudget: number;
  compactionErrorMessage: string | null;
  sawCompactionIntent: boolean;
  runOptions: RunAgentOptions;
  onWarn?: (message: string, details: Record<string, unknown>) => void;
  getRunObservabilityDetails(runOptions: RunAgentOptions): Record<string, unknown>;
  formatTimeoutDuration(ms: number): string;
  getProgressWatchdogTimeoutMs(): number;
  log: StructuredLogger;
}

function buildLengthStopError(partialText: string | null | undefined): string {
  const partialDetail = partialText && partialText.trim()
    ? " The partial answer was preserved; ask me to continue to resume from it."
    : " Ask me to continue and I will retry with a shorter final answer.";
  return `Provider stopped because it hit the maximum output length before finalization (finish reason: length).${partialDetail}`;
}

function getSessionStateErrorMessage(session: AgentSession): string | null {
  const errorMessage = (session as AgentSession & {
    agent?: { state?: { errorMessage?: unknown } };
  }).agent?.state?.errorMessage;
  return typeof errorMessage === "string" && errorMessage.trim() ? errorMessage.trim() : null;
}

export function readSessionStateErrorMessage(session: AgentSession): string | null {
  return getSessionStateErrorMessage(session);
}

export function finalizePromptAttemptOutput(input: PromptAttemptFinalizationInput): {
  output: AgentOutput;
  snapshot: RecoveryAttemptSnapshot;
} {
  let sawCompactionIntent = input.sawCompactionIntent;
  const sawThinkingOnlyStop = Boolean(
    input.lastAssistantState?.stopReason === "stop"
      && input.lastAssistantState?.hadThinkingContent
      && !input.lastAssistantState?.hadTextContent
      && !input.lastAssistantState?.hadToolCallContent
  );

  const abortProvenance = consumeAgentAbortCause(input.chatJid);
  const abortFailureCategory = (cause: NonNullable<AgentOutput["abortCause"]>): AgentFailureCategory => {
    if (cause === "context_pressure") return "context_pressure";
    if (cause === "prompt_timeout") return "timeout";
    if (cause === "stale_progress_watchdog") return "stalled_work";
    if (cause === "tool_budget") return "tool_budget";
    return "aborted";
  };
  const withAbortProvenance = (output: AgentOutput): AgentOutput => abortProvenance
    ? {
      ...output,
      failureCategory: abortFailureCategory(abortProvenance.cause),
      abortCause: abortProvenance.cause,
      abortOperation: abortProvenance.operation,
    }
    : output;

  let output: AgentOutput;
  if (input.staleProgressAbortFailed) {
    output = { status: "error", result: null, failureCategory: "stalled_work", error: `Stale-progress watchdog detected no progress and failed to abort the run: ${input.staleProgressAbortFailed}` };
  } else if (input.staleProgressInterrupted) {
    output = { status: "error", result: null, failureCategory: "stalled_work", error: `Stale-progress watchdog interrupted the run after no progress for ${input.formatTimeoutDuration(input.getProgressWatchdogTimeoutMs())}.` };
  } else if (input.timedOut) {
    output = { status: "error", result: null, failureCategory: "timeout", error: `Timed out after ${input.formatTimeoutDuration(input.timeoutMs)}` };
  } else if (input.mutationQuarantine
    && !input.promptThrownError
    && !input.turnError
    && !input.latentStateError
    && !input.finalText
    && input.finalAttachments.length === 0
    && input.lastAssistantState?.stopReason !== "pending"
    && input.lastAssistantState?.stopReason !== "aborted"
    && input.lastAssistantState?.stopReason !== "length") {
    output = {
      status: "error",
      result: null,
      failureCategory: "mutation_repetition",
      error: `Tool ${input.mutationQuarantine.toolName} repeated the same successful mutation ${input.mutationQuarantine.successfulRepetitions} times. Further matching calls were blocked and tools were disabled for safe terminal recovery.`,
    };
  } else if (input.toolUseBudgetExceeded && !input.finalText && input.finalAttachments.length === 0) {
    const reportedToolSteps = input.toolExecutionCount > 0 ? input.toolExecutionCount : input.assistantToolUseMessageCount;
    const reportedToolBudget = input.toolUseMessageBudget;
    output = {
      status: "error",
      result: null,
      error: `Tool-use budget exceeded before finalization (${reportedToolSteps}/${reportedToolBudget} tool steps). Ask me to continue; I will resume from the latest known partial state instead of replaying the whole turn.`,
      failureCategory: "tool_budget",
      toolBudgetExceeded: true,
      toolStepsUsed: reportedToolSteps,
      toolStepsBudget: reportedToolBudget,
      nextAction: "Ask me to continue; I will resume from the latest known partial state instead of replaying the whole turn.",
    };
  } else if (input.promptThrownError) {
    output = { status: "error", result: null, failureCategory: classifyOpaqueAgentFailure(input.promptThrownError), error: input.promptThrownError };
  } else if (input.turnError) {
    output = { status: "error", result: null, failureCategory: classifyOpaqueAgentFailure(input.turnError.errorMessage), error: input.turnError.errorMessage };
  } else if (input.lastAssistantState?.stopReason === "pending") {
    const rawDetail = input.lastAssistantState.rawStopReason
      ? ` (provider reason: ${input.lastAssistantState.rawStopReason})`
      : "";
    output = { status: "error", result: null, failureCategory: "provider", error: `Provider response remained pending and did not reach a terminal stop${rawDetail}.` };
  } else if (input.lastAssistantState?.stopReason === "aborted") {
    output = { status: "error", result: null, failureCategory: "aborted", error: input.lastAssistantState.errorMessage || "Provider response was aborted." };
  } else if (input.latentStateError) {
    output = { status: "error", result: null, failureCategory: classifyOpaqueAgentFailure(input.latentStateError), error: input.latentStateError };
  } else if (input.lastAssistantState?.stopReason === "length") {
    output = {
      status: "error",
      result: null,
      error: buildLengthStopError(input.finalText),
      failureCategory: "output_limit",
      ...(input.finalUsage ? { usage: input.finalUsage as AgentOutput["usage"] } : {}),
    };
  } else {
    const blankTurnDelta = inspectBlankTurnSessionDelta(input.session, input.sessionEntryBaseline);
    if (!input.finalText && input.finalAttachments.length === 0 && !input.hadTerminalTurnOutput) {
      let detail: string;
      if (!input.hadPartialOutput && !input.hadToolActivity && isBlankTurnSessionDelta(blankTurnDelta)) {
        detail = [
          `${blankTurnDelta?.appendedUserMessageCount ?? 0} user message(s)`,
          `${blankTurnDelta?.appendedAssistantMessageCount ?? 0} assistant message(s)`,
          `${blankTurnDelta?.appendedToolResultMessageCount ?? 0} tool-result message(s)`,
        ].join(", ");
        input.onWarn?.("Prompt resolved with a blank user-only session delta", {
          operation: "run_agent.blank_turn_delta",
          chatJid: input.chatJid,
          detail,
          blankTurnDelta,
        });
      } else {
        const providerStoppedAfterToolUse = input.hadToolActivity
          && input.sawAssistantToolCallMessage
          && input.lastAssistantState?.stopReason === "stop"
          && !input.lastAssistantState?.hadTextContent;
        detail = [
          sawThinkingOnlyStop ? "provider stopped after emitting thinking without a final assistant reply" : null,
          providerStoppedAfterToolUse ? "provider stopped after tool use without a final assistant reply" : null,
          input.hadPartialOutput ? "partial output seen" : null,
          input.hadToolActivity ? "tool activity seen" : null,
          input.lastAssistantState?.stopReason ? `last stop reason: ${input.lastAssistantState.stopReason}` : null,
          blankTurnDelta ? `session delta: ${blankTurnDelta.appendedEntryCount} appended entries` : null,
        ].filter(Boolean).join(", ") || "no completed assistant turn was emitted";
        input.onWarn?.("Prompt resolved without a completed assistant reply", {
          operation: "run_agent.no_terminal_reply",
          chatJid: input.chatJid,
          detail,
          hadPartialOutput: input.hadPartialOutput,
          hadToolActivity: input.hadToolActivity,
          hadCompletedTurnOutput: input.hadCompletedTurnOutput,
          blankTurnDelta,
          ...input.getRunObservabilityDetails(input.runOptions),
        });
      }
      const isTerminalSideEffectCompletion = input.hadToolActivity
        && !input.hadToolFailure
        && !isBlankTurnSessionDelta(blankTurnDelta)
        && input.sawTerminalSideEffectToolActivity;
      const isDraftBackedSoftStopCompletion = input.hadToolActivity
        && input.hadPartialOutput
        && !input.hadToolFailureBeforeSoftStop
        && input.hadToolFailureAfterSoftStop
        && input.toolUseSoftStopApplied
        && !isBlankTurnSessionDelta(blankTurnDelta)
        && input.sawAssistantToolCallMessage
        && input.lastAssistantState?.stopReason === "stop"
        && !input.lastAssistantState.hadTextContent;
      const isToolOnlyCompletion = isTerminalSideEffectCompletion || isDraftBackedSoftStopCompletion;
      output = isToolOnlyCompletion
        ? {
          status: "tool_complete" as const,
          result: null,
          ...(input.finalUsage ? { usage: input.finalUsage as AgentOutput["usage"] } : {}),
        }
        : {
          status: "error",
          result: null,
          failureCategory: "no_terminal_output",
          error: `Prompt completed without emitting an assistant reply before finalization (${detail}).`,
        };

      try {
        const status = getAutoCompactionTokenStatusForSession(input.session, input.chatJid);
        if (status?.tokenStatus.tokenLimitReached) sawCompactionIntent = true;
      } catch (err) { debugSuppressedError(input.log, "Failed to estimate context tokens for compaction policy; skipping pressure check.", err); }
    } else {
      output = {
        status: "success",
        result: input.finalText || null,
        attachments: input.finalAttachments.length ? input.finalAttachments : undefined,
        ...(input.finalUsage ? { usage: input.finalUsage as AgentOutput["usage"] } : {}),
      };
    }
  }

  return {
    output: withAbortProvenance(output),
    snapshot: {
      hadToolActivity: input.hadToolActivity,
      hadPartialOutput: input.hadPartialOutput,
      hadCompletedTurnOutput: input.hadCompletedTurnOutput,
      hadTerminalTurnOutput: input.hadTerminalTurnOutput,
      compactionErrorMessage: input.compactionErrorMessage,
      sawCompactionIntent,
      sawAssistantToolCall: input.sawAssistantToolCallMessage,
      sawThinkingOnlyStop,
      onlyReadOnlyToolActivity: input.onlyReadOnlyToolActivity,
      canDisableToolsForRecovery: typeof (input.session as unknown as { getActiveToolNames?: unknown }).getActiveToolNames === "function"
        && typeof (input.session as unknown as { setActiveToolsByName?: unknown }).setActiveToolsByName === "function",
      hasUnresolvedToolExecution: input.hasUnresolvedToolExecution,
      hadToolFailure: input.hadToolFailure,
      sawTerminalSideEffectToolActivity: input.sawTerminalSideEffectToolActivity,
      needsToolFreeFinalization: input.hadToolActivity
        && input.sawAssistantToolCallMessage
        && input.lastAssistantState?.stopReason === "stop"
        && !input.lastAssistantState?.hadTextContent
        && !input.hasUnresolvedToolExecution
        && !input.hadToolFailure
        && !input.toolUseBudgetExceeded
        && typeof (input.session as unknown as { getActiveToolNames?: unknown }).getActiveToolNames === "function"
        && typeof (input.session as unknown as { setActiveToolsByName?: unknown }).setActiveToolsByName === "function",
      toolUseBudgetExceeded: input.toolUseBudgetExceeded,
      assistantToolUseMessageCount: input.assistantToolUseMessageCount,
      toolExecutionCount: input.toolExecutionCount,
      toolUseMessageBudget: input.toolUseMessageBudget,
    },
  };
}
