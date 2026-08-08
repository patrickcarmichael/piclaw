/**
 * web/agent-message-store.ts – Tracks in-flight agent responses and attachments.
 *
 * Maintains a buffer of the current agent response text, media attachments,
 * and a pending-post queue. When the agent finishes, the buffered content
 * is flushed to the database via agent-message-service.ts.
 *
 * Consumers: channels/web.ts and web/agent-events.ts write to this store.
 */

import type { WebChannelLike } from "../core/web-channel-contracts.js";
import type { AttachmentInfo } from "../../../agent-pool/attachments.js";
import type { AgentEventEmitter } from "../sse/agent-events.js";
import { bindChatOperationMessage, getDb, type ChatOperationOwner, type InteractionRow } from "../../../db.js";
import { formatOutbound, type ChatChannel } from "../../../router.js";
import { createLogger, debugSuppressedError } from "../../../utils/logger.js";
import { sendStoredAgentReplyWebPushNotification } from "../push/web-push-service.js";

const log = createLogger("web.agent-message-store");
const TERMINAL_COMPLETION_REJECTED = Symbol("terminal-completion-rejected");
const OPERATION_BINDING_REJECTED = Symbol("operation-binding-rejected");
const PLACEHOLDER_COMMIT_REJECTED = Symbol("placeholder-commit-rejected");
const SVG_SOURCE_HINT = /(?:<svg[\s>]|&lt;svg[\s>]|&amp;lt;svg[\s>])/i;

function buildAttachmentBlocks(attachments: AttachmentInfo[]): {
  mediaIds: number[];
  contentBlocks: Array<Record<string, unknown>>;
} {
  const mediaIds = attachments.map((a) => a.id);
  const contentBlocks = attachments.map((a) => ({
    type: a.kind === "image" ? "image" : "file",
    name: a.name,
    filename: a.name,
    mime_type: a.contentType,
    size: a.size,
  }));
  return { mediaIds, contentBlocks };
}

function dispatchStoredReplyWebPush(
  interaction: ReturnType<WebChannelLike["storeMessage"]>,
  dispatchWebPushNotification?: (interaction: ReturnType<WebChannelLike["storeMessage"]>) => Promise<unknown>,
): void {
  if (!interaction) return;
  void (dispatchWebPushNotification || sendStoredAgentReplyWebPushNotification)(interaction).catch((error) => {
    debugSuppressedError(log, "Failed to dispatch Web Push for stored agent reply.", error, {
      chatJid: interaction.chat_jid,
      rowId: interaction.id,
    });
  });
}

function bindStoredMessageToOperation(chatJid: string, rowId: number, owner: ChatOperationOwner): void {
  const result = bindChatOperationMessage(chatJid, rowId, owner);
  if (result.status === "bound") return;
  log.warn("Durable intermediate message binding lost operation ownership", {
    operation: "web.agent_message_store.operation_binding_rejected",
    chatJid,
    rowId,
    expectedOwner: owner,
    reason: result.reason,
  });
  throw OPERATION_BINDING_REJECTED;
}

function maybeWarnOnEscapedSvgSource(
  params: {
    chatJid: string;
    text: string;
    attachments: AttachmentInfo[];
    channelName: ChatChannel;
    extraContentBlocks?: Array<Record<string, unknown>>;
  },
  mergedContentBlocks: Array<Record<string, unknown>>,
): void {
  if (params.channelName !== "web") return;
  if (!SVG_SOURCE_HINT.test(params.text || "")) return;

  const hasRenderableVisualBlock = mergedContentBlocks.some((block) => {
    const type = typeof block?.type === "string" ? block.type : "";
    if (type === "generated_widget" || type === "image") return true;
    const mimeType = typeof block?.mime_type === "string" ? block.mime_type : "";
    return /image\/svg\+xml/i.test(mimeType);
  });
  const hasSvgAttachment = params.attachments.some((attachment) => /image\/svg\+xml/i.test(attachment.contentType || ""));
  if (hasRenderableVisualBlock || hasSvgAttachment) return;

  log.warn("Web agent reply contains SVG source markup; attach the SVG or use a widget/artifact instead of message text.", {
    operation: "web.agent_message_store.svg_source_guardrail",
    chatJid: params.chatJid,
    textPreview: params.text.slice(0, 160),
    attachmentCount: params.attachments.length,
    contentBlockTypes: mergedContentBlocks.map((block) => (typeof block?.type === "string" ? block.type : "unknown")),
  });
}

/** Persist the accumulated agent turn (text + attachments) to the database.
 *
 * Returns the message rowid on success, or null on failure. The rowid is the
 * SQLite internal integer id of the persisted message row and is used as the
 * foreign key for thinking_content rows. Callers may treat the result as a
 * truthy/falsy boolean to preserve legacy call patterns.
 *
 * The optional `onMessageStored` callback fires AFTER the message row is
 * written but BEFORE any SSE broadcast or web-push notification, so callers
 * that need to write related rows (e.g. thinking_content keyed by rowid) can
 * do so without a race window where a fast client receives the broadcast and
 * fetches the related data before it exists. */
export function storeAgentTurn(
  channel: WebChannelLike,
  emitter: AgentEventEmitter,
  params: {
    chatJid: string;
    text: string;
    attachments: AttachmentInfo[];
    channelName: ChatChannel;
    threadId?: number | null;
    /** When true, skip consuming queued follow-up placeholders.
     *  Used for intermediate (non-follow-up) turns so the original
     *  response doesn't steal a placeholder meant for the follow-up. */
    skipPlaceholder?: boolean;
    /** True only for the terminal persisted assistant message of a run. */
    isTerminalAgentReply?: boolean;
    /** Exact active owner bound atomically to a non-terminal durable message. */
    operationOwner?: ChatOperationOwner;
    /** Atomically remove stale protected handoff intent with terminal insert. */
    removeProtectedContinuationForSourceMessageId?: string | null;
    extraContentBlocks?: Array<Record<string, unknown>>;
    dispatchWebPushNotification?: (interaction: ReturnType<WebChannelLike["storeMessage"]>) => Promise<unknown>;
    /** Fires after the row is persisted but BEFORE any SSE broadcast or web
     *  push. Receives the persisted message rowid. Errors thrown from this
     *  callback are caught and logged but do not prevent the broadcast —
     *  message persistence wins over auxiliary writes. */
    onMessageStored?: (rowId: number) => void;
    /** Operation completion fence invoked after persistence and before broadcast. */
    commitTerminal?: (rowId: number) => boolean;
  }
): number | null {
  const { mediaIds, contentBlocks } = buildAttachmentBlocks(params.attachments);
  const mergedContentBlocks = [
    ...contentBlocks,
    ...(Array.isArray(params.extraContentBlocks) ? params.extraContentBlocks.filter((block) => block && typeof block === "object") : []),
  ];
  maybeWarnOnEscapedSvgSource(params, mergedContentBlocks);
  const formatted = formatOutbound(params.text, params.channelName);
  const resolvedThreadId = params.threadId ?? undefined;

  // Safely invoke onMessageStored — catches errors so auxiliary writes
  // (e.g. thinking_content) can fail without blocking the message broadcast.
  const safeOnStored = (rowId: number): void => {
    if (!params.onMessageStored) return;
    try {
      params.onMessageStored(rowId);
    } catch (err) {
      debugSuppressedError(log, "onMessageStored callback failed; continuing with broadcast.", err, {
        chatJid: params.chatJid,
        rowId,
      });
    }
  };

  if (!params.skipPlaceholder) {
    // Operation-bound output peeks first so stale-owner rejection cannot
    // destructively shift the in-memory placeholder queue before SQLite CAS.
    const placeholderId = params.operationOwner || params.commitTerminal
      ? channel.peekQueuedFollowupPlaceholder(params.chatJid)
      : channel.consumeQueuedFollowupPlaceholder(params.chatJid);
    if (placeholderId) {
      // Don't override the placeholder's thread_id — it was set correctly
      // when the /queue command created the placeholder (threaded under the
      // /queue message). Passing undefined preserves the original association.
      let updated: InteractionRow | null = null;
      try {
        if (params.commitTerminal) {
          updated = getDb().transaction(() => {
            const stored = channel.replaceQueuedFollowupPlaceholder(
              params.chatJid,
              placeholderId,
              formatted,
              mediaIds,
              mergedContentBlocks.length > 0 ? mergedContentBlocks : undefined,
              undefined,
              false,
              undefined,
              true,
            );
            if (!stored) return null;
            const resolvedRowId = typeof stored.id === "number" ? stored.id : placeholderId;
            safeOnStored(resolvedRowId);
            if (!params.commitTerminal!(resolvedRowId)) throw TERMINAL_COMPLETION_REJECTED;
            if (channel.consumeQueuedFollowupPlaceholder(params.chatJid, placeholderId) !== placeholderId) {
              throw PLACEHOLDER_COMMIT_REJECTED;
            }
            (stored.data as unknown as Record<string, unknown>).is_terminal_agent_reply = true;
            return stored;
          }).immediate();
        } else if (params.operationOwner) {
          updated = getDb().transaction(() => {
            const stored = channel.replaceQueuedFollowupPlaceholder(
              params.chatJid,
              placeholderId,
              formatted,
              mediaIds,
              mergedContentBlocks.length > 0 ? mergedContentBlocks : undefined,
              undefined,
              params.isTerminalAgentReply,
              undefined,
              true,
            );
            if (!stored) return null;
            const resolvedRowId = typeof stored.id === "number" ? stored.id : placeholderId;
            safeOnStored(resolvedRowId);
            bindStoredMessageToOperation(params.chatJid, resolvedRowId, params.operationOwner!);
            if (channel.consumeQueuedFollowupPlaceholder(params.chatJid, placeholderId) !== placeholderId) {
              throw PLACEHOLDER_COMMIT_REJECTED;
            }
            return stored;
          }).immediate();
        } else {
          const beforeBroadcast = params.onMessageStored
            ? (stored: InteractionRow): boolean => {
                safeOnStored(typeof stored.id === "number" ? stored.id : placeholderId);
                return true;
              }
            : undefined;
          updated = channel.replaceQueuedFollowupPlaceholder(
            params.chatJid,
            placeholderId,
            formatted,
            mediaIds,
            mergedContentBlocks.length > 0 ? mergedContentBlocks : undefined,
            undefined,
            params.isTerminalAgentReply,
            beforeBroadcast,
          );
        }
      } catch (error) {
        if (error === TERMINAL_COMPLETION_REJECTED || error === OPERATION_BINDING_REJECTED
          || error === PLACEHOLDER_COMMIT_REJECTED) return null;
        throw error;
      }
      if (updated) {
        if (params.commitTerminal || params.operationOwner) channel.broadcastQueuedFollowupPlaceholderUpdate(updated);
        const resolvedRowId = typeof updated.id === "number" ? updated.id : placeholderId;
        channel.broadcastEvent?.("agent_followup_consumed", {
          chat_jid: params.chatJid,
          thread_id: params.threadId ?? null,
          row_id: placeholderId,
        });
        if (params.isTerminalAgentReply) {
          dispatchStoredReplyWebPush(updated, params.dispatchWebPushNotification);
        }
        return resolvedRowId;
      }
    }
  }

  let interaction: InteractionRow | null = null;
  try {
    if (params.commitTerminal) {
      interaction = getDb().transaction(() => {
        const stored = channel.storeMessage(params.chatJid, formatted, true, mediaIds, {
          contentBlocks: mergedContentBlocks.length > 0 ? mergedContentBlocks : undefined,
          threadId: resolvedThreadId,
          isTerminalAgentReply: false,
          removeProtectedContinuationForSourceMessageId: params.removeProtectedContinuationForSourceMessageId,
        });
        if (!stored) return null;
        const resolvedRowId = typeof stored.id === "number" ? stored.id : null;
        if (resolvedRowId === null) throw TERMINAL_COMPLETION_REJECTED;
        safeOnStored(resolvedRowId);
        if (!params.commitTerminal!(resolvedRowId)) throw TERMINAL_COMPLETION_REJECTED;
        (stored.data as unknown as Record<string, unknown>).is_terminal_agent_reply = true;
        return stored;
      }).immediate();
    } else if (params.operationOwner) {
      interaction = getDb().transaction(() => {
        const stored = channel.storeMessage(params.chatJid, formatted, true, mediaIds, {
          contentBlocks: mergedContentBlocks.length > 0 ? mergedContentBlocks : undefined,
          threadId: resolvedThreadId,
          isTerminalAgentReply: params.isTerminalAgentReply,
          removeProtectedContinuationForSourceMessageId: params.removeProtectedContinuationForSourceMessageId,
        });
        if (!stored || typeof stored.id !== "number") return null;
        safeOnStored(stored.id);
        bindStoredMessageToOperation(params.chatJid, stored.id, params.operationOwner!);
        return stored;
      }).immediate();
    } else {
      interaction = channel.storeMessage(params.chatJid, formatted, true, mediaIds, {
        contentBlocks: mergedContentBlocks.length > 0 ? mergedContentBlocks : undefined,
        threadId: resolvedThreadId,
        isTerminalAgentReply: params.isTerminalAgentReply,
        removeProtectedContinuationForSourceMessageId: params.removeProtectedContinuationForSourceMessageId,
      });
      if (interaction && typeof interaction.id === "number") safeOnStored(interaction.id);
    }
  } catch (error) {
    if (error === TERMINAL_COMPLETION_REJECTED || error === OPERATION_BINDING_REJECTED) return null;
    throw error;
  }
  if (!interaction) return null;

  const resolvedRowId = typeof interaction.id === "number" ? interaction.id : null;
  emitter.response(interaction);
  if (params.isTerminalAgentReply) {
    dispatchStoredReplyWebPush(interaction, params.dispatchWebPushNotification);
  }
  return resolvedRowId;
}
