/**
 * channels/web/agent-message-entry-service.ts – WebChannel agent-message entry wrapper seam.
 *
 * Owns the thin `/agent/:agentId/message` request-entry wrapper that preserves
 * existing `chat_jid` query parsing/defaulting and forwards into the shared
 * agent-message handler path without changing router-facing WebChannel APIs.
 */

import { handleAgentMessage as handleAgentMessageRequest } from "../handlers/agent.js";
import type { AgentMessageAcceptanceHandler } from "./agent-message-acceptance.js";
import type { AgentMessageRequestContext } from "./agent-message-provenance.js";
import type { WebChannelLike } from "../core/web-channel-contracts.js";

export interface WebAgentMessageEntryServiceOptions {
  defaultChatJid: string;
  defaultAgentId: string;
  forwardAgentMessageRequest(
    req: Request,
    pathname: string,
    chatJid: string,
    agentId: string,
    onAccepted?: AgentMessageAcceptanceHandler,
    context?: AgentMessageRequestContext,
  ): Promise<Response>;
}

export function createWebAgentMessageEntryService(
  channel: WebChannelLike,
  defaults: { defaultChatJid: string; defaultAgentId: string },
): WebAgentMessageEntryService {
  return new WebAgentMessageEntryService({
    defaultChatJid: defaults.defaultChatJid,
    defaultAgentId: defaults.defaultAgentId,
    forwardAgentMessageRequest: (req, pathname, chatJid, agentId, onAccepted, context) =>
      handleAgentMessageRequest(channel, req, pathname, chatJid, agentId, onAccepted, context),
  });
}

export function getWebAgentMessageEntryService(
  channel: WebChannelLike & { agentMessageEntryService?: WebAgentMessageEntryService },
  defaults: { defaultChatJid: string; defaultAgentId: string },
): WebAgentMessageEntryService {
  return channel.agentMessageEntryService ?? createWebAgentMessageEntryService(channel, defaults);
}

export class WebAgentMessageEntryService {
  constructor(private readonly options: WebAgentMessageEntryServiceOptions) {}

  handleAgentMessage(
    req: Request,
    pathname: string,
    onAccepted?: AgentMessageAcceptanceHandler,
    context?: AgentMessageRequestContext,
  ): Promise<Response> {
    const chatJid = this.resolveChatJid(req);
    return this.options.forwardAgentMessageRequest(req, pathname, chatJid, this.options.defaultAgentId, onAccepted, context);
  }

  private resolveChatJid(req: Request): string {
    return new URL(req.url).searchParams.get("chat_jid")?.trim() || this.options.defaultChatJid;
  }
}
