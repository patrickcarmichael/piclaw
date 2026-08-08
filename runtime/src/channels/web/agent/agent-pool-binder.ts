/**
 * channels/web/agent-pool-binder.ts – safely bind UI session bridge to AgentPool.
 */

import type { AgentPool, BoundSessionMutationRunner } from "../../../agent-pool.js";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";

type SessionBinder = (
  runtime: AgentSessionRuntime,
  chatJid: string,
  mutate: BoundSessionMutationRunner,
) => Promise<void> | void;

interface SessionBinderCapable {
  setSessionBinder(binder?: SessionBinder): void;
}

function hasSessionBinder(agentPool: AgentPool): agentPool is AgentPool & SessionBinderCapable {
  const candidate = agentPool as AgentPool & Partial<SessionBinderCapable>;
  return typeof candidate.setSessionBinder === "function";
}

/** Attach the web UI context binder when agent-pool supports session binding. */
export function bindWebUiSessionBinder(agentPool: AgentPool, binder: SessionBinder): void {
  if (!hasSessionBinder(agentPool)) return;
  agentPool.setSessionBinder(binder);
}
