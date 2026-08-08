/**
 * chat-tool – relay a message from the current chat session to another session.
 *
 * The runtime implementation resolves and verifies source/destination identity,
 * then routes a message through the normal inbound-message path for the target
 * chat so queue semantics, follow-up handling, and agent execution remain unchanged.
 */
import { Type } from "typebox";
import type { AgentToolResult, ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { getChatJid } from "../core/chat-context.js";
import { localChatAddressFromSelector, parseChatAddress } from "./chat-address.js";
import {
  sendViaChatTransport,
  setLocalChatTransport,
  type ChatTransportResult,
} from "./chat-transport-registry.js";

export type ChatRelayMode = "auto" | "queue" | "steer";

export type ChatRelayRequest = {
  source_chat_jid: string;
  target_chat_jid?: string;
  target_agent_name?: string;
  content: string;
  mode: ChatRelayMode;
  idempotency_key?: string;
  in_reply_to?: string;
  signal?: AbortSignal;
};

export type ChatRelayResult = {
  status?: string;
  relayed?: boolean;
  source_chat_jid: string;
  source_agent_name?: string;
  source_agent_display_name?: string;
  target_chat_jid: string;
  target_agent_name?: string;
  target_agent_display_name?: string;
  reply_to?: Record<string, unknown>;
  source_session_tree?: Record<string, unknown>;
  target_session_tree?: Record<string, unknown>;
  row_id?: number | null;
  queued?: string;
  thread_id?: number | null;
  created?: boolean;
  acknowledged?: boolean;
  delivery_disposition?: "accepted" | "indeterminate" | "cancelled";
  timed_out?: boolean;
  accepted_at?: string;
  idempotency_key?: string;
};

export type ChatToolRelayFn = (request: ChatRelayRequest) => Promise<ChatRelayResult>;

/** Install or remove the built-in local relay behind the generic transport seam. */
export function setChatToolRelayFn(fn: ChatToolRelayFn | undefined): void {
  if (!fn) {
    setLocalChatTransport(undefined);
    return;
  }

  setLocalChatTransport({
    id: "local",
    async send(request) {
      if (request.address.kind !== "local") throw new Error("Local chat transport received a non-local address.");
      const result = await fn({
        source_chat_jid: request.source_chat_jid,
        ...(request.address.targetKind === "chat"
          ? { target_chat_jid: request.address.target }
          : { target_agent_name: request.address.target }),
        content: request.content,
        mode: request.mode,
        ...(request.idempotency_key ? { idempotency_key: request.idempotency_key } : {}),
        ...(request.in_reply_to ? { in_reply_to: request.in_reply_to } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
      });
      return result;
    },
  });
}

const ChatSchema = Type.Object({
  target_address: Type.Optional(Type.String({ description: "Destination address. Local examples: '@research'. One-hop remote example: 'lab!@research'. Mutually exclusive with target_chat_jid and target_agent_name." })),
  target_chat_jid: Type.Optional(Type.String({ description: "Destination chat JID. Fallback only; prefer target_agent_name/@alias so the runtime can resolve the internal session tree." })),
  target_agent_name: Type.Optional(Type.String({ description: "Preferred destination branch handle/alias, e.g. 'research' or '@research'. Resolves through the internal session tree mapping." })),
  content: Type.String({ description: "Message body to deliver to the destination session." }),
  mode: Type.Optional(Type.Union([
    Type.Literal("auto"),
    Type.Literal("queue"),
    Type.Literal("steer"),
  ], { description: "Delivery mode for busy targets: steer (default), queue, or auto." })),
  idempotency_key: Type.Optional(Type.String({ description: "Optional transport idempotency key. Used by transports that support durable retry deduplication." })),
  in_reply_to: Type.Optional(Type.String({ description: "Optional opaque transport reply token or message id." })),
});

export type ChatToolParams = {
  target_address?: string;
  target_chat_jid?: string;
  target_agent_name?: string;
  content: string;
  mode?: ChatRelayMode;
  idempotency_key?: string;
  in_reply_to?: string;
};

const HINT = [
  "## Cross-session chat",
  "Use the chat tool when one agent session needs to message another session.",
  "Prefer target_agent_name with an @alias (for example @research). Use target_chat_jid only as a fallback when no alias exists.",
  "Use target_address for an explicit address. Local aliases use @name; installed transports may add one-hop peer!target addresses. Multi-hop bang paths are rejected.",
  "@aliases are resolved through the internal Pi chat-branch/session-tree registry before delivery; do not use opaque session IDs when an alias is available.",
  "Sender identity is derived from the current chat session and cannot be supplied by the caller; destination identity is resolved before delivery.",
  "The destination receives the message through its normal inbound-message path with structured reply-to metadata.",
  "Messages steer the target immediately by default. A local steer returns after durable target acceptance; an acknowledgement timeout reports indeterminate delivery, so retry with the same idempotency_key. Use mode='queue' to enqueue behind active work, or mode='auto' for standard request behavior.",
].join("\n");

function err(message: string): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: "text", text: message }],
    details: { relayed: false, error: message },
  };
}

function normalizeTargetAgentName(value: string | undefined): string {
  return String(value || "").trim().replace(/^@+/, "").trim();
}

function describeTarget(result: ChatTransportResult): string {
  if (result.target_agent_name && result.target_chat_jid) {
    return `@${result.target_agent_name} (${result.target_chat_jid})`;
  }
  return result.target_address
    ? String(result.target_address)
    : result.target_chat_jid
      ? String(result.target_chat_jid)
      : result.target_agent_name
        ? `@${result.target_agent_name}`
        : "destination";
}

/** Built-in tool for cross-session chat relay. */
export const chatTool: ExtensionFactory = (pi: ExtensionAPI) => {
  pi.on("before_agent_start", async (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${HINT}`,
  }));

  pi.registerTool({
    name: "chat",
    label: "chat",
    description: "Send a message from the current session to another local session or a destination handled by an installed chat transport.",
    promptSnippet: "chat: relay a message to a local @alias or a one-hop transport address. Prefer target_agent_name='@alias' for local sessions.",
    parameters: ChatSchema,
    async execute(_toolCallId, params: ChatToolParams, signal) {
      const sourceChatJid = getChatJid("").trim();
      if (!sourceChatJid) return err("Cannot determine the source chat. The chat tool requires an active chat context.");

      const targetAddress = params.target_address?.trim() || "";
      const targetChatJid = params.target_chat_jid?.trim() || "";
      const targetAgentName = normalizeTargetAgentName(params.target_agent_name);
      const selectorCount = Number(Boolean(targetAddress)) + Number(Boolean(targetChatJid)) + Number(Boolean(targetAgentName));
      if (selectorCount === 0) {
        return err("Provide target_address, target_agent_name (@alias preferred), or target_chat_jid.");
      }
      if (selectorCount > 1) {
        return err("Provide only one target selector: target_address, target_chat_jid, or target_agent_name.");
      }

      const content = params.content?.trim() || "";
      if (!content) return err("Provide content.");

      try {
        const address = targetAddress
          ? parseChatAddress(targetAddress)
          : localChatAddressFromSelector({ targetChatJid, targetAgentName });
        const result = await sendViaChatTransport({
          source_chat_jid: sourceChatJid,
          address,
          content,
          mode: params.mode || "steer",
          ...(params.idempotency_key?.trim() ? { idempotency_key: params.idempotency_key.trim() } : {}),
          ...(params.in_reply_to?.trim() ? { in_reply_to: params.in_reply_to.trim() } : {}),
          ...(signal ? { signal } : {}),
        }, { annotate: Boolean(targetAddress) });

        const target = describeTarget(result);
        const statusText = result.delivery_disposition === "indeterminate"
          ? result.timed_out === true
            ? `Delivery to ${target} is indeterminate because durable acknowledgement timed out. Retry only with the same idempotency_key.`
            : `Delivery to ${target} is indeterminate because durable acceptance was not acknowledged. Retry only with the same idempotency_key.`
          : result.delivery_disposition === "cancelled"
            ? `Delivery to ${target} was cancelled before durable acknowledgement; delivery is indeterminate.`
            : result.queued === "followup"
              ? `Relayed to ${target} and queued as a follow-up.`
              : `Relayed to ${target}.`;

        return {
          content: [{ type: "text", text: statusText }],
          details: {
            tool: "chat",
            relayed: true,
            ...result,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error || "Cross-session chat relay failed.");
        return err(message || "Cross-session chat relay failed.");
      }
    },
  });
};
