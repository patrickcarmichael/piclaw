import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { getRecoveryPolicyConfig } from "../core/config.js";
import type { RunAgentOptions } from "./contracts.js";
import { getRememberedActiveToolSubset, rememberActiveToolSubset } from "./active-tool-subset-memory.js";
import {
  getMutationQuarantine,
  setMutationQuarantine,
  type MutationQuarantine,
} from "./mutation-quarantine.js";
import {
  createMutationFingerprint,
  getSessionToolSafetyPolicy,
  type ToolSafetyClassification,
} from "./tool-safety-policy.js";
import { logToolStateTransition } from "./tool-state-transitions.js";

export interface AttemptToolBudgetState {
  toolUseBudgetExceeded: boolean;
  toolUseSoftStopApplied: boolean;
  finalizationReserveApplied: boolean;
  mutationQuarantined: boolean;
  hadToolFailureBeforeSoftStop: boolean;
  hadToolFailureAfterSoftStop: boolean;
  reservedToolExecutionCount: number;
}

export interface AttemptToolBudgetController {
  state: AttemptToolBudgetState;
  restoreToolBudgetGuard(): void;
  restoreToolBudgetSoftStop(): void;
  applyFinalizationReserve(): boolean;
  requestToolBudgetSoftStop(toolCallBlocks: Array<Record<string, unknown>>, assistantToolUseMessageCount: number): void;
  enforceCompletedExecutionBudget(): void;
  consumeToolExecutionEnd(toolCallId: unknown, isError: unknown): {
    wasBlockedByBudget: boolean;
    wasBlockedByMutation: boolean;
    toolSafetyPolicy: ToolSafetyClassification | null;
  };
}

export function createAttemptToolBudgetController(options: {
  session: AgentSession;
  chatJid: string;
  initialToolExecutionCount: number;
  toolUseMessageBudget: number;
  toolUseWarningThreshold: number;
  mutationRepetitionLimit?: number;
  runOptions: RunAgentOptions;
  onWarn?: (message: string, details: Record<string, unknown>) => void;
  getRunObservabilityDetails(runOptions: RunAgentOptions): Record<string, unknown>;
}): AttemptToolBudgetController {
  const state: AttemptToolBudgetState = {
    toolUseBudgetExceeded: false,
    toolUseSoftStopApplied: false,
    finalizationReserveApplied: false,
    mutationQuarantined: false,
    hadToolFailureBeforeSoftStop: false,
    hadToolFailureAfterSoftStop: false,
    reservedToolExecutionCount: options.initialToolExecutionCount,
  };
  const agent = (options.session as unknown as { agent?: AgentSession["agent"] }).agent;
  const originalBeforeToolCall = agent?.beforeToolCall;
  const reservedToolCallIds = new Set<string>();
  const blockedToolCallIds = new Set<string>();
  const blockedMutationToolCallIds = new Set<string>();
  const toolSafetyPolicyByCallId = new Map<string, ToolSafetyClassification>();
  const mutationReservations = new Map<string, { fingerprint: string; toolName: string }>();
  const pendingMutationCounts = new Map<string, number>();
  const successfulMutations = new Map<string, { count: number; toolName: string }>();
  const overflowMutationAttempts = new Map<string, { toolName: string }>();
  const pendingSoftStopToolCallIds = new Set<string>();
  let pendingSoftStopAnonymousToolCallCount = 0;
  let toolUseWarningEmitted = false;
  let toolUseSoftStopRequested = false;
  let softStopSavedToolNames: string[] | null = null;
  const configuredMutationLimit = Number(
    options.mutationRepetitionLimit ?? getRecoveryPolicyConfig().mutationRepetitionLimit,
  );
  const mutationRepetitionLimit = Number.isFinite(configuredMutationLimit)
    ? Math.min(64, Math.max(1, Math.floor(configuredMutationLimit)))
    : 2;
  let quarantine: MutationQuarantine | null = null;
  try {
    quarantine = getMutationQuarantine(options.chatJid);
  } catch {
    quarantine = null;
  }

  const disableToolSurface = (cause: string) => {
    const toolControl = options.session as unknown as {
      getActiveToolNames?: () => string[];
      setActiveToolsByName?: (toolNames: string[]) => void;
    };
    if (typeof toolControl.getActiveToolNames !== "function" || typeof toolControl.setActiveToolsByName !== "function") return;
    const previous = toolControl.getActiveToolNames();
    if (previous.length > 0) {
      softStopSavedToolNames = softStopSavedToolNames ?? previous;
      rememberActiveToolSubset(options.session, previous);
    }
    toolControl.setActiveToolsByName([]);
    logToolStateTransition({
      chatJid: options.chatJid,
      turnId: options.runOptions.turnId,
      phase: "attempt",
      cause,
      previous,
      next: [],
    });
  };

  const quarantineMutation = (
    trigger: MutationQuarantine["trigger"],
    toolName: string,
    fingerprint: string,
    successfulRepetitions: number,
  ) => {
    if (state.mutationQuarantined) return;
    const toolControl = options.session as unknown as { getActiveToolNames?: () => string[] };
    const activeToolNames = typeof toolControl.getActiveToolNames === "function"
      ? toolControl.getActiveToolNames()
      : [];
    const previousActiveToolNames = softStopSavedToolNames
      ?? (activeToolNames.length > 0
        ? activeToolNames
        : getRememberedActiveToolSubset(options.session) ?? []);
    try {
      quarantine = setMutationQuarantine(options.chatJid, {
        trigger,
        toolName,
        fingerprint,
        successfulRepetitions,
        previousActiveToolNames,
      });
    } catch (error) {
      options.onWarn?.("Failed to persist mutation repetition quarantine", {
        operation: "run_agent.mutation_quarantine_persist_failed",
        chatJid: options.chatJid,
        toolName,
        errorName: error instanceof Error ? error.name : "Error",
        ...options.getRunObservabilityDetails(options.runOptions),
      });
      return;
    }
    state.mutationQuarantined = true;
    disableToolSurface("mutation_repetition_quarantine");
    options.onWarn?.("Repeated successful mutation quarantined; disabling tools for terminal recovery", {
      operation: "run_agent.mutation_repetition_quarantine",
      chatJid: options.chatJid,
      trigger,
      toolName,
      fingerprint,
      successfulRepetitions,
      mutationRepetitionLimit,
      ...options.getRunObservabilityDetails(options.runOptions),
    });
  };

  const maybeQuarantineForToolBudget = () => {
    if (!state.toolUseBudgetExceeded || state.mutationQuarantined) return;
    let candidate: { fingerprint: string; count: number; toolName: string } | null = null;
    for (const [fingerprint, entry] of successfulMutations) {
      if (entry.count < 2 || (candidate && candidate.count >= entry.count)) continue;
      candidate = { fingerprint, count: entry.count, toolName: entry.toolName };
    }
    if (candidate) quarantineMutation("tool_budget", candidate.toolName, candidate.fingerprint, candidate.count);
  };

  if (quarantine) {
    state.mutationQuarantined = true;
    disableToolSurface("mutation_repetition_quarantine_resume");
  }

  const applyToolBudgetSoftStop = (assistantToolUseMessageCount: number) => {
    if (state.toolUseSoftStopApplied) return;
    state.toolUseSoftStopApplied = true;
    const toolControl = options.session as unknown as {
      getActiveToolNames?: () => string[];
      setActiveToolsByName?: (toolNames: string[]) => void;
    };
    if (typeof toolControl.getActiveToolNames === "function" && typeof toolControl.setActiveToolsByName === "function") {
      const previousToolNames = toolControl.getActiveToolNames();
      softStopSavedToolNames = softStopSavedToolNames ?? previousToolNames;
      rememberActiveToolSubset(options.session, previousToolNames);
      toolControl.setActiveToolsByName([]);
      logToolStateTransition({
        chatJid: options.chatJid,
        turnId: options.runOptions.turnId,
        phase: "attempt",
        cause: "tool_budget_soft_stop",
        previous: previousToolNames,
        next: [],
      });
      options.onWarn?.("Tool-use budget soft threshold reached; disabling tools to force terminal reply", {
        operation: "run_agent.tool_use_budget_soft_stop",
        chatJid: options.chatJid,
        assistantToolUseMessageCount,
        toolUseMessageBudget: options.toolUseMessageBudget,
        toolUseSoftStopThreshold: options.toolUseMessageBudget,
        ...options.getRunObservabilityDetails(options.runOptions),
      });
    } else {
      options.onWarn?.("Tool-use budget soft threshold reached but active tools could not be disabled", {
        operation: "run_agent.tool_use_budget_soft_stop_unavailable",
        chatJid: options.chatJid,
        assistantToolUseMessageCount,
        toolUseMessageBudget: options.toolUseMessageBudget,
        toolUseSoftStopThreshold: options.toolUseMessageBudget,
        ...options.getRunObservabilityDetails(options.runOptions),
      });
    }
  };

  const maybeApplyPendingToolBudgetSoftStop = (assistantToolUseMessageCount: number) => {
    if (!toolUseSoftStopRequested) return;
    if (pendingSoftStopToolCallIds.size > 0 || pendingSoftStopAnonymousToolCallCount > 0) return;
    applyToolBudgetSoftStop(assistantToolUseMessageCount);
  };

  const toolBudgetBeforeToolCall: NonNullable<AgentSession["agent"]["beforeToolCall"]> = async (context, signal) => {
    const prior = await originalBeforeToolCall?.(context, signal);
    if (prior?.block) return prior;
    if (state.finalizationReserveApplied) {
      return {
        block: true,
        reason: "Automatic recovery is in its finalization window. Return a terminal assistant reply without calling more tools.",
      };
    }
    if (state.mutationQuarantined) {
      blockedMutationToolCallIds.add(context.toolCall.id);
      return {
        block: true,
        reason: "Mutation safety quarantine is active. Return a terminal status without calling more tools.",
      };
    }

    const toolSafetyPolicy = getSessionToolSafetyPolicy(options.session, context.toolCall.name, context.args);
    if (toolSafetyPolicy) toolSafetyPolicyByCallId.set(context.toolCall.id, toolSafetyPolicy);
    let mutationReservation: { fingerprint: string; toolName: string } | null = null;
    if (toolSafetyPolicy?.effect === "mutation" && toolSafetyPolicy.repetition === "guard") {
      const toolName = context.toolCall.name;
      const args = context.args && typeof context.args === "object" && !Array.isArray(context.args)
        ? context.args as Record<string, unknown>
        : {};
      const fingerprint = createMutationFingerprint(toolName, args);
      const successfulCount = successfulMutations.get(fingerprint)?.count ?? 0;
      const pendingCount = pendingMutationCounts.get(fingerprint) ?? 0;
      if (successfulCount + pendingCount >= mutationRepetitionLimit) {
        blockedMutationToolCallIds.add(context.toolCall.id);
        overflowMutationAttempts.set(fingerprint, { toolName });
        if (successfulCount >= mutationRepetitionLimit) {
          quarantineMutation("repetition_limit", toolName, fingerprint, successfulCount);
        }
        return state.mutationQuarantined
          ? {
            block: true,
            reason: `Tool ${toolName} already completed the same mutation successfully ${mutationRepetitionLimit} times. The next matching call was blocked and tools are disabled; return a terminal status.`,
          }
          : {
            block: true,
            reason: `Tool ${toolName} has ${successfulCount + pendingCount} identical successful or in-flight mutations already admitted. This matching call was blocked before execution; wait for admitted calls to settle and return a terminal status.`,
          };
      }
      mutationReservation = { fingerprint, toolName };
    }

    if (!toolUseWarningEmitted && state.reservedToolExecutionCount >= options.toolUseWarningThreshold) {
      toolUseWarningEmitted = true;
      options.onWarn?.("Tool-use budget warning threshold reached", {
        operation: "run_agent.tool_use_budget_warning",
        chatJid: options.chatJid,
        reservedToolExecutionCount: state.reservedToolExecutionCount,
        toolUseBudget: options.toolUseMessageBudget,
        toolUseWarningThreshold: options.toolUseWarningThreshold,
        toolName: context.toolCall.name,
        ...options.getRunObservabilityDetails(options.runOptions),
      });
    }
    if (state.reservedToolExecutionCount >= options.toolUseMessageBudget) {
      blockedToolCallIds.add(context.toolCall.id);
      state.toolUseBudgetExceeded = true;
      maybeQuarantineForToolBudget();
      return {
        block: true,
        reason: `Per-turn tool execution budget exhausted (${options.toolUseMessageBudget}/${options.toolUseMessageBudget}). Ask the user to continue before calling more tools.`,
      };
    }
    state.reservedToolExecutionCount += 1;
    reservedToolCallIds.add(context.toolCall.id);
    if (mutationReservation) {
      mutationReservations.set(context.toolCall.id, mutationReservation);
      pendingMutationCounts.set(
        mutationReservation.fingerprint,
        (pendingMutationCounts.get(mutationReservation.fingerprint) ?? 0) + 1,
      );
    }
    return prior;
  };
  if (agent) agent.beforeToolCall = toolBudgetBeforeToolCall;

  return {
    state,
    restoreToolBudgetGuard() {
      if (agent?.beforeToolCall === toolBudgetBeforeToolCall) agent.beforeToolCall = originalBeforeToolCall;
    },
    restoreToolBudgetSoftStop() {
      if (state.mutationQuarantined || !softStopSavedToolNames) return;
      const toolControl = options.session as unknown as { setActiveToolsByName?: (toolNames: string[]) => void };
      if (typeof toolControl.setActiveToolsByName === "function") {
        toolControl.setActiveToolsByName(softStopSavedToolNames);
        logToolStateTransition({
          chatJid: options.chatJid,
          turnId: options.runOptions.turnId,
          phase: "attempt",
          cause: "tool_budget_restore",
          previous: [],
          next: softStopSavedToolNames,
          restored: true,
        });
      }
      softStopSavedToolNames = null;
    },
    applyFinalizationReserve() {
      if (state.finalizationReserveApplied) return false;
      state.finalizationReserveApplied = true;
      const toolControl = options.session as unknown as {
        getActiveToolNames?: () => string[];
        setActiveToolsByName?: (toolNames: string[]) => void;
      };
      if (typeof toolControl.getActiveToolNames === "function" && typeof toolControl.setActiveToolsByName === "function") {
        softStopSavedToolNames = softStopSavedToolNames ?? toolControl.getActiveToolNames();
        rememberActiveToolSubset(options.session, softStopSavedToolNames);
        toolControl.setActiveToolsByName([]);
        logToolStateTransition({
          chatJid: options.chatJid,
          turnId: options.runOptions.turnId,
          phase: "attempt",
          cause: "recovery_finalization_reserve",
          previous: softStopSavedToolNames,
          next: [],
        });
      }
      return true;
    },
    requestToolBudgetSoftStop(toolCallBlocks, assistantToolUseMessageCount) {
      if (toolUseSoftStopRequested || assistantToolUseMessageCount < options.toolUseMessageBudget) return;
      toolUseSoftStopRequested = true;
      for (const block of toolCallBlocks) {
        const id = typeof block.id === "string" && block.id.trim() ? block.id : null;
        if (id) pendingSoftStopToolCallIds.add(id);
        else pendingSoftStopAnonymousToolCallCount += 1;
      }
      maybeApplyPendingToolBudgetSoftStop(assistantToolUseMessageCount);
    },
    enforceCompletedExecutionBudget() {
      state.toolUseBudgetExceeded = true;
      // Executions already admitted by beforeToolCall may be a legitimate
      // parallel batch. Let them settle, but prevent every new execution now
      // instead of waiting for an arbitrary count of assistant tool messages.
      applyToolBudgetSoftStop(options.toolUseMessageBudget);
      maybeQuarantineForToolBudget();
    },
    consumeToolExecutionEnd(toolCallId, isError) {
      const normalizedToolCallId = typeof toolCallId === "string" ? toolCallId : null;
      const wasBlockedByBudget = normalizedToolCallId ? blockedToolCallIds.delete(normalizedToolCallId) : false;
      const wasBlockedByMutation = normalizedToolCallId ? blockedMutationToolCallIds.delete(normalizedToolCallId) : false;
      const toolSafetyPolicy = normalizedToolCallId
        ? toolSafetyPolicyByCallId.get(normalizedToolCallId) ?? null
        : null;
      if (normalizedToolCallId) {
        toolSafetyPolicyByCallId.delete(normalizedToolCallId);
        reservedToolCallIds.delete(normalizedToolCallId);
        const reservation = mutationReservations.get(normalizedToolCallId);
        if (reservation) {
          mutationReservations.delete(normalizedToolCallId);
          const pendingCount = Math.max(0, (pendingMutationCounts.get(reservation.fingerprint) ?? 1) - 1);
          if (pendingCount > 0) pendingMutationCounts.set(reservation.fingerprint, pendingCount);
          else pendingMutationCounts.delete(reservation.fingerprint);
          if (isError === false) {
            const successful = successfulMutations.get(reservation.fingerprint);
            const successfulCount = (successful?.count ?? 0) + 1;
            successfulMutations.set(reservation.fingerprint, {
              count: successfulCount,
              toolName: reservation.toolName,
            });
            if (overflowMutationAttempts.has(reservation.fingerprint) && successfulCount >= mutationRepetitionLimit) {
              quarantineMutation("repetition_limit", reservation.toolName, reservation.fingerprint, successfulCount);
            }
          }
          if ((pendingMutationCounts.get(reservation.fingerprint) ?? 0) === 0
            && (successfulMutations.get(reservation.fingerprint)?.count ?? 0) < mutationRepetitionLimit) {
            overflowMutationAttempts.delete(reservation.fingerprint);
          }
        }
      }
      if (typeof normalizedToolCallId === "string" && pendingSoftStopToolCallIds.delete(normalizedToolCallId)) {
        // matched the threshold-crossing tool-use message
      } else if (pendingSoftStopAnonymousToolCallCount > 0) {
        pendingSoftStopAnonymousToolCallCount -= 1;
      }
      maybeApplyPendingToolBudgetSoftStop(options.toolUseMessageBudget);
      if (isError === true && !wasBlockedByMutation) {
        if (state.toolUseSoftStopApplied) state.hadToolFailureAfterSoftStop = true;
        else state.hadToolFailureBeforeSoftStop = true;
      }
      maybeQuarantineForToolBudget();
      return { wasBlockedByBudget, wasBlockedByMutation, toolSafetyPolicy };
    },
  };
}
