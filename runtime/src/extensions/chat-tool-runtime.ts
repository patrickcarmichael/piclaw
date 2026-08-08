/**
 * chat-tool-runtime – direct runtime relay for the built-in chat tool.
 *
 * This intentionally does not use the web peer relay endpoint. The chat tool is already
 * running inside a trusted session context, so the runtime resolves source and
 * destination identities itself, then delivers a normal message to the target
 * chat with a structured reply-to descriptor.
 */
import type { AgentPool } from "../agent-pool.js";
import type {
  AgentMessageAcceptance,
  AgentMessageAcceptanceHandler,
} from "../channels/web/messaging/agent-message-acceptance.js";
import { getIdentityConfig } from "../core/config.js";
import { getChatBranchByAgentName, getChatBranchByChatJid } from "../db.js";
import { createLogger, debugSuppressedError } from "../utils/logger.js";
import type { ChatRelayRequest, ChatRelayResult } from "./chat-tool.js";

const log = createLogger("extensions.chat-tool-runtime");

type ChatRelayMode = "auto" | "queue" | "steer";

type ChatIdentity = {
  chat_jid: string;
  agent_name: string;
  agent_display_name: string;
  branch_id?: string | null;
  root_chat_jid?: string | null;
  parent_branch_id?: string | null;
};

type ChatBranchLike = {
  branch_id?: string | null;
  chat_jid: string;
  root_chat_jid?: string | null;
  parent_branch_id?: string | null;
  agent_name: string;
};

type ChatToolRelayAgentPool = Pick<AgentPool, "findChatByAgentName" | "getAgentHandleForChat" | "listActiveChats" | "listKnownChats">;

type DirectChatToolRelayWeb = {
  handleAgentMessage?: (
    req: Request,
    pathname: string,
    onAccepted?: AgentMessageAcceptanceHandler,
  ) => Promise<Response>;
  handleRequest?: (req: Request) => Promise<Response>;
};

type DirectChatToolRelayOptions = {
  defaultAgentId?: string;
  getAgentDisplayName?: () => string | null | undefined;
  getChatBranchByChatJid?: (chatJid: string) => ChatBranchLike | null;
  getChatBranchByAgentName?: (agentName: string) => ChatBranchLike | null;
  ackTimeoutMs?: number;
  idempotencyMaxEntries?: number;
  idempotencyRetentionMs?: number;
  now?: () => number;
};

function fallbackPeerAgentHandle(chatJid: string): string {
  return (chatJid.split(/[:/]/).filter(Boolean).pop() || chatJid).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || "agent";
}

function normalizeAgentName(value: string | undefined): string {
  return String(value || "").trim().replace(/^@+/, "").trim();
}

function getRuntimeAgentDisplayName(options?: DirectChatToolRelayOptions): string {
  const configured = options?.getAgentDisplayName?.();
  if (configured && configured.trim()) return configured.trim();
  return getIdentityConfig().assistantName || "PiClaw";
}

function identityFromBranch(branch: ChatBranchLike, displayName: string): ChatIdentity {
  return {
    chat_jid: branch.chat_jid,
    agent_name: branch.agent_name,
    agent_display_name: displayName,
    branch_id: branch.branch_id ?? null,
    root_chat_jid: branch.root_chat_jid ?? branch.chat_jid,
    parent_branch_id: branch.parent_branch_id ?? null,
  };
}

function resolveChatIdentity(
  agentPool: ChatToolRelayAgentPool,
  chatJid: string,
  displayName: string,
  options: {
    allowDerivedFallback?: boolean;
    getChatBranchByChatJid?: DirectChatToolRelayOptions["getChatBranchByChatJid"];
  } = {},
): ChatIdentity | null {
  const normalized = chatJid.trim();
  if (!normalized) return null;

  try {
    const branch = (options.getChatBranchByChatJid || getChatBranchByChatJid)(normalized);
    if (branch?.agent_name) return identityFromBranch(branch, displayName);
  } catch (error) {
    debugSuppressedError(log, "Failed to resolve chat branch while handling chat tool relay; falling back to AgentPool state.", error, {
      operation: "chat_tool_runtime.resolve_chat_branch",
      chatJid: normalized,
    });
  }

  const active = agentPool.listActiveChats().find((chat) => chat.chat_jid === normalized);
  if (active?.agent_name) return identityFromBranch(active, displayName);

  const known = agentPool.listKnownChats().find((chat) => chat.chat_jid === normalized);
  if (known?.agent_name) return identityFromBranch(known, displayName);

  if (!options.allowDerivedFallback) return null;
  const derived = agentPool.getAgentHandleForChat(normalized) || fallbackPeerAgentHandle(normalized);
  return {
    chat_jid: normalized,
    agent_name: derived,
    agent_display_name: displayName,
    branch_id: null,
    root_chat_jid: normalized,
    parent_branch_id: null,
  };
}

function resolveTargetIdentity(
  agentPool: ChatToolRelayAgentPool,
  request: ChatRelayRequest,
  displayName: string,
  options: DirectChatToolRelayOptions,
): ChatIdentity | null {
  const targetChatJid = request.target_chat_jid?.trim() || "";
  if (targetChatJid) return resolveChatIdentity(agentPool, targetChatJid, displayName, {
    getChatBranchByChatJid: options.getChatBranchByChatJid,
  });

  const targetAgentName = normalizeAgentName(request.target_agent_name);
  if (!targetAgentName) return null;

  try {
    const branch = (options.getChatBranchByAgentName || getChatBranchByAgentName)(targetAgentName);
    if (branch?.agent_name) return identityFromBranch(branch, displayName);
  } catch (error) {
    debugSuppressedError(log, "Failed to resolve chat branch alias while handling chat tool relay; falling back to AgentPool state.", error, {
      operation: "chat_tool_runtime.resolve_agent_alias",
      agentName: targetAgentName,
    });
  }

  const found = agentPool.findChatByAgentName(targetAgentName);
  if (!found?.chat_jid || !found.agent_name) return null;
  return resolveChatIdentity(agentPool, found.chat_jid, displayName, {
    getChatBranchByChatJid: options.getChatBranchByChatJid,
  }) || identityFromBranch(found, displayName);
}

function buildSessionTreeDescriptor(identity: ChatIdentity): Record<string, unknown> {
  return {
    branch_id: identity.branch_id ?? null,
    chat_jid: identity.chat_jid,
    root_chat_jid: identity.root_chat_jid ?? identity.chat_jid,
    parent_branch_id: identity.parent_branch_id ?? null,
    agent_name: identity.agent_name,
  };
}

function buildReplyToDescriptor(source: ChatIdentity): Record<string, unknown> {
  return {
    chat_jid: source.chat_jid,
    agent_name: source.agent_name,
    agent_display_name: source.agent_display_name,
    session_tree: buildSessionTreeDescriptor(source),
  };
}

function buildPeerRelayBlock(input: {
  source: ChatIdentity;
  target: ChatIdentity;
  body: string;
}): Record<string, unknown> {
  return {
    type: "peer_message",
    relay: "chat_tool",
    source_chat_jid: input.source.chat_jid,
    source_agent_name: input.source.agent_name,
    source_agent_display_name: input.source.agent_display_name,
    target_chat_jid: input.target.chat_jid,
    target_agent_name: input.target.agent_name,
    target_agent_display_name: input.target.agent_display_name,
    reply_to: buildReplyToDescriptor(input.source),
    source_session_tree: buildSessionTreeDescriptor(input.source),
    target_session_tree: buildSessionTreeDescriptor(input.target),
    body: input.body,
  };
}

function buildForwardedContent(source: ChatIdentity, target: ChatIdentity, content: string): string {
  return [
    `From: ${source.agent_display_name} (@${source.agent_name}) <jid:${source.chat_jid}>`,
    `Reply-To: @${source.agent_name} <jid:${source.chat_jid}>`,
    `To: @${target.agent_name} <jid:${target.chat_jid}>`,
    "",
    content,
  ].join("\n");
}

function normalizeMode(mode: ChatRelayMode | undefined): ChatRelayMode {
  return mode === "queue" || mode === "steer" || mode === "auto" ? mode : "auto";
}

function readForwardedMessageRowId(responseBody: Record<string, unknown>): number | null {
  if (Number.isInteger(responseBody.row_id) && Number(responseBody.row_id) > 0) return Number(responseBody.row_id);
  const userMessage = responseBody.user_message;
  if (userMessage && typeof userMessage === "object") {
    const id = (userMessage as { id?: unknown }).id;
    if (Number.isInteger(id) && Number(id) > 0) return Number(id);
  }
  return null;
}

function readForwardedCreated(responseBody: Record<string, unknown>): boolean | undefined {
  if (typeof responseBody.created === "boolean") return responseBody.created;
  return responseBody.user_message && typeof responseBody.user_message === "object" ? true : undefined;
}

export function createDirectChatToolRelayHandler(
  agentPool: ChatToolRelayAgentPool,
  web: DirectChatToolRelayWeb,
  options: DirectChatToolRelayOptions = {},
): (request: ChatRelayRequest) => Promise<ChatRelayResult> {
  const defaultAgentId = options.defaultAgentId || "default";
  const ackTimeoutMs = Math.max(1, Math.floor(options.ackTimeoutMs ?? 5_000));
  const idempotencyMaxEntries = Math.max(1, Math.floor(options.idempotencyMaxEntries ?? 1_024));
  const idempotencyRetentionMs = Math.max(1, Math.floor(options.idempotencyRetentionMs ?? 10 * 60_000));
  const now = options.now ?? Date.now;
  type IdempotentAttempt = {
    fingerprint: string;
    promise: Promise<ChatRelayResult>;
    latestResult?: ChatRelayResult;
    settledAt?: number;
  };
  const idempotentAttempts = new Map<string, IdempotentAttempt>();
  const pruneExpiredIdempotentAttempts = () => {
    const cutoff = now() - idempotencyRetentionMs;
    for (const [key, attempt] of idempotentAttempts) {
      if (attempt.settledAt !== undefined && attempt.settledAt <= cutoff) {
        idempotentAttempts.delete(key);
      }
    }
  };

  return async (request) => {
    const displayName = getRuntimeAgentDisplayName(options);
    const source = resolveChatIdentity(agentPool, request.source_chat_jid, displayName, {
      allowDerivedFallback: true,
      getChatBranchByChatJid: options.getChatBranchByChatJid,
    });
    if (!source) throw new Error(`Unknown source chat: ${request.source_chat_jid}`);

    const target = resolveTargetIdentity(agentPool, request, displayName, options);
    if (!target) {
      throw new Error(request.target_agent_name
        ? `Unknown target agent: ${normalizeAgentName(request.target_agent_name)}`
        : `Unknown target chat: ${request.target_chat_jid || ""}`);
    }
    if (source.chat_jid === target.chat_jid) throw new Error("source_chat_jid and target chat must differ");

    const mode = normalizeMode(request.mode);
    const content = request.content.trim();
    const idempotencyKey = request.idempotency_key?.trim() || "";
    const cacheKey = idempotencyKey ? `${source.chat_jid}\0${idempotencyKey}` : "";
    const fingerprint = JSON.stringify({
      target_chat_jid: target.chat_jid,
      content,
      mode,
      in_reply_to: request.in_reply_to?.trim() || null,
    });
    if (cacheKey) pruneExpiredIdempotentAttempts();
    const existing = cacheKey ? idempotentAttempts.get(cacheKey) : undefined;
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new Error(`The idempotency key "${idempotencyKey}" was already used for a different chat relay request.`);
      }
      return existing.latestResult ?? existing.promise;
    }
    if (cacheKey && idempotentAttempts.size >= idempotencyMaxEntries) {
      log.warn("Cross-session chat idempotency capacity is exhausted.", {
        operation: "chat_tool_relay.idempotency_capacity_exhausted",
        sourceChatJid: source.chat_jid,
        targetChatJid: target.chat_jid,
        idempotencyMaxEntries,
      });
      throw new Error(
        `Cross-session chat idempotency capacity (${idempotencyMaxEntries}) is exhausted; ` +
        "retry an existing idempotency_key after unresolved deliveries settle.",
      );
    }

    let entry: IdempotentAttempt | undefined;

    const deliver = async (): Promise<ChatRelayResult> => {
      const replyTo = buildReplyToDescriptor(source);
      const resultIdentity = {
        source_chat_jid: source.chat_jid,
        source_agent_name: source.agent_name,
        source_agent_display_name: source.agent_display_name,
        target_chat_jid: target.chat_jid,
        target_agent_name: target.agent_name,
        target_agent_display_name: target.agent_display_name,
        reply_to: replyTo,
        source_session_tree: buildSessionTreeDescriptor(source),
        target_session_tree: buildSessionTreeDescriptor(target),
        ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
      };
      const contentBlocks = [buildPeerRelayBlock({ source, target, body: content })];
      const pathname = `/agent/${defaultAgentId}/message`;
      const headers = new Headers({
        "Content-Type": "application/json",
        "Reply-To": `@${source.agent_name} <jid:${source.chat_jid}>`,
        "X-Piclaw-Source-Chat-Jid": source.chat_jid,
        "X-Piclaw-Source-Agent-Name": source.agent_name,
        "X-Piclaw-Reply-To-Chat-Jid": source.chat_jid,
        "X-Piclaw-Persist-Steer": "1",
      });
      if (idempotencyKey) headers.set("X-Piclaw-Idempotency-Key", idempotencyKey);
      const forwardReq = new Request(
        `http://internal${pathname}?chat_jid=${encodeURIComponent(target.chat_jid)}`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            content: buildForwardedContent(source, target, content),
            content_blocks: contentBlocks,
            mode,
            persist_steer: true,
          }),
        },
      );

      const responseResult = async (forwardRes: Response): Promise<ChatRelayResult> => {
        if (!forwardRes.ok) {
          const body = await forwardRes.json().catch(() => ({} as Record<string, unknown>));
          const message = typeof body.error === "string" ? body.error : `Cross-session chat relay failed (${forwardRes.status}).`;
          log.warn("Cross-session chat relay was rejected before acceptance.", {
            operation: "chat_tool_relay.rejected",
            sourceChatJid: source.chat_jid,
            targetChatJid: target.chat_jid,
            status: forwardRes.status,
            idempotencyKey: idempotencyKey || undefined,
          });
          throw new Error(message);
        }

        const responseBody = await forwardRes.json().catch(() => ({} as Record<string, unknown>));
        const rowId = readForwardedMessageRowId(responseBody);
        const created = readForwardedCreated(responseBody);
        return {
          status: "ok",
          ...responseBody,
          ...(rowId ? { row_id: rowId } : {}),
          ...(created !== undefined ? { created } : {}),
          ...resultIdentity,
          relayed: true,
        };
      };

      if (mode !== "steer") {
        const forwardRes = typeof web.handleAgentMessage === "function"
          ? await web.handleAgentMessage(forwardReq, pathname)
          : await web.handleRequest?.(forwardReq);
        if (!forwardRes) throw new Error("Cross-session chat relay is unavailable in this runtime.");
        return await responseResult(forwardRes);
      }

      let terminalDisposition: "pending" | "accepted" | "indeterminate" | "cancelled" | "rejected" = "pending";
      let resolveAcceptance!: (acceptance: AgentMessageAcceptance) => void;
      const acceptancePromise = new Promise<AgentMessageAcceptance>((resolve) => {
        resolveAcceptance = resolve;
      });
      const onAccepted: AgentMessageAcceptanceHandler = (acceptance) => {
        const acceptedResult: ChatRelayResult = {
          status: "ok",
          ...resultIdentity,
          row_id: acceptance.row_id,
          thread_id: acceptance.thread_id,
          accepted_at: acceptance.accepted_at,
          created: acceptance.created,
          relayed: true,
          acknowledged: true,
          delivery_disposition: "accepted",
        };
        if (entry) {
          entry.latestResult = acceptedResult;
          entry.settledAt ??= now();
        }
        log.info("Cross-session steer received durable target acceptance.", {
          operation: terminalDisposition === "pending"
            ? "chat_tool_relay.acknowledged"
            : "chat_tool_relay.late_acknowledged",
          sourceChatJid: source.chat_jid,
          targetChatJid: target.chat_jid,
          rowId: acceptance.row_id,
          idempotencyKey: idempotencyKey || undefined,
        });
        resolveAcceptance(acceptance);
      };

      if (typeof web.handleAgentMessage !== "function") {
        throw new Error("Cross-session steer requires the trusted durable-acceptance entry point in this runtime.");
      }
      const forwardPromise = web.handleAgentMessage(forwardReq, pathname, onAccepted);

      const responsePromise = forwardPromise.then(
        (response) => ({ kind: "response" as const, response }),
        (error) => ({ kind: "error" as const, error }),
      );
      const observeDeferredCompletion = (initialDisposition: "accepted" | "indeterminate" | "cancelled") => {
        void responsePromise.then((completion) => {
          if (completion.kind === "error" || !completion.response.ok) {
            if (entry && !entry.latestResult && cacheKey && idempotentAttempts.get(cacheKey) === entry) {
              idempotentAttempts.delete(cacheKey);
            }
            log.error("Cross-session steer failed after the sender stopped waiting.", {
              operation: "chat_tool_relay.deferred_delivery_failed",
              sourceChatJid: source.chat_jid,
              targetChatJid: target.chat_jid,
              initialDisposition,
              idempotencyKey: idempotencyKey || undefined,
              ...(completion.kind === "error"
                ? { err: completion.error }
                : { status: completion.response.status }),
            });
            return;
          }
          if (entry && cacheKey && idempotentAttempts.get(cacheKey) === entry) {
            entry.settledAt ??= now();
          }
          log.info("Cross-session steer recipient handling completed after sender acknowledgement.", {
            operation: "chat_tool_relay.deferred_delivery_completed",
            sourceChatJid: source.chat_jid,
            targetChatJid: target.chat_jid,
            initialDisposition,
            idempotencyKey: idempotencyKey || undefined,
          });
        });
      };
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<{ kind: "timeout" }>((resolve) => {
        timeout = setTimeout(() => resolve({ kind: "timeout" }), ackTimeoutMs);
      });
      let abortHandler: (() => void) | undefined;
      const abortPromise = request.signal
        ? new Promise<{ kind: "cancelled" }>((resolve) => {
            if (request.signal?.aborted) {
              resolve({ kind: "cancelled" });
              return;
            }
            abortHandler = () => resolve({ kind: "cancelled" });
            request.signal?.addEventListener("abort", abortHandler, { once: true });
          })
        : new Promise<never>(() => {});
      const outcome = await Promise.race([
        acceptancePromise.then((acceptance) => ({ kind: "accepted" as const, acceptance })),
        responsePromise,
        timeoutPromise,
        abortPromise,
      ]);
      if (timeout) clearTimeout(timeout);
      if (abortHandler) request.signal?.removeEventListener("abort", abortHandler);

      if (outcome.kind === "accepted") {
        terminalDisposition = "accepted";
        observeDeferredCompletion("accepted");
        return entry?.latestResult ?? {
          status: "ok",
          ...resultIdentity,
          row_id: outcome.acceptance.row_id,
          thread_id: outcome.acceptance.thread_id,
          accepted_at: outcome.acceptance.accepted_at,
          created: true,
          relayed: true,
          acknowledged: true,
          delivery_disposition: "accepted",
        };
      }
      if (outcome.kind === "response") {
        try {
          const result = await responseResult(outcome.response);
          terminalDisposition = "indeterminate";
          log.warn("Cross-session steer completed without durable acceptance acknowledgement.", {
            operation: "chat_tool_relay.acknowledgement_missing",
            sourceChatJid: source.chat_jid,
            targetChatJid: target.chat_jid,
            idempotencyKey: idempotencyKey || undefined,
          });
          return {
            ...result,
            status: "indeterminate",
            relayed: false,
            acknowledged: false,
            delivery_disposition: "indeterminate",
          };
        } catch (error) {
          terminalDisposition = "rejected";
          throw error;
        }
      }
      if (outcome.kind === "error") {
        terminalDisposition = "rejected";
        log.warn("Cross-session chat relay failed before durable acceptance.", {
          operation: "chat_tool_relay.rejected",
          sourceChatJid: source.chat_jid,
          targetChatJid: target.chat_jid,
          idempotencyKey: idempotencyKey || undefined,
          err: outcome.error,
        });
        throw outcome.error;
      }
      if (outcome.kind === "cancelled") {
        terminalDisposition = "cancelled";
        observeDeferredCompletion("cancelled");
        log.warn("Cross-session steer was cancelled before durable acknowledgement.", {
          operation: "chat_tool_relay.cancelled",
          sourceChatJid: source.chat_jid,
          targetChatJid: target.chat_jid,
          idempotencyKey: idempotencyKey || undefined,
        });
        return {
          status: "cancelled",
          ...resultIdentity,
          relayed: false,
          acknowledged: false,
          delivery_disposition: "cancelled",
        };
      }

      terminalDisposition = "indeterminate";
      observeDeferredCompletion("indeterminate");
      log.warn("Cross-session steer acknowledgement timed out; delivery is indeterminate.", {
        operation: "chat_tool_relay.timed_out",
        sourceChatJid: source.chat_jid,
        targetChatJid: target.chat_jid,
        ackTimeoutMs,
        idempotencyKey: idempotencyKey || undefined,
      });
      return {
        status: "indeterminate",
        ...resultIdentity,
        relayed: false,
        acknowledged: false,
        delivery_disposition: "indeterminate",
        timed_out: true,
      };
    };

    if (cacheKey) {
      // Reserve capacity before delivery starts so a synchronous acceptance
      // callback can reconcile this exact entry without a registration gap.
      entry = {
        fingerprint,
        promise: Promise.resolve(undefined as never),
      };
      idempotentAttempts.set(cacheKey, entry);
    }
    const promise = deliver().then((result) => {
      if (entry && result.acknowledged && result.delivery_disposition === "accepted") {
        entry.latestResult = result;
        entry.settledAt ??= now();
      } else if (entry && (
        mode !== "steer"
        || (result.delivery_disposition === "indeterminate" && result.timed_out !== true)
      )) {
        entry.settledAt ??= now();
      }
      return result;
    }).catch((error) => {
      if (cacheKey && (!entry || idempotentAttempts.get(cacheKey) === entry)) {
        idempotentAttempts.delete(cacheKey);
      }
      throw error;
    });
    if (entry) entry.promise = promise;
    return await promise;
  };
}

export const __chatToolRuntimeInternals = {
  buildForwardedContent,
  buildPeerRelayBlock,
  buildReplyToDescriptor,
};
