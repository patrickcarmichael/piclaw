/**
 * web/agent-message-service.ts – Stores agent responses as timeline posts.
 *
 * After an agent run completes, this service persists the response as a
 * message in the database and broadcasts it to SSE clients.
 *
 * Consumers: channels/web.ts calls this after agent runs complete.
 */

import type { WebChannelLike } from "../core/web-channel-contracts.js";
import type { InteractionRow } from "../../../db.js";
import { parseJsonObjectRequest } from "../json-body.js";
import { normalizeMediaIds } from "../posts-service.js";
import { sanitizePublicInboundContentBlocks } from "./content-block-safety.js";

/** AgentMessagePayload type definition. */
export interface AgentMessagePayload {
  content?: string;
  thread_id?: number | null;
  media_ids?: number[];
  mode?: "auto" | "queue" | "steer";
  /** Internal trusted relay hint: persist a visible timeline row when a steer is queued. */
  persist_steer?: boolean;
  /** Exact durable operation owner expected by an interactive Abort request. */
  expected_operation_id?: string;
  content_blocks?: unknown[];
  link_previews?: unknown[];
  screen_hint?: string;
  client_context?: {
    screen_hint?: unknown;
  };
}

/**
 * Max allowed agent message content length (100 KB).
 * Consistent with MAX_POST_CONTENT_LENGTH in posts-service.ts.
 * Prevents oversized messages from the compose box reaching the agent.
 */
const MAX_AGENT_MESSAGE_CONTENT_LENGTH = 100 * 1024;
const VALID_SCREEN_HINTS = new Set(["mobile", "tablet", "desktop"]);

function normalizeScreenHint(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return VALID_SCREEN_HINTS.has(normalized) ? normalized : undefined;
}

/**
 * Parse and validate an agent message API request body.
 * Returns { error } if the JSON is invalid or content exceeds the size limit.
 */
export async function parseAgentMessageRequest(req: Request): Promise<{
  payload?: AgentMessagePayload;
  error?: string;
}> {
  const parsed = await parseJsonObjectRequest(req);
  if (!parsed.ok) return { error: parsed.error };

  const data = parsed.payload as AgentMessagePayload & Record<string, unknown>;
  if (data.content !== undefined && typeof data.content !== "string") {
    return { error: "'content' must be a string" };
  }
  if (data.thread_id !== undefined && data.thread_id !== null && (!Number.isInteger(data.thread_id) || data.thread_id <= 0)) {
    return { error: "'thread_id' must be a positive integer or null" };
  }
  if (data.media_ids !== undefined && !Array.isArray(data.media_ids)) {
    return { error: "'media_ids' must be an array" };
  }
  if (data.content_blocks !== undefined && !Array.isArray(data.content_blocks)) {
    return { error: "'content_blocks' must be an array" };
  }
  if (data.link_previews !== undefined && !Array.isArray(data.link_previews)) {
    return { error: "'link_previews' must be an array" };
  }
  if (data.mode !== undefined && data.mode !== "auto" && data.mode !== "queue" && data.mode !== "steer") {
    return { error: "'mode' must be one of: auto, queue, steer" };
  }
  if (data.expected_operation_id !== undefined && typeof data.expected_operation_id !== "string") {
    return { error: "'expected_operation_id' must be a string" };
  }
  if (typeof data.expected_operation_id === "string") {
    data.expected_operation_id = data.expected_operation_id.trim();
    if (!data.expected_operation_id || data.expected_operation_id.length > 128) {
      return { error: "'expected_operation_id' must be between 1 and 128 characters" };
    }
  }

  // Content length check — must match the limit used by parsePostPayload()
  if (typeof data.content === "string" && data.content.length > MAX_AGENT_MESSAGE_CONTENT_LENGTH) {
    return { error: `Content too large (max ${MAX_AGENT_MESSAGE_CONTENT_LENGTH / 1024} KB)` };
  }

  const screenHint = normalizeScreenHint(data.client_context?.screen_hint ?? data.screen_hint);
  if (screenHint) data.screen_hint = screenHint;
  else delete data.screen_hint;
  delete data.client_context;
  data.content_blocks = sanitizePublicInboundContentBlocks(data.content_blocks);

  return { payload: data };
}

/** Normalize an agent message payload for storage (trim, defaults). */
export function normalizeAgentMessagePayload(payload: AgentMessagePayload): {
  content?: string;
  threadId?: number | null;
  mediaIds: number[];
  contentBlocks?: unknown[];
  linkPreviews?: unknown[];
  mode?: "auto" | "queue" | "steer";
  screenHint?: string;
} {
  return {
    content: payload.content,
    threadId: payload.thread_id ?? null,
    mediaIds: normalizeMediaIds(payload.media_ids),
    contentBlocks: Array.isArray(payload.content_blocks) ? payload.content_blocks : undefined,
    linkPreviews: Array.isArray(payload.link_previews) ? payload.link_previews : undefined,
    mode: payload.mode,
    screenHint: normalizeScreenHint(payload.screen_hint),
  };
}

/** Store the user portion of an agent interaction in the database. */
export function storeAgentUserMessage(
  channel: WebChannelLike,
  chatJid: string,
  payload: {
    content: string;
    mediaIds: number[];
    contentBlocks?: unknown[];
    linkPreviews?: unknown[];
    threadId?: number | null;
    screenHint?: string;
    isSteeringMessage?: boolean;
  }
): InteractionRow | null {
  return channel.storeMessage(chatJid, payload.content, false, payload.mediaIds, {
    contentBlocks: payload.contentBlocks,
    linkPreviews: payload.linkPreviews,
    threadId: payload.threadId ?? undefined,
    screenHint: payload.screenHint,
    isSteeringMessage: payload.isSteeringMessage,
  });
}
