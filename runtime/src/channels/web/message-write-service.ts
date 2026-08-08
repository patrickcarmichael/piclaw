/**
 * web/message-write-service.ts – WebChannel message-write and follow-up coordination seam.
 *
 * Owns construction of the write context used by web message write flows,
 * delegates WebChannel send/widget writes through that context, and keeps
 * queued follow-up placeholder behavior isolated behind a narrower service.
 */

import type { InteractionRow } from "../../db.js";
import { postDashboardWidget as postDashboardWidgetMessage } from "./dashboard-widget.js";
import {
  queueFollowupPlaceholderMessage,
  replaceQueuedFollowupPlaceholderMessage,
  sendWebMessage,
  type MessageWriteContext,
  type SendMessageOptions,
} from "./messaging/message-write-flows.js";

export interface WebMessageWriteServiceDeps {
  defaultAgentId: string;
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
  broadcastAgentResponse(interaction: InteractionRow): void;
  broadcastInteractionUpdated(interaction: InteractionRow): void;
  enqueueFollowupPlaceholder(
    chatJid: string,
    rowId: number,
    queuedContent: string,
    threadId?: number | null,
    queuedAt?: string,
  ): void;
}

export function createMessageWriteContext(deps: WebMessageWriteServiceDeps): MessageWriteContext {
  return {
    defaultAgentId: deps.defaultAgentId,
    store: {
      storeMessage: (chatJid, content, isBot, mediaIds, options) =>
        deps.storeMessage(chatJid, content, isBot, mediaIds, options),
      replaceMessageContent: (chatJid, rowId, text, mediaIds, contentBlocks, isTerminalAgentReply) =>
        deps.replaceMessageContent(chatJid, rowId, text, mediaIds, contentBlocks, isTerminalAgentReply),
      setMessageThreadToSelf: (messageId) => {
        deps.setMessageThreadToSelf(messageId);
      },
    },
    broadcaster: {
      broadcastAgentResponse: (interaction) => deps.broadcastAgentResponse(interaction),
      broadcastInteractionUpdated: (interaction) => deps.broadcastInteractionUpdated(interaction),
    },
    followups: {
      enqueue: (chatJid, rowId, queuedContent, threadId, queuedAt) =>
        deps.enqueueFollowupPlaceholder(chatJid, rowId, queuedContent, threadId, queuedAt),
    },
  };
}

export class WebMessageWriteService {
  private readonly context: MessageWriteContext;

  constructor(private readonly deps: WebMessageWriteServiceDeps) {
    this.context = createMessageWriteContext(deps);
  }

  async sendMessage(chatJid: string, text: string, options?: SendMessageOptions): Promise<void> {
    sendWebMessage(chatJid, text, options, this.context);
  }

  async postDashboardWidget(
    chatJid: string,
    options?: { threadId?: number | null; text?: string; widgetId?: string },
  ): Promise<void> {
    await postDashboardWidgetMessage(
      {
        sendMessage: (targetChatJid, text, sendOptions) => this.sendMessage(targetChatJid, text, sendOptions),
      },
      {
        chatJid,
        threadId: options?.threadId,
        text: options?.text,
        widgetId: options?.widgetId,
      }
    );
  }

  queueFollowupPlaceholder(
    chatJid: string,
    text: string,
    threadId?: number,
    queuedContent?: string,
  ): InteractionRow | null {
    return queueFollowupPlaceholderMessage(
      chatJid,
      text,
      threadId,
      (queuedContent || "").trim() || text,
      this.context,
    );
  }

  replaceQueuedFollowupPlaceholder(
    chatJid: string,
    rowId: number,
    text: string,
    mediaIds: number[],
    contentBlocks: Array<Record<string, unknown>> | undefined,
    threadId?: number,
    isTerminalAgentReply?: boolean,
    beforeBroadcast?: (interaction: InteractionRow) => boolean,
    deferBroadcast?: boolean,
  ): InteractionRow | null {
    return replaceQueuedFollowupPlaceholderMessage(
      chatJid,
      rowId,
      text,
      mediaIds,
      contentBlocks,
      threadId,
      this.context,
      isTerminalAgentReply,
      beforeBroadcast,
      deferBroadcast,
    );
  }

  broadcastQueuedFollowupPlaceholderUpdate(interaction: InteractionRow): void {
    this.context.broadcaster.broadcastInteractionUpdated(interaction);
  }
}
