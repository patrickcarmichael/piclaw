/**
 * web/message-store.ts – Database operations for web-channel messages.
 *
 * Wraps db/messages.ts with web-channel-specific logic: generating message
 * IDs, attaching media, and handling content blocks. Serves as the data
 * access layer for all web-channel message CRUD operations.
 *
 * Consumers: web/posts-service.ts, web/agent-message-service.ts.
 */

import {
  acceptStoredChatMessageSource,
  attachMediaToMessage,
  clampWebContent,
  createMedia,
  getChatBranchByChatJid,
  getDb,
  getMediaInfoById,
  getMessageByRowId,
  getDeferredQueuedFollowups,
  removeProtectedRecoveryContinuationForSourceMessageId,
  setDeferredQueuedFollowups,
  storeChatMetadata,
  storeMessage,
} from "../../../db.js";
import { getWebPreviewMaxChars, shouldPreviewWebContent } from "../../../db/web-content.js";
import { scheduleLinkPreviews, type LinkPreviewChannel } from "../media/link-previews.js";
import type { InteractionRow } from "../../../db.js";
import type { NewMessage } from "../../../types.js";
import { createUuid } from "../../../utils/ids.js";

/** Options for storing a web channel message (content, media, thread). */
export interface StoreWebMessageOptions {
  contentBlocks?: unknown[];
  linkPreviews?: unknown[];
  threadId?: number | null;
  screenHint?: string | null;
  isTerminalAgentReply?: boolean;
  isSteeringMessage?: boolean;
  /** Remove stale protected intent atomically with this terminal row insert. */
  removeProtectedContinuationForSourceMessageId?: string | null;
  /** Atomically register this user row as accepted durable work. */
  acceptDurableSource?: boolean;
  /** Atomically remove this deferred queue row with the user-message insert. */
  consumeDeferredFollowupRowId?: number | null;
  /** Fault-injection seam used to prove transaction rollback before consume. */
  beforeDeferredFollowupConsume?: () => void;
}

/** Resolved parameters for storeWebMessage (after defaults applied). */
export interface StoreWebMessageParams {
  chatJid: string;
  content: string;
  isBot: boolean;
  mediaIds: number[];
  agentId: string;
  agentName: string;
  userName?: string | null;
}

/** Store a web channel message in the database and attach media. */
export function storeWebMessage(
  channel: LinkPreviewChannel,
  params: StoreWebMessageParams,
  options: StoreWebMessageOptions = {}
): InteractionRow | null {
  const messageId = createUuid("web");
  let contentBlocks = Array.isArray(options.contentBlocks)
    ? [...options.contentBlocks]
    : undefined;
  const allMediaIds = [...params.mediaIds];

  if (!contentBlocks && params.mediaIds.length > 0) {
    contentBlocks = params.mediaIds.map((mediaId) => {
      const info = getMediaInfoById(mediaId);
      const mimeType = typeof info?.content_type === "string" ? info.content_type : "application/octet-stream";
      const filename = typeof info?.filename === "string" ? info.filename : null;
      const isImage = mimeType.toLowerCase().startsWith("image/");
      return {
        type: isImage ? "image" : "file",
        ...(filename ? { name: filename, filename } : {}),
        ...(mimeType ? { mime_type: mimeType } : {}),
      };
    });
  }

  if (shouldPreviewWebContent(params.content)) {
    const maxChars = getWebPreviewMaxChars();
    const filename = `message-${messageId}.md`;
    const data = new TextEncoder().encode(params.content);
    const mediaId = createMedia(filename, "text/markdown", data, null, {
      size: data.length,
      kind: "file",
      source: "message",
      original_length: params.content.length,
      preview_limit: maxChars,
    });
    if (mediaId > 0) {
      allMediaIds.push(mediaId);
      const block = {
        type: "file",
        name: filename,
        filename,
        mime_type: "text/markdown",
        size: data.length,
      };
      if (contentBlocks) contentBlocks.push(block);
      else contentBlocks = [block];
    }
  }

  const msg: NewMessage = {
    id: messageId,
    chat_jid: params.chatJid,
    sender: params.isBot ? "web-agent" : "web-user",
    sender_name: params.isBot ? params.agentName : (typeof params.userName === "string" && params.userName.trim() ? params.userName.trim() : "You"),
    content: params.content,
    screen_hint: typeof options.screenHint === "string" && options.screenHint.trim() ? options.screenHint.trim() : null,
    timestamp: new Date().toISOString(),
    is_from_me: false,
    is_bot_message: params.isBot,
    content_blocks: contentBlocks,
    link_previews: options.linkPreviews,
    thread_id: options.threadId ?? null,
    is_terminal_agent_reply: options.isTerminalAgentReply,
    is_steering_message: options.isSteeringMessage,
  };

  let rowId = 0;
  try {
    getDb().transaction(() => {
      rowId = storeMessage(msg);
      if (rowId <= 0) throw new Error("Failed to persist web message row");

      if (allMediaIds.length > 0) {
        attachMediaToMessage(rowId, allMediaIds);
      }

      // Ensure user messages are threaded to themselves when no explicit threadId
      // is provided. This creates a consistent thread root for replies.
      if (!params.isBot && (options.threadId === null || options.threadId === undefined)) {
        getDb().prepare("UPDATE messages SET thread_id = ? WHERE rowid = ?").run(rowId, rowId);
      }
      if (!params.isBot && options.acceptDurableSource === true) {
        acceptStoredChatMessageSource(params.chatJid, rowId);
      }

      const sourceMessageId = typeof options.removeProtectedContinuationForSourceMessageId === "string"
        ? options.removeProtectedContinuationForSourceMessageId.trim()
        : "";
      if (params.isBot && options.isTerminalAgentReply && sourceMessageId) {
        removeProtectedRecoveryContinuationForSourceMessageId(params.chatJid, sourceMessageId);
      }

      const consumeDeferredRowId = typeof options.consumeDeferredFollowupRowId === "number"
        ? options.consumeDeferredFollowupRowId
        : null;
      if (!params.isBot && consumeDeferredRowId !== null && Number.isFinite(consumeDeferredRowId)) {
        options.beforeDeferredFollowupConsume?.();
        const queued = getDeferredQueuedFollowups(params.chatJid);
        const index = queued.findIndex((item) => item.rowId === consumeDeferredRowId);
        if (index < 0) throw new Error("Deferred follow-up intent disappeared before materialization");
        queued.splice(index, 1);
        setDeferredQueuedFollowups(params.chatJid, queued);
      }

      storeChatMetadata(params.chatJid, msg.timestamp, getChatBranchByChatJid(params.chatJid)?.agent_name || undefined);
    }).immediate();
  } catch {
    return null;
  }

  const interaction = getMessageByRowId(params.chatJid, rowId);
  if (interaction) {
    interaction.data.agent_id = params.agentId;
    if (options.threadId) interaction.data.thread_id = options.threadId;
    else if (!params.isBot) interaction.data.thread_id = rowId;
    scheduleLinkPreviews(channel, params.chatJid, rowId, params.content, options.linkPreviews);
    return interaction;
  }

  const { content: safeContent, meta } = clampWebContent(params.content);
  const data: InteractionRow["data"] = {
    type: params.isBot ? "agent_response" : "user_message",
    content: safeContent,
    content_meta: meta,
    agent_id: params.agentId,
    media_ids: allMediaIds,
  };
  if (msg.screen_hint) data.screen_hint = msg.screen_hint;
  if (options.threadId) data.thread_id = options.threadId;
  else if (!params.isBot) data.thread_id = rowId;
  if (contentBlocks?.length) data.content_blocks = contentBlocks;
  if (options.linkPreviews?.length) data.link_previews = options.linkPreviews;
  scheduleLinkPreviews(channel, params.chatJid, rowId, params.content, options.linkPreviews);
  return {
    id: rowId,
    chat_jid: params.chatJid,
    timestamp: msg.timestamp,
    data,
  };
}
