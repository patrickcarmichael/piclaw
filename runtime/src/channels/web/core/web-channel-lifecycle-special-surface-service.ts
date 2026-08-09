import {
  createWebAdaptiveCardSidePromptService,
  type WebAdaptiveCardSidePromptChannelLike,
  type WebAdaptiveCardSidePromptService,
} from "../cards/adaptive-card-side-prompt-service.js";
import { getWebAgentMessageEntryService, type WebAgentMessageEntryService } from "../messaging/agent-message-entry-service.js";
import {
  createWebAgentPeerMessageRelayService,
  type WebAgentPeerMessageRelayChannelLike,
  type WebAgentPeerMessageRelayService,
} from "../agent/agent-peer-message-relay-service.js";
import type { WebServerLifecycleGatewayService, WebSocketSessionData } from "../server-lifecycle-gateway-service.js";
import type { AgentMessageAcceptanceHandler } from "../messaging/agent-message-acceptance.js";
import type { AgentMessageRequestContext } from "../messaging/agent-message-provenance.js";
import type { WebChannelLike } from "./web-channel-contracts.js";

type WebChannelLifecycleSpecialSurfaceServerLifecycle = Pick<
  WebServerLifecycleGatewayService,
  "server" | "start" | "stop"
>;

export interface WebChannelLifecycleSpecialSurfaceChannel {
  serverLifecycleGateway: WebChannelLifecycleSpecialSurfaceServerLifecycle;
  adaptiveCardSidePromptService?: WebAdaptiveCardSidePromptService;
  peerMessageRelayService?: WebAgentPeerMessageRelayService;
  agentMessageEntryService?: WebAgentMessageEntryService;
  agentPool?: WebChannelLike["agentPool"];
  json?(payload: unknown, status?: number): Response;
  authGateway?: WebAdaptiveCardSidePromptChannelLike["authGateway"];
  interactionBroadcaster?: WebAdaptiveCardSidePromptChannelLike["interactionBroadcaster"];
  sendMessage?: WebAdaptiveCardSidePromptChannelLike["sendMessage"];
  broadcastEvent?: WebAdaptiveCardSidePromptChannelLike["broadcastEvent"];
  skipFailedOnModelSwitch?: WebAdaptiveCardSidePromptChannelLike["skipFailedOnModelSwitch"];
}

export interface WebChannelLifecycleSpecialSurfaceServiceCarrier {
  lifecycleSpecialSurfaceService?: WebChannelLifecycleSpecialSurfaceService;
}

interface WebChannelLifecycleSpecialSurfaceDefaults {
  defaultChatJid: string;
  defaultAgentId: string;
}

function getAdaptiveCardSidePromptService(
  channel: WebChannelLifecycleSpecialSurfaceChannel,
  defaults: WebChannelLifecycleSpecialSurfaceDefaults,
): WebAdaptiveCardSidePromptService {
  return channel.adaptiveCardSidePromptService
    ?? createWebAdaptiveCardSidePromptService(channel as unknown as WebAdaptiveCardSidePromptChannelLike, {
      defaultChatJid: defaults.defaultChatJid,
      defaultAgentId: defaults.defaultAgentId,
    });
}

function getAgentPeerMessageRelayService(
  channel: WebChannelLifecycleSpecialSurfaceChannel,
  defaults: Pick<WebChannelLifecycleSpecialSurfaceDefaults, "defaultAgentId">,
): WebAgentPeerMessageRelayService {
  return channel.peerMessageRelayService
    ?? createWebAgentPeerMessageRelayService(channel as unknown as WebAgentPeerMessageRelayChannelLike, {
      defaultAgentId: defaults.defaultAgentId,
    });
}

export class WebChannelLifecycleSpecialSurfaceService {
  constructor(
    private readonly channel: WebChannelLifecycleSpecialSurfaceChannel,
    private readonly defaults: WebChannelLifecycleSpecialSurfaceDefaults,
  ) {}

  get server(): Bun.Server<WebSocketSessionData> | null {
    return this.channel.serverLifecycleGateway.server;
  }

  async start(): Promise<void> {
    await this.channel.serverLifecycleGateway.start();
  }

  async stop(): Promise<void> {
    await this.channel.serverLifecycleGateway.stop();
  }

  async handleAdaptiveCardAction(req: Request): Promise<Response> {
    return await getAdaptiveCardSidePromptService(this.channel, this.defaults).handleAdaptiveCardAction(req);
  }

  async handleAgentSidePrompt(req: Request): Promise<Response> {
    return await getAdaptiveCardSidePromptService(this.channel, this.defaults).handleAgentSidePrompt(req);
  }

  async handleAgentSidePromptStream(req: Request): Promise<Response> {
    return await getAdaptiveCardSidePromptService(this.channel, this.defaults).handleAgentSidePromptStream(req);
  }

  async handleAgentPeerMessage(req: Request): Promise<Response> {
    return await getAgentPeerMessageRelayService(this.channel, this.defaults).handleAgentPeerMessage(req);
  }

  handleAgentMessage(
    req: Request,
    pathname: string,
    onAccepted?: AgentMessageAcceptanceHandler,
    context?: AgentMessageRequestContext,
  ): Promise<Response> {
    return getWebAgentMessageEntryService(
      this.channel as unknown as WebChannelLike & { agentMessageEntryService?: WebAgentMessageEntryService },
      this.defaults,
    ).handleAgentMessage(req, pathname, onAccepted, context);
  }
}

export function createWebChannelLifecycleSpecialSurfaceService(
  channel: WebChannelLifecycleSpecialSurfaceChannel,
  defaults: WebChannelLifecycleSpecialSurfaceDefaults,
): WebChannelLifecycleSpecialSurfaceService {
  return new WebChannelLifecycleSpecialSurfaceService(channel, defaults);
}

export function getWebChannelLifecycleSpecialSurfaceService(
  channel: WebChannelLifecycleSpecialSurfaceChannel & WebChannelLifecycleSpecialSurfaceServiceCarrier,
  defaults: WebChannelLifecycleSpecialSurfaceDefaults,
): WebChannelLifecycleSpecialSurfaceService {
  return channel.lifecycleSpecialSurfaceService ?? createWebChannelLifecycleSpecialSurfaceService(channel, defaults);
}
