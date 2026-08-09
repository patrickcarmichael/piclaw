/**
 * automatic-recovery.ts – Shared mid-turn recovery policy for agent runs.
 */

import { getRecoveryPolicyConfig } from "../core/config.js";
import { isOrphanFunctionCallOutputError } from "../utils/provider-payload-errors.js";
import type { AgentFailureCategory, AgentRecoveryMetadata } from "./contracts.js";

export interface RetryBackoffSettings {
  enabled: boolean;
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface AutomaticRecoveryConfig {
  /** Legacy master switch for non-context automatic recovery. */
  enabled: boolean;
  /** Whether failures classified as transient may retry automatically. */
  transientRecoveryEnabled: boolean;
  /** Whether transient continuation attempts may use tools. */
  transientRecoveryToolsEnabled: boolean;
  maxAttempts: number;
  totalBudgetMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export type RecoveryStrategy = "retry" | "compact_then_retry" | "finalize";
export type RecoveryClassifier =
  | "disabled"
  | "budget_exhausted"
  | "auth_config"
  | "recovery_suppressed"
  | "stale_progress_watchdog"
  | "compaction_in_progress"
  | "session_corruption"
  | "non_recoverable"
  | "tool_activity"
  | "completed_turn_output"
  | "context_pressure"
  | "tool_history_pressure"
  | "mutation_repetition"
  | "thinking_only_stop"
  | "length_stop"
  | "transient"
  | "compaction_failure"
  | "unknown";

export interface RecoveryAttemptSnapshot {
  hadToolActivity: boolean;
  hadPartialOutput: boolean;
  hadCompletedTurnOutput?: boolean;
  hadTerminalTurnOutput?: boolean;
  compactionErrorMessage?: string | null;
  sawCompactionIntent?: boolean;
  sawAssistantToolCall?: boolean;
  sawThinkingOnlyStop?: boolean;
  onlyReadOnlyToolActivity?: boolean;
  canDisableToolsForRecovery?: boolean;
  /** True when a tool execution started without a matching terminal event. */
  hasUnresolvedToolExecution?: boolean;
  hadToolFailure?: boolean;
  sawTerminalSideEffectToolActivity?: boolean;
  needsToolFreeFinalization?: boolean;
  toolUseBudgetExceeded?: boolean;
  assistantToolUseMessageCount?: number;
  toolExecutionCount?: number;
  toolUseMessageBudget?: number;
}

export interface RecoveryDecision {
  recover: boolean;
  classifier: RecoveryClassifier;
  strategy: RecoveryStrategy | null;
  reason: string;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_TOTAL_BUDGET_MS = 360_000;
const DEFAULT_RETRY_BASE_DELAY_MS = 2_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 60_000;

export const DEFAULT_RETRY_BACKOFF_SETTINGS: Readonly<RetryBackoffSettings> = Object.freeze({
  enabled: true,
  maxRetries: DEFAULT_MAX_ATTEMPTS,
  baseDelayMs: DEFAULT_RETRY_BASE_DELAY_MS,
  maxDelayMs: DEFAULT_RETRY_MAX_DELAY_MS,
});

export const DEFAULT_AUTOMATIC_RECOVERY_CONFIG: Readonly<AutomaticRecoveryConfig> = Object.freeze({
  enabled: true,
  transientRecoveryEnabled: true,
  transientRecoveryToolsEnabled: false,
  maxAttempts: DEFAULT_MAX_ATTEMPTS,
  totalBudgetMs: DEFAULT_TOTAL_BUDGET_MS,
  baseDelayMs: DEFAULT_RETRY_BASE_DELAY_MS,
  maxDelayMs: DEFAULT_RETRY_MAX_DELAY_MS,
});

export function normalizeRetryBackoffSettings(settings?: Partial<RetryBackoffSettings> | null): RetryBackoffSettings {
  return {
    enabled: typeof settings?.enabled === "boolean" ? settings.enabled : DEFAULT_RETRY_BACKOFF_SETTINGS.enabled,
    maxRetries: Number.isFinite(settings?.maxRetries) && (settings?.maxRetries ?? 0) > 0
      ? Number(settings?.maxRetries)
      : DEFAULT_RETRY_BACKOFF_SETTINGS.maxRetries,
    baseDelayMs: Number.isFinite(settings?.baseDelayMs) && (settings?.baseDelayMs ?? 0) > 0
      ? Number(settings?.baseDelayMs)
      : DEFAULT_RETRY_BACKOFF_SETTINGS.baseDelayMs,
    maxDelayMs: Number.isFinite(settings?.maxDelayMs) && (settings?.maxDelayMs ?? 0) > 0
      ? Number(settings?.maxDelayMs)
      : DEFAULT_RETRY_BACKOFF_SETTINGS.maxDelayMs,
  };
}

export function getAutomaticRecoveryConfig(retrySettings?: Partial<RetryBackoffSettings> | null): Readonly<AutomaticRecoveryConfig> {
  const normalizedRetry = normalizeRetryBackoffSettings(retrySettings);
  const policy = getRecoveryPolicyConfig();
  return Object.freeze({
    // The SDK retry toggle controls provider/request retries. Piclaw turn recovery
    // is a separate safety mechanism for genuine context pressure and bounded
    // transient retries. Tool-history ceilings are terminal and require an
    // explicit continue instead of automatic compaction/replay.
    enabled: policy.automaticRecoveryEnabled,
    transientRecoveryEnabled: policy.transientRecoveryEnabled,
    transientRecoveryToolsEnabled: policy.transientRecoveryToolsEnabled,
    maxAttempts: policy.automaticRecoveryMaxAttempts > 0
      ? policy.automaticRecoveryMaxAttempts
      : normalizedRetry.maxRetries,
    totalBudgetMs: policy.automaticRecoveryTotalBudgetMs,
    baseDelayMs: normalizedRetry.baseDelayMs,
    maxDelayMs: normalizedRetry.maxDelayMs,
  });
}

export function getAutomaticRecoveryDelayMs(config: Pick<AutomaticRecoveryConfig, "baseDelayMs" | "maxDelayMs">, attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  const raw = Math.max(0, Math.round(config.baseDelayMs * 2 ** exponent));
  return Math.min(raw, Math.max(config.baseDelayMs, config.maxDelayMs));
}

export function isContextPressureFailure(errorText: string | null | undefined): boolean {
  if (!errorText) return false;
  return /context(?: window| length)?|maximum context length|context_length|token limit|too many tokens|prompt too long|reduce (?:the )?length|overflow|request too large/i.test(errorText);
}

export function isTransientFailure(errorText: string | null | undefined): boolean {
  if (!errorText) return false;
  return /timed out|timeout|before finalization|connection (?:error|ended|closed|lost)|websocket.*(?:closed|ended|1006)|fetch failed|socket hang up|econnreset|econnrefused|etimedout|enotfound|eai_again|getaddrinfo|dns lookup|502|503|504|temporary|temporarily unavailable|try again|rate limit|too many requests|\b429\b|overloaded|server error/i.test(errorText);
}

export function isLengthStopFailure(errorText: string | null | undefined): boolean {
  if (!errorText || isContextPressureFailure(errorText)) return false;
  return /finish[_ -]?reason\s*:?\s*length|stop\s*reason\s*:?\s*length|\bstopReason\s*:?\s*length|max(?:imum)? output (?:tokens?|length)|output token limit|hit (?:the )?(?:maximum )?output/i.test(errorText);
}

export function isProviderAuthConfigFailure(errorText: string | null | undefined): boolean {
  if (!errorText) return false;
  return /no api key for provider|no api key found|token refresh failed\s*:\s*401|authentication failed|credentials may have expired|re-authenticate|unauthorized|\b401\b|\b403\b|invalid.*api.*key|api.*key.*invalid|token.*expired|oauth.*expired|refresh.*token|provider login required|auth.*expired|missing provider credential|missing provider config|provider\.getApiKey is not a function/i.test(errorText);
}

export function isNonRecoverableFailure(errorText: string | null | undefined): boolean {
  if (!errorText) return false;
  return isOrphanFunctionCallOutputError(errorText)
    || /request was aborted|\baborted\b|no model selected|select a model|use \/model|use \/login|model not found|deployment.*not found|policy|safety|blocked by policy|invalid_request_error|malformed|schema|unsupported model|capability mismatch|permission denied|missing required file|file not found/i.test(errorText);
}

/**
 * Classify opaque provider/runtime errors once, at the boundary where only a
 * string is available. Downstream recovery and UI code consume the resulting
 * enum and never reinterpret assistant result prose.
 */
export function classifyOpaqueAgentFailure(errorText: string | null | undefined): AgentFailureCategory {
  const value = String(errorText || "").trim();
  if (!value) return "unknown";
  if (/stale-progress watchdog/i.test(value)) return "stalled_work";
  if (/cannot submit a prompt while compaction is in progress|compaction_in_progress/i.test(value)) return "compaction_in_progress";
  if (isOrphanFunctionCallOutputError(value)) return "session_corruption";
  if (isProviderAuthConfigFailure(value)) return "auth_config";
  if (isContextPressureFailure(value)) return "context_pressure";
  if (isLengthStopFailure(value)) return "output_limit";
  if (/rate limit|too many requests|\b429\b/i.test(value)) return "rate_limit";
  if (/request was aborted|\baborterror\b|\baborted\b/i.test(value)) return "aborted";
  if (/timed out|timeout/i.test(value)) return "timeout";
  if (/connection (?:error|ended|closed|lost)|websocket.*(?:closed|ended|1006)|fetch failed|socket hang up|econnreset|econnrefused|etimedout|enotfound|eai_again|getaddrinfo|dns lookup|502|503|504|temporary|temporarily unavailable|overloaded|server error/i.test(value)) return "network";
  if (/already processing/i.test(value)) return "already_processing";
  if (/no api provider/i.test(value)) return "provider_unavailable";
  if (isNonRecoverableFailure(value)) return "non_recoverable";
  return "provider";
}

export interface RecoveryDecisionInput {
  config: AutomaticRecoveryConfig;
  failureCategory: AgentFailureCategory;
  recoveryAttemptsUsed: number;
  mutationContainmentRecoveryAttemptsUsed?: number;
  elapsedMs: number;
  snapshot: RecoveryAttemptSnapshot;
}

export function formatRecoverySummary(recovery: AgentRecoveryMetadata | null | undefined): string | null {
  if (!recovery) return null;

  const attemptsUsed = Math.max(0, Number(recovery.attemptsUsed) || 0);
  const classifierSuffix = recovery.lastClassifier ? ` (${recovery.lastClassifier})` : "";
  const strategySuffix = Array.isArray(recovery.strategyHistory) && recovery.strategyHistory.length > 0
    ? ` via ${recovery.strategyHistory.join(" → ")}`
    : "";

  if (recovery.recovered) {
    return `Automatic recovery succeeded after ${attemptsUsed} attempt(s)${classifierSuffix}${strategySuffix}.`;
  }
  if (recovery.exhausted) {
    return `Automatic recovery exhausted after ${attemptsUsed} attempt(s)${classifierSuffix}${strategySuffix}.`;
  }
  if (attemptsUsed > 0) {
    return `Automatic recovery used ${attemptsUsed} attempt(s)${classifierSuffix}${strategySuffix}.`;
  }
  return null;
}

export function decideAutomaticRecovery(input: RecoveryDecisionInput): RecoveryDecision {
  const failureCategory = input.failureCategory;
  const toolHistoryPressure = Boolean(input.snapshot.toolUseBudgetExceeded);
  const transientFailure = failureCategory === "rate_limit"
    || failureCategory === "network"
    || failureCategory === "timeout";
  const nonRecoverableFailure = failureCategory === "aborted"
    || failureCategory === "session_corruption"
    || failureCategory === "non_recoverable";

  if (failureCategory === "stalled_work") {
    return {
      recover: false,
      classifier: "stale_progress_watchdog",
      strategy: null,
      reason: "Stale-progress watchdog already interrupted the active run; do not retry automatically.",
    };
  }

  if (failureCategory === "compaction_in_progress") {
    return {
      recover: false,
      classifier: "compaction_in_progress",
      strategy: null,
      reason: "Another physical processor owns active compaction; defer to its completion resume.",
    };
  }

  if (failureCategory === "session_corruption") {
    return {
      recover: false,
      classifier: "session_corruption",
      strategy: null,
      reason: "Provider rejected an orphan function-call output; unchanged automatic retries cannot repair the payload.",
    };
  }

  if (failureCategory === "mutation_repetition") {
    if (input.elapsedMs >= input.config.totalBudgetMs) {
      return {
        recover: false,
        classifier: "budget_exhausted",
        strategy: null,
        reason: "Automatic recovery budget exhausted.",
      };
    }
    if ((input.mutationContainmentRecoveryAttemptsUsed ?? 0) > 0) {
      return {
        recover: false,
        classifier: "mutation_repetition",
        strategy: null,
        reason: "Mutation containment terminal recovery already ran once; keep the branch quarantined for an explicit continuation.",
      };
    }
    if (!input.config.enabled || !input.config.transientRecoveryEnabled) {
      return {
        recover: false,
        classifier: "disabled",
        strategy: null,
        reason: "Mutation containment remains quarantined until an explicit tools-disabled continuation.",
      };
    }
    if (!input.snapshot.canDisableToolsForRecovery || input.snapshot.hasUnresolvedToolExecution) {
      return {
        recover: false,
        classifier: "mutation_repetition",
        strategy: null,
        reason: "Mutation containment cannot finalize automatically while tool control or execution settlement is unresolved.",
      };
    }
    return {
      recover: true,
      classifier: "mutation_repetition",
      strategy: "finalize",
      reason: "Repeated mutation was contained; requesting one bounded tools-disabled terminal explanation.",
    };
  }

  if (input.recoveryAttemptsUsed >= input.config.maxAttempts || input.elapsedMs >= input.config.totalBudgetMs) {
    return {
      recover: false,
      classifier: "budget_exhausted",
      strategy: null,
      reason: "Automatic recovery budget exhausted.",
    };
  }

  if (failureCategory === "output_limit") {
    return {
      recover: false,
      classifier: "length_stop",
      strategy: null,
      reason: "Provider hit the output length limit; preserve the partial answer and wait for an explicit continue.",
    };
  }

  if (failureCategory === "auth_config") {
    return {
      recover: false,
      classifier: "auth_config",
      strategy: null,
      reason: "Provider authentication/configuration failure; automatic recovery suppressed until credentials or login are fixed.",
    };
  }

  if (input.snapshot.compactionErrorMessage) {
    if (transientFailure) {
      return {
        recover: true,
        classifier: "compaction_failure",
        strategy: "retry",
        reason: "Transient compaction failure; retrying once without another compaction first.",
      };
    }
    return {
      recover: false,
      classifier: "compaction_failure",
      strategy: null,
      reason: failureCategory === "context_pressure" || input.snapshot.sawCompactionIntent
        ? "Compaction itself exceeded the context window; refusing to compact-and-retry again. Start a shorter branch or compact with a larger model."
        : "Compaction failed; refusing automatic retry to avoid re-entering the same failed compaction path.",
    };
  }

  if (input.snapshot.hadToolActivity) {
    if (input.snapshot.needsToolFreeFinalization) {
      if (!input.config.enabled || !input.config.transientRecoveryEnabled) {
        return { recover: false, classifier: "disabled", strategy: null, reason: "Tools-disabled finalization is disabled." };
      }
      if (!input.snapshot.canDisableToolsForRecovery) {
        return { recover: false, classifier: "tool_activity", strategy: null, reason: "Closing reply requires tool control that this session does not expose." };
      }
      return {
        recover: true,
        classifier: "transient",
        strategy: "finalize",
        reason: "Resolved tool work ended without a terminal assistant reply; requesting one tools-disabled closing reply.",
      };
    }
    // A terminal assistant reply is the only prior output that can make a
    // tool-bearing failure complete. Text emitted before a tool call is an
    // intermediate lead-in; if the provider later stops or times out, resume
    // from persisted tool results unless execution state is still unresolved.
    const hadTerminalTurnOutput = input.snapshot.hadTerminalTurnOutput
      ?? Boolean(input.snapshot.hadCompletedTurnOutput);
    if (hadTerminalTurnOutput) {
      return {
        recover: false,
        classifier: "completed_turn_output",
        strategy: null,
        reason: "Automatic recovery skipped because a terminal assistant reply already completed during the failed run.",
      };
    }
    if (input.snapshot.hadToolFailure && input.snapshot.sawTerminalSideEffectToolActivity) {
      return {
        recover: false,
        classifier: "tool_activity",
        strategy: null,
        reason: "A terminal side-effect tool completed after another tool failed; preserve the mixed outcome instead of converting it to recovery success.",
      };
    }
    if (failureCategory === "context_pressure" || input.snapshot.sawCompactionIntent) {
      return {
        recover: true,
        classifier: "context_pressure",
        strategy: "compact_then_retry",
        reason: "Failure looks context-related despite tool activity; compacting before retrying.",
      };
    }
    if (toolHistoryPressure) {
      return {
        recover: false,
        classifier: "tool_history_pressure",
        strategy: null,
        reason: "Turn exceeded the tool-history budget before finalization without context pressure; wait for an explicit continue instead of compacting.",
      };
    }
    if (nonRecoverableFailure) {
      return {
        recover: false,
        classifier: "non_recoverable",
        strategy: null,
        reason: "Failure classified as non-recoverable.",
      };
    }
    const transientCandidate = transientFailure
      || Boolean(input.snapshot.hadPartialOutput)
      || Boolean(input.snapshot.sawAssistantToolCall);
    if (transientCandidate) {
      if (!input.config.enabled || !input.config.transientRecoveryEnabled) {
        return {
          recover: false,
          classifier: "disabled",
          strategy: null,
          reason: "Transient automatic recovery is disabled.",
        };
      }
      const mustDisableTools = !input.config.transientRecoveryToolsEnabled
        || Boolean(input.snapshot.hasUnresolvedToolExecution);
      return {
        recover: true,
        classifier: "transient",
        strategy: "retry",
        reason: mustDisableTools
          ? "Transient failure after tool activity requires one ordinary tool-enabled continuation."
          : "Transient failure after resolved tool work; continuing from the persisted tool results with tools available.",
      };
    }
    return {
      recover: false,
      classifier: "tool_activity",
      strategy: null,
      reason: "Automatic recovery skipped because tool activity occurred and the failure was not safely continuable.",
    };
  }

  if (input.snapshot.hadCompletedTurnOutput) {
    return {
      recover: false,
      classifier: "completed_turn_output",
      strategy: null,
      reason: "Automatic recovery skipped because a completed assistant turn was already emitted during the failed run.",
    };
  }

  if (input.snapshot.sawThinkingOnlyStop && !input.snapshot.hadToolActivity) {
    if (input.recoveryAttemptsUsed === 0) {
      if (!input.config.enabled) {
        return {
          recover: false,
          classifier: "disabled",
          strategy: null,
          reason: "Automatic turn recovery is disabled.",
        };
      }
      return {
        recover: true,
        classifier: "thinking_only_stop",
        strategy: "retry",
        reason: "Provider stopped after emitting thinking only; retrying once before escalating.",
      };
    }
    if (input.snapshot.sawCompactionIntent) {
      return {
        recover: true,
        classifier: "context_pressure",
        strategy: "compact_then_retry",
        reason: "Thinking-only stop repeated under context pressure; compacting before one more retry.",
      };
    }
    return {
      recover: false,
      classifier: "thinking_only_stop",
      strategy: null,
      reason: "Provider stopped after emitting thinking only again after a bounded retry.",
    };
  }

  // Context pressure must be checked before tool-history/non-recoverable
  // classification. Tool-count exhaustion alone is terminal, but a turn that
  // independently crossed the model-aware threshold is recoverable by
  // compaction even when it reached the tool ceiling at the same time.
  if (failureCategory === "context_pressure" || input.snapshot.sawCompactionIntent) {
    return {
      recover: true,
      classifier: "context_pressure",
      strategy: "compact_then_retry",
      reason: "Failure looks context-related; compacting before retrying.",
    };
  }

  if (toolHistoryPressure) {
    return {
      recover: false,
      classifier: "tool_history_pressure",
      strategy: null,
      reason: "Turn exceeded the tool-history budget before finalization without context pressure; wait for an explicit continue instead of compacting.",
    };
  }

  if (nonRecoverableFailure) {
    return {
      recover: false,
      classifier: "non_recoverable",
      strategy: null,
      reason: "Failure classified as non-recoverable.",
    };
  }

  if (transientFailure || input.snapshot.hadPartialOutput || failureCategory === "unknown") {
    if (!input.config.enabled || !input.config.transientRecoveryEnabled) {
      return {
        recover: false,
        classifier: "disabled",
        strategy: null,
        reason: "Transient automatic recovery is disabled.",
      };
    }
    return {
      recover: true,
      classifier: "transient",
      strategy: "retry",
      reason: "Failure looks transient or interrupted mid-turn; retrying before compaction.",
    };
  }

  if (!input.config.enabled) {
    return {
      recover: false,
      classifier: "disabled",
      strategy: null,
      reason: "Automatic turn recovery is disabled.",
    };
  }

  return {
    recover: true,
    classifier: "unknown",
    strategy: "retry",
    reason: "Unknown mid-turn failure without context pressure; retrying without compaction.",
  };
}
