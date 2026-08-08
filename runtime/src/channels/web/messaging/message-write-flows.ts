/**
 * channels/web/message-write-flows.ts – Message write orchestration for web interactions.
 */

import type { InteractionRow } from "../../../db.js";

/** Supported message-send option forms for compatibility with legacy call sites. */
export type SendMessageOptions =
  | number
  | null
  | {
      threadId?: number | null;
      forceRoot?: boolean;
      source?: string;
      mediaIds?: number[];
      contentBlocks?: Array<Record<string, unknown>>;
    };

/** Persistence contract required by web message write flows. */
export interface MessageWriteStore {
  storeMessage(
    chatJid: string,
    content: string,
    isBot: boolean,
    mediaIds: number[],
    options?: { threadId?: number; contentBlocks?: unknown[]; isTerminalAgentReply?: boolean }
  ): InteractionRow | null;
  replaceMessageContent(
    chatJid: string,
    rowId: number,
    text: string,
    mediaIds: number[],
    contentBlocks: Array<Record<string, unknown>> | undefined,
    isTerminalAgentReply?: boolean
  ): InteractionRow | null;
  setMessageThreadToSelf(messageId: number): void;
}

/** Broadcast contract required by web message write flows. */
export interface MessageWriteBroadcaster {
  broadcastAgentResponse(interaction: InteractionRow): void;
  broadcastInteractionUpdated(interaction: InteractionRow): void;
}

/** Follow-up placeholder queue contract required by write flows. */
export interface MessageWriteFollowupQueue {
  enqueue(chatJid: string, rowId: number, queuedContent: string, threadId?: number | null, queuedAt?: string): void;
}

/** Aggregated context consumed by web message write helper functions. */
export interface MessageWriteContext {
  defaultAgentId: string;
  store: MessageWriteStore;
  broadcaster: MessageWriteBroadcaster;
  followups: MessageWriteFollowupQueue;
}

interface NormalizedSendMessageOptions {
  threadId: number | null;
  forceRoot: boolean;
  mediaIds: number[];
  contentBlocks: Array<Record<string, unknown>> | undefined;
}

function normalizeSendMessageOptions(options?: SendMessageOptions): NormalizedSendMessageOptions {
  const normalized =
    typeof options === "number" || options === null
      ? { threadId: options ?? null }
      : (options ?? {});

  const mediaIds =
    Array.isArray(normalized.mediaIds)
      ? normalized.mediaIds.filter((id) => Number.isFinite(id) && id > 0)
      : [];
  const contentBlocks =
    Array.isArray(normalized.contentBlocks)
      ? normalized.contentBlocks.filter((block) => block && typeof block === "object")
      : undefined;

  return {
    threadId: normalized.threadId ?? null,
    forceRoot: Boolean(normalized.forceRoot),
    mediaIds: mediaIds,
    contentBlocks,
  };
}

/** Store and broadcast an agent message response to web clients. */
export function sendWebMessage(
  chatJid: string,
  text: string,
  options: SendMessageOptions | undefined,
  ctx: MessageWriteContext
): void {
  const { threadId, forceRoot, mediaIds, contentBlocks } = normalizeSendMessageOptions(options);
  const interaction = ctx.store.storeMessage(
    chatJid,
    text,
    true,
    mediaIds,
    {
      ...(threadId !== null ? { threadId } : {}),
      ...(contentBlocks && contentBlocks.length ? { contentBlocks } : {}),
    }
  );

  if (!interaction) return;

  if (forceRoot && !threadId) {
    // Ensure scheduled messages start new threads (not replies to inflight turns).
    ctx.store.setMessageThreadToSelf(interaction.id);
    interaction.data.thread_id = interaction.id;
  }

  ctx.broadcaster.broadcastAgentResponse(interaction);
}

/** Store, queue, and broadcast a follow-up placeholder interaction. */
export function queueFollowupPlaceholderMessage(
  chatJid: string,
  text: string,
  threadIdOrCtxOrQueuedContent?: number | null | MessageWriteContext,
  queuedContentOrCtx?: string | MessageWriteContext,
  ctxMaybe?: MessageWriteContext
): InteractionRow | null {
  const isContext = (value: unknown): value is MessageWriteContext =>
    !!value && typeof value === "object" && "store" in value;

  let threadId: number | undefined;
  let queuedContent = text;

  if (typeof threadIdOrCtxOrQueuedContent === "number") {
    threadId = threadIdOrCtxOrQueuedContent;
  }

  const ctx = isContext(ctxMaybe)
    ? ctxMaybe
    : isContext(queuedContentOrCtx)
      ? queuedContentOrCtx
      : isContext(threadIdOrCtxOrQueuedContent)
        ? threadIdOrCtxOrQueuedContent
        : undefined;

  if (typeof queuedContentOrCtx === "string") {
    queuedContent = queuedContentOrCtx;
  }

  if (!ctx) return null;

  const interaction = ctx.store.storeMessage(chatJid, text, true, [], { threadId });
  if (!interaction) return null;

  ctx.followups.enqueue(chatJid, interaction.id, queuedContent, threadId, interaction.timestamp);
  // Don't broadcast the placeholder as agent_response — the caller emits
  // agent_followup_queued instead.  Broadcasting here caused the post to
  // flash in the timeline before the client-side filter could hide it.
  return interaction;
}

/** Replace a queued follow-up placeholder and broadcast the update. */
export function replaceQueuedFollowupPlaceholderMessage(
  chatJid: string,
  rowId: number,
  text: string,
  mediaIds: number[],
  contentBlocks: Array<Record<string, unknown>> | undefined,
  threadId: number | undefined,
  ctx: MessageWriteContext,
  isTerminalAgentReply?: boolean,
  beforeBroadcast?: (interaction: InteractionRow) => boolean,
): InteractionRow | null {
  const updated = ctx.store.replaceMessageContent(
    chatJid,
    rowId,
    text,
    mediaIds,
    contentBlocks,
    isTerminalAgentReply
  );
  if (!updated) return null;

  updated.data.agent_id = ctx.defaultAgentId;
  if (threadId) updated.data.thread_id = threadId;

  if (!beforeBroadcast || beforeBroadcast(updated)) {
    ctx.broadcaster.broadcastInteractionUpdated(updated);
  }
  return updated;
}
