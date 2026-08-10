/**
 * Opaque provenance carried only by trusted in-process agent-message enqueue calls.
 *
 * Public HTTP requests cannot manufacture this context through their URL,
 * headers, or JSON body. The WeakMap brand also prevents lookalike objects from
 * being treated as trusted by the shared handler path.
 */

import {
  normalizeQueuedFollowupSourceMetadata,
  type QueuedFollowupSourceMetadata,
} from "../../../queued-followups.js";

export interface TrustedAgentMessageProvenance {
  source?: string;
  queuedBy?: QueuedFollowupSourceMetadata;
}

/** Opaque call-context type; trust is established by object identity. */
export type AgentMessageRequestContext = object;

const trustedContexts = new WeakMap<object, TrustedAgentMessageProvenance>();
const ownerAuthorizedContexts = new WeakSet<object>();

/** Brand a request admitted through the owner-facing HTTP dispatch boundary. */
export function createOwnerAuthorizedAgentMessageRequestContext(): AgentMessageRequestContext {
  const context = Object.freeze({});
  ownerAuthorizedContexts.add(context);
  return context;
}

export function isOwnerAuthorizedAgentMessageRequestContext(
  context: AgentMessageRequestContext | undefined,
): boolean {
  return Boolean(context && typeof context === "object" && ownerAuthorizedContexts.has(context));
}

export function createTrustedAgentMessageRequestContext(
  provenance: TrustedAgentMessageProvenance = {},
): AgentMessageRequestContext {
  const context = Object.freeze({});
  const source = typeof provenance.source === "string" && provenance.source.trim()
    ? provenance.source.trim()
    : undefined;
  const queuedBy = normalizeQueuedFollowupSourceMetadata(provenance.queuedBy);
  trustedContexts.set(context, {
    ...(source ? { source } : {}),
    ...(queuedBy ? { queuedBy } : {}),
  });
  return context;
}

export function getTrustedAgentMessageProvenance(
  context: AgentMessageRequestContext | undefined,
): TrustedAgentMessageProvenance | null {
  if (!context || typeof context !== "object") return null;
  const provenance = trustedContexts.get(context);
  if (!provenance) return null;
  return {
    ...(provenance.source ? { source: provenance.source } : {}),
    ...(provenance.queuedBy ? { queuedBy: { ...provenance.queuedBy } } : {}),
  };
}
