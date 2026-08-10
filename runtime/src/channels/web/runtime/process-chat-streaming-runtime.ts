import type { AgentEventEmitter } from "../sse/agent-events.js";
import { createAgentEventEmitter, createStreamingEventHandler } from "../sse/agent-events.js";
import { createAgentProfileBuilder } from "../agent/agent-utils.js";
import { resolveAvatarUrl } from "../media/avatar-service.js";
import type { WebChannelLike } from "../core/web-channel-contracts.js";
import { getAgentRuntimeConfig, getIdentityConfig, getPersistThinkingMaxChars, isPersistThinkingEnabled } from "../../../core/config.js";
import { heartbeatTrackedPhase } from "../../../runtime/progress-watchdog.js";
import { storeThinkingContent } from "../../../db/messages.js";
import { safeTruncateUtf16 } from "../../../utils/safe-truncate.js";
import { createLogger, debugSuppressedError } from "../../../utils/logger.js";

const log = createLogger("web.runtime.process-chat-streaming");

export interface ProcessChatRecoverySummary {
  attemptsUsed?: number;
  recovered?: boolean;
  exhausted?: boolean;
  lastClassifier?: string | null;
}

export interface ProcessChatStreamingRuntime {
  turnId: string;
  emitter: AgentEventEmitter;
  trackedEmitter: AgentEventEmitter;
  streamingHandler(event: Record<string, unknown>): void;
  clearCommittedDraft(): void;
  timeoutMs: number;
  state: {
    lastRecoveryMeta: ProcessChatRecoverySummary | null;
    sawCompactionEvent: boolean;
    sawRecoveryEvent: boolean;
    lastCompactionErrorMessage: string | null;
    lastCompactionSuppressed: boolean;
    lastRecoveryOutcome: string | null;
  };
  getActiveRecoveryIntent(): "compaction" | "recovery" | null;
  buildAgentTimingBlock(usage?: unknown): Record<string, unknown>;
  buildThinkingRefBlocks(): Array<Record<string, unknown>>;
  persistThinkingForRow(messageRowId: number | null): void;
}

export async function createProcessChatStreamingRuntime(options: {
  channel: WebChannelLike;
  chatJid: string;
  agentId: string;
  threadId: string;
  turnId: string;
  operationId?: string | null;
  runStartedAt: string;
  sourceMessageId: string | null;
  withResolvedToolStatusHints(chatJid: string, payload: Record<string, unknown>): Record<string, unknown>;
  withAgentStatusProgressMetadata(payload: Record<string, unknown>, previous: Record<string, unknown> | null): Record<string, unknown>;
}): Promise<ProcessChatStreamingRuntime> {
  const { channel, chatJid, agentId, turnId, threadId } = options;
  const shouldPersistThinking = isPersistThinkingEnabled() && !chatJid.startsWith("dream:");
  let pendingThinkingText = "";
  let pendingThinkingLines = 0;
  let pendingThinkingDurationMs = 0;
  let currentModel: string | null = null;
  const identity = getIdentityConfig();
  const withAgentProfile = createAgentProfileBuilder(chatJid, identity.assistantName, resolveAvatarUrl("agent", identity.assistantAvatar), identity.userName || null, resolveAvatarUrl("user", identity.userAvatar), identity.userAvatarBackground || null);
  const emitter = createAgentEventEmitter(channel, withAgentProfile);
  const trackedEmitter: AgentEventEmitter = {
    ...emitter,
    status: (payload) => {
      const isToolStatus = payload?.type === "tool_call" || payload?.type === "tool_status";
      const toolName = typeof payload?.tool_name === "string" ? payload.tool_name.trim() : "";
      let nextPayload = isToolStatus && toolName ? options.withResolvedToolStatusHints(chatJid, payload) : payload;
      nextPayload = {
        ...nextPayload,
        operation_authority: options.operationId ? "durable" : "legacy",
        ...(options.operationId ? { operation_id: options.operationId } : {}),
      };
      nextPayload = options.withAgentStatusProgressMetadata(nextPayload, channel.getAgentStatus(chatJid));
      channel.updateAgentStatus(chatJid, nextPayload);
      emitter.status(nextPayload);
    },
    modelChanged: (payload) => {
      const nextModel = typeof payload?.model === "string" ? payload.model.trim() : "";
      if (nextModel) currentModel = nextModel;
      emitter.modelChanged(payload);
    },
  };

  const liveThinkingLevelLabels = new Map<string, string>();
  try {
    const modelState = await channel.agentPool.getAvailableModels(chatJid);
    if (shouldPersistThinking) currentModel = modelState.current ?? null;
    modelState.available_thinking_levels.forEach((level, index) => liveThinkingLevelLabels.set(level, modelState.available_thinking_level_labels[index] ?? level));
    if (modelState.thinking_level && modelState.thinking_level_label) liveThinkingLevelLabels.set(modelState.thinking_level, modelState.thinking_level_label);
  } catch (error) {
    debugSuppressedError(log, "Failed to prepare model/thinking metadata.", error, { operation: "process_chat.init_model_metadata", chatJid });
  }

  const state: ProcessChatStreamingRuntime["state"] = { lastRecoveryMeta: null, sawCompactionEvent: false, sawRecoveryEvent: false, lastCompactionErrorMessage: null, lastCompactionSuppressed: false, lastRecoveryOutcome: null };
  const baseHandler = createStreamingEventHandler({
    emitter: trackedEmitter, agentId, threadId, turnId,
    formatThinkingLevel: (level) => liveThinkingLevelLabels.get(level) ?? level,
    thoughtPreviewLines: 8, draftPreviewLines: 8, previewMaxCharsPerLine: 160,
    // Full preview capture is runtime state, not a presentation preference.
    // Always emit deltas so collapsing a panel cannot create gaps that later
    // expansion or reconnect is unable to recover.
    includeThoughtFull: () => true,
    includeDraftFull: () => true,
    onThoughtBuffer: (text, lines) => channel.updateThoughtBuffer(turnId, text, lines),
    onThinkingComplete: (text, _softLines, durationMs) => {
      const realLines = text ? text.split("\n").length : 0;
      if (!shouldPersistThinking || !text) return;
      pendingThinkingText = pendingThinkingText ? `${pendingThinkingText}\n\n---\n\n${text}` : text;
      pendingThinkingLines += realLines;
      pendingThinkingDurationMs += durationMs;
    },
    onDraftBuffer: (text, lines) => channel.updateDraftBuffer(turnId, text, lines),
  });
  const streamingHandler = (event: Record<string, unknown>) => {
    const type = typeof event?.type === "string" ? event.type : "";
    if (type === "message_update") heartbeatTrackedPhase(chatJid, "streaming", { eventType: type });
    else if (type === "tool_execution_start" || type === "tool_execution_update" || type === "tool_execution_end") heartbeatTrackedPhase(chatJid, "tool_execution", { eventType: type, toolName: event.toolName });
    else if (type === "compaction_start") heartbeatTrackedPhase(chatJid, "preprompt_compaction", { eventType: type });
    else if (type === "compaction_end") heartbeatTrackedPhase(chatJid, "prompt", { eventType: type });
    else if (type === "recovery_start" || type === "recovery_end") heartbeatTrackedPhase(chatJid, "recovery", { eventType: type });
    if (type === "compaction_start" || type === "compaction_end") state.sawCompactionEvent = true;
    if (type === "compaction_end" || type === "compaction_suppressed") {
      const detail = typeof event.errorMessage === "string" ? event.errorMessage.trim() : "";
      if (detail) state.lastCompactionErrorMessage = detail;
      if (type === "compaction_suppressed") state.lastCompactionSuppressed = true;
    }
    if (type === "recovery_start" || type === "recovery_end") state.sawRecoveryEvent = true;
    if (type === "recovery_start") {
      pendingThinkingText = ""; pendingThinkingLines = 0; pendingThinkingDurationMs = 0;
    }
    if (type === "recovery_end") state.lastRecoveryOutcome = typeof event.outcome === "string" ? event.outcome : null;
    baseHandler(event as never);
  };
  const clearCommittedDraft = () => {
    channel.updateDraftBuffer(turnId, "", 0);
    trackedEmitter.draft({ thread_id: threadId, agent_id: agentId, turn_id: turnId, text: "", total_lines: 0, kind: "draft", mode: "replace" });
    trackedEmitter.draftDelta({ thread_id: threadId, agent_id: agentId, turn_id: turnId, delta: "", reset: true });
  };
  trackedEmitter.status({ thread_id: threadId, agent_id: agentId, type: "thinking", title: "Thinking...", turn_id: turnId });
  const runtimeConfig = getAgentRuntimeConfig();
  const timeoutMs = channel.sse.clients.size > 0 ? runtimeConfig.timeoutMs : (runtimeConfig.backgroundTimeoutMs > 0 ? runtimeConfig.backgroundTimeoutMs : runtimeConfig.timeoutMs);
  return {
    turnId, emitter, trackedEmitter, streamingHandler, clearCommittedDraft, timeoutMs, state,
    getActiveRecoveryIntent: () => {
      const status = channel.getAgentStatus(chatJid); const key = status?.intent_key ?? status?.intentKey;
      return status?.type === "intent" && (key === "compaction" || key === "recovery") ? key : null;
    },
    buildAgentTimingBlock: (usage) => {
      const completedAt = new Date().toISOString(); const record = usage && typeof usage === "object" ? usage as Record<string, unknown> : {};
      const read = (...keys: string[]) => { for (const key of keys) { const value = Number(record[key]); if (Number.isFinite(value) && value >= 0) return value; } return 0; };
      const input = read("input", "inputTokens", "promptTokens"), output = read("output", "outputTokens", "completionTokens"), reasoning = read("reasoning", "reasoningTokens", "reasoning_tokens"), cacheRead = read("cacheRead", "cacheReadTokens"), cacheWrite = read("cacheWrite", "cacheWriteTokens"), explicit = read("totalTokens", "total", "total_tokens");
      const total = explicit || input + output + cacheRead + cacheWrite; const cost = record.cost && typeof record.cost === "object" ? Number((record.cost as Record<string, unknown>).total) : Number(record.costTotal ?? record.cost_total);
      const normalized = total || input || output || reasoning || cacheRead || cacheWrite ? { input_tokens: input, output_tokens: output, reasoning_tokens: reasoning, cache_read_tokens: cacheRead, cache_write_tokens: cacheWrite, total_tokens: total, ...(Number.isFinite(cost) && cost > 0 ? { cost_total: cost } : {}) } : null;
      return { type: "agent_timing", started_at: options.runStartedAt, completed_at: completedAt, duration_ms: Math.max(0, Date.parse(completedAt) - Date.parse(options.runStartedAt)), turn_id: turnId, source_message_id: options.sourceMessageId, ...(normalized ? { usage: normalized } : {}) };
    },
    buildThinkingRefBlocks: () => shouldPersistThinking && pendingThinkingText ? [{ type: "thinking_ref", lines: pendingThinkingLines, duration_ms: pendingThinkingDurationMs }] : [],
    persistThinkingForRow: (rowId) => {
      if (!shouldPersistThinking || !pendingThinkingText || !rowId || rowId <= 0) return;
      const max = getPersistThinkingMaxChars(); const truncated = pendingThinkingText.length > max; const text = truncated ? safeTruncateUtf16(pendingThinkingText, max) : pendingThinkingText;
      storeThinkingContent(String(rowId), text, pendingThinkingLines, pendingThinkingDurationMs, currentModel ?? undefined, truncated);
      pendingThinkingText = ""; pendingThinkingLines = 0; pendingThinkingDurationMs = 0;
    },
  };
}
