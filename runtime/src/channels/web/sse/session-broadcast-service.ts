/**
 * web/session-broadcast-service.ts – WebChannel SSE/session broadcast seam.
 *
 * Centralizes the web channel's realtime browser wiring: SSE request handling,
 * channel-wide event fanout, and agent-session binding into the UI bridge.
 * This keeps `channels/web.ts` focused on HTTP endpoint orchestration while
 * preserving the existing public surface (`sse`, `uiBridge`, `handleSse()`,
 * and `broadcastEvent()`).
 */

import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";

import type { AgentPool, BoundSessionMutationRunner } from "../../../agent-pool.js";
import type { ProviderUsageRefreshEvent } from "../../../agent-pool/runtime-facade.js";
import { bindWebUiSessionBinder } from "../agent/agent-pool-binder.js";
import { SseHub } from "./sse-hub.js";
import { UiBridge, type UiBridgeChannel } from "../theming/ui-bridge.js";
import { recordSseEvent } from "../../../session-recordings/session-recordings.js";

type SessionBinder = (
  runtime: AgentSessionRuntime,
  chatJid: string,
  mutate: BoundSessionMutationRunner,
) => Promise<void> | void;
type SessionBinderInstaller = (agentPool: AgentPool, binder: SessionBinder) => void;

interface WebSessionBroadcastServiceOpts {
  sse?: SseHub;
  uiBridge?: UiBridge;
  bindSessionBinder?: SessionBinderInstaller;
}

/**
 * Owns the SSE hub and extension UI bridge used by WebChannel.
 *
 * The service installs the agent-pool session binder exactly once so every new
 * web session gets the existing UI bridge behavior without `web.ts` needing to
 * wire the pieces together manually.
 */
export class WebSessionBroadcastService implements UiBridgeChannel {
  readonly sse: SseHub;
  readonly uiBridge: UiBridge;

  constructor(agentPool: AgentPool, opts: WebSessionBroadcastServiceOpts = {}) {
    this.sse = opts.sse ?? new SseHub();
    this.uiBridge = opts.uiBridge ?? new UiBridge(this);
    const bindSessionBinder = opts.bindSessionBinder ?? bindWebUiSessionBinder;
    bindSessionBinder(agentPool, (runtime, chatJid, mutate) => this.uiBridge.bindSession(runtime, chatJid, mutate));
    agentPool.setProviderUsageRefreshListener?.((event: ProviderUsageRefreshEvent) => this.broadcastEvent("model_changed", event));
  }

  handleSse(req: Request): Response {
    return this.sse.handleRequest(req);
  }

  broadcastEvent(eventType: string, data: unknown): void {
    recordSseEvent(eventType, data);
    this.sse.broadcast(eventType, data);
  }
}
