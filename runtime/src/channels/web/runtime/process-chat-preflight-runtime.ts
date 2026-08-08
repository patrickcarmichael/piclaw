export interface BrowserObservabilityContext {
  userId?: string;
  sessionId?: string;
  clientId?: string;
}
import type { WebChannelLike } from "../core/web-channel-contracts.js";
import { getPrePromptCompactionForegroundMs } from "../../../core/config.js";
import {
  beginChatPreflight,
  blockChatOperation,
  clearChatPreflight,
  promoteChatOperation,
  promoteChatPreflightToInflight,
  type ChatOperationOwner,
  type ChatOperationState,
} from "../../../db.js";
import { isCompactionCancellationError, maybeAutoCompactSessionBeforePrompt } from "../../../agent-pool/compaction.js";
import { beginTrackedPhase, endTrackedPhase, heartbeatTrackedPhase } from "../../../runtime/progress-watchdog.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("web.runtime.process-chat-preflight");
const durablePreflightAttempts = new Set<string>();

function withMetadata(details: Record<string, unknown>, turnId: string, browser?: BrowserObservabilityContext): Record<string, unknown> {
  return { ...details, turnId, ...(browser?.userId ? { userId: browser.userId } : {}), ...(browser?.sessionId ? { sessionId: browser.sessionId } : {}), ...(browser?.clientId ? { clientId: browser.clientId } : {}) };
}

interface ProcessChatPreflightDeps {
  beginChatPreflight: typeof beginChatPreflight;
  clearChatPreflight: typeof clearChatPreflight;
  promoteChatPreflightToInflight: typeof promoteChatPreflightToInflight;
  maybeAutoCompactSessionBeforePrompt: typeof maybeAutoCompactSessionBeforePrompt;
  getForegroundMs: typeof getPrePromptCompactionForegroundMs;
}

const defaultDeps: ProcessChatPreflightDeps = {
  beginChatPreflight,
  clearChatPreflight,
  promoteChatPreflightToInflight,
  maybeAutoCompactSessionBeforePrompt,
  getForegroundMs: getPrePromptCompactionForegroundMs,
};

export async function runProcessChatPreflight(options: {
  channel: WebChannelLike;
  chatJid: string;
  agentId: string;
  message: { id: string; timestamp: string };
  prevCursor: string;
  effectiveThreadRootId: number | null;
  turnId: string;
  runStartedAt: string;
  browserObservability?: BrowserObservabilityContext;
  streamingHandler(event: Record<string, unknown>): void;
  compactionState: { lastCompactionErrorMessage: string | null; lastCompactionSuppressed: boolean };
  enqueueResume(threadRootId: number | undefined): void;
  deps?: Partial<ProcessChatPreflightDeps>;
}): Promise<"continue" | "deferred"> {
  const { channel, chatJid } = options;
  const deps = { ...defaultDeps, ...options.deps };
  const owner = {
    prevTs: options.prevCursor,
    messageId: options.message.id,
    startedAt: options.runStartedAt,
  };

  if (!deps.beginChatPreflight(chatJid, owner)) {
    log.info("Deferring chat processor to active preflight owner", withMetadata({
      operation: "process_chat.preflight_owned",
      chatJid,
      messageId: options.message.id,
    }, options.turnId, options.browserObservability));
    return "deferred";
  }

  const releaseOwner = (): boolean => {
    const released = deps.clearChatPreflight(chatJid, owner);
    if (released) endTrackedPhase(chatJid);
    return released;
  };

  if (typeof channel.agentPool.getSessionForIntrospection !== "function") {
    const promoted = deps.promoteChatPreflightToInflight(chatJid, options.message.timestamp, owner);
    if (!promoted) {
      log.info("Preflight ownership changed before inflight promotion", withMetadata({
        operation: "process_chat.preflight_ownership_lost",
        chatJid,
        messageId: options.message.id,
      }, options.turnId, options.browserObservability));
      return "deferred";
    }
    return "continue";
  }

  const rotateIfNeeded = async (source: "foreground" | "background"): Promise<boolean> => {
    const detail = options.compactionState.lastCompactionErrorMessage?.trim();
    if (!detail || isCompactionCancellationError(detail)) return false;
    const result = await channel.agentPool.emergencyRotateSession(chatJid, detail);
    log[result.status === "success" ? "info" : "warn"]("Emergency rotation after pre-prompt compaction", withMetadata({ operation: result.status === "success" ? "process_chat.preprompt_compaction_emergency_rotate_success" : "process_chat.preprompt_compaction_emergency_rotate_failed", chatJid, source, suppressed: options.compactionState.lastCompactionSuppressed, reason: result.message, archivePath: result.archivePath ?? null, newSessionFile: result.newSessionFile ?? null }, options.turnId, options.browserObservability));
    return result.status === "success";
  };

  let session;
  try {
    session = await channel.agentPool.getSessionForIntrospection(chatJid);
  } catch (error) {
    releaseOwner();
    throw error;
  }

  beginTrackedPhase(chatJid, "preprompt_compaction", { source: "web.process_chat.preflight", messageId: options.message.id });
  const compactionPromise = deps.maybeAutoCompactSessionBeforePrompt(session, chatJid, {
    onInfo: (message, details) => log.info(message, withMetadata(details || {}, options.turnId, options.browserObservability)),
    onWarn: (message, details) => log.warn(message, withMetadata(details || {}, options.turnId, options.browserObservability)),
  }, options.streamingHandler);

  try {
    const outcome = await Promise.race([
      compactionPromise.then(() => "done" as const),
      Bun.sleep(deps.getForegroundMs()).then(() => "defer" as const),
    ]);
    if (outcome === "defer") {
      void compactionPromise
        .then(() => rotateIfNeeded("background"))
        .catch((error) => log.warn("Background pre-prompt compaction failed before chat resume", withMetadata({ operation: "process_chat.preprompt_compaction_deferred_failed", chatJid, messageId: options.message.id, err: error }, options.turnId, options.browserObservability)))
        .finally(() => {
          if (releaseOwner()) options.enqueueResume(options.effectiveThreadRootId ?? undefined);
        });
      return "deferred";
    }
  } catch (error) {
    releaseOwner();
    throw error;
  }

  if (await rotateIfNeeded("foreground")) {
    if (releaseOwner()) options.enqueueResume(options.effectiveThreadRootId ?? undefined);
    return "deferred";
  }

  const promoted = deps.promoteChatPreflightToInflight(chatJid, options.message.timestamp, owner);
  if (!promoted) {
    log.info("Preflight ownership changed before inflight promotion", withMetadata({
      operation: "process_chat.preflight_ownership_lost",
      chatJid,
      messageId: options.message.id,
    }, options.turnId, options.browserObservability));
    return "deferred";
  }
  heartbeatTrackedPhase(chatJid, "prompt", { eventType: "preflight_promoted" });
  return "continue";
}


interface DurableOperationPreflightDeps {
  promoteChatOperation: typeof promoteChatOperation;
  blockChatOperation: typeof blockChatOperation;
  maybeAutoCompactSessionBeforePrompt: typeof maybeAutoCompactSessionBeforePrompt;
  getForegroundMs: typeof getPrePromptCompactionForegroundMs;
}

const durableOperationPreflightDeps: DurableOperationPreflightDeps = {
  promoteChatOperation,
  blockChatOperation,
  maybeAutoCompactSessionBeforePrompt,
  getForegroundMs: getPrePromptCompactionForegroundMs,
};

function operationOwner(operation: ChatOperationState): ChatOperationOwner {
  return {
    operationId: operation.operationId,
    sourceSeq: operation.sourceSeq,
    phase: operation.phase,
    generation: operation.generation,
  };
}

/** Run pre-prompt work for one durable accepted web-message operation. */
export async function runDurableOperationPreflight(options: {
  channel: WebChannelLike;
  chatJid: string;
  agentId: string;
  message: { id: string; timestamp: string };
  operation: ChatOperationState;
  effectiveThreadRootId: number | null;
  turnId: string;
  browserObservability?: BrowserObservabilityContext;
  streamingHandler(event: Record<string, unknown>): void;
  compactionState: { lastCompactionErrorMessage: string | null; lastCompactionSuppressed: boolean };
  enqueueResume(threadRootId: number | undefined): void;
  deps?: Partial<DurableOperationPreflightDeps>;
}): Promise<{ status: "continue"; operation: ChatOperationState } | { status: "deferred" }> {
  const deps = { ...durableOperationPreflightDeps, ...options.deps };
  let operation = options.operation;
  if (operation.phase === "running") return { status: "continue", operation };
  if (operation.phase !== "pending" && operation.phase !== "preflight") return { status: "deferred" };

  if (operation.phase === "pending") {
    const promoted = deps.promoteChatOperation(options.chatJid, operationOwner(operation), "preflight");
    if (promoted.status !== "applied") return { status: "deferred" };
    operation = promoted.operation;
  }

  const block = (): void => {
    const blocked = deps.blockChatOperation(options.chatJid, operationOwner(operation));
    if (blocked.status === "applied") endTrackedPhase(options.chatJid);
  };
  const promoteRunning = (): ChatOperationState | null => {
    const promoted = deps.promoteChatOperation(options.chatJid, operationOwner(operation), "running");
    return promoted.status === "applied" ? promoted.operation : null;
  };

  if (typeof options.channel.agentPool.getSessionForIntrospection !== "function") {
    const running = promoteRunning();
    return running ? { status: "continue", operation: running } : { status: "deferred" };
  }

  const attemptKey = `${operation.operationId}:${operation.generation}`;
  if (durablePreflightAttempts.has(attemptKey)) return { status: "deferred" };
  durablePreflightAttempts.add(attemptKey);
  let backgroundOwnsAttempt = false;

  try {
  const rotateIfNeeded = async (source: "foreground" | "background"): Promise<boolean> => {
    const detail = options.compactionState.lastCompactionErrorMessage?.trim();
    if (!detail || isCompactionCancellationError(detail)) return false;
    const result = await options.channel.agentPool.emergencyRotateSession(options.chatJid, detail);
    log[result.status === "success" ? "info" : "warn"]("Emergency rotation after durable pre-prompt compaction", withMetadata({
      operation: result.status === "success"
        ? "process_chat.operation_preflight_emergency_rotate_success"
        : "process_chat.operation_preflight_emergency_rotate_failed",
      chatJid: options.chatJid,
      source,
      reason: result.message,
    }, options.turnId, options.browserObservability));
    return result.status === "success";
  };

  let session;
  try {
    session = await options.channel.agentPool.getSessionForIntrospection(options.chatJid);
  } catch (error) {
    block();
    throw error;
  }

  beginTrackedPhase(options.chatJid, "preprompt_compaction", {
    source: "web.process_chat.durable_operation_preflight",
    messageId: options.message.id,
  });
  const compactionPromise = deps.maybeAutoCompactSessionBeforePrompt(session, options.chatJid, {
    onInfo: (message, details) => log.info(message, withMetadata(details || {}, options.turnId, options.browserObservability)),
    onWarn: (message, details) => log.warn(message, withMetadata(details || {}, options.turnId, options.browserObservability)),
  }, options.streamingHandler);

  try {
    const outcome = await Promise.race([
      compactionPromise.then(() => "done" as const),
      Bun.sleep(deps.getForegroundMs()).then(() => "defer" as const),
    ]);
    if (outcome === "defer") {
      backgroundOwnsAttempt = true;
      void compactionPromise
        .then(() => rotateIfNeeded("background"))
        .then(() => {
          const running = promoteRunning();
          if (running) options.enqueueResume(options.effectiveThreadRootId ?? undefined);
        })
        .catch((error) => {
          log.warn("Background durable pre-prompt compaction failed", withMetadata({
            operation: "process_chat.operation_preflight_deferred_failed",
            chatJid: options.chatJid,
            messageId: options.message.id,
            err: error,
          }, options.turnId, options.browserObservability));
          block();
        })
        .finally(() => durablePreflightAttempts.delete(attemptKey));
      return { status: "deferred" };
    }
  } catch (error) {
    block();
    throw error;
  }

  if (await rotateIfNeeded("foreground")) {
    const running = promoteRunning();
    if (running) options.enqueueResume(options.effectiveThreadRootId ?? undefined);
    return { status: "deferred" };
  }

  const running = promoteRunning();
  if (!running) return { status: "deferred" };
  heartbeatTrackedPhase(options.chatJid, "prompt", { eventType: "operation_preflight_promoted" });
  return { status: "continue", operation: running };
  } finally {
    if (!backgroundOwnsAttempt) durablePreflightAttempts.delete(attemptKey);
  }
}
