import { describe, expect, test } from "bun:test";

import { createDirectChatToolRelayHandler } from "../../src/extensions/chat-tool-runtime.js";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeAgentPool(overrides: Record<string, unknown> = {}) {
  return {
    listActiveChats: () => [],
    listKnownChats: () => [
      { branch_id: "branch-source", chat_jid: "web:source", root_chat_jid: "web:source", parent_branch_id: null, agent_name: "source-handle" },
      { branch_id: "branch-target", chat_jid: "web:target", root_chat_jid: "web:source", parent_branch_id: "branch-source", agent_name: "research" },
    ],
    findChatByAgentName: (name: string) => name === "research"
      ? { chat_jid: "web:target", agent_name: "research" }
      : null,
    getAgentHandleForChat: (chatJid: string) => chatJid === "web:source" ? "source-handle" : "derived",
    ...overrides,
  } as any;
}

describe("direct chat tool runtime relay", () => {
  test("resolves source and target identities, forwards directly to target message route, and emits reply-to metadata", async () => {
    const forwarded: { url?: string; headers?: Record<string, string>; payload?: Record<string, unknown> } = {};
    const relay = createDirectChatToolRelayHandler(makeAgentPool(), {
      handleRequest: async (req) => {
        forwarded.url = req.url;
        forwarded.headers = Object.fromEntries(req.headers.entries());
        forwarded.payload = await req.json() as Record<string, unknown>;
        return jsonResponse({ queued: "followup", thread_id: null }, 201);
      },
    }, {
      defaultAgentId: "default",
      getAgentDisplayName: () => "Smith",
      getChatBranchByChatJid: () => null,
      getChatBranchByAgentName: (agentName) => agentName === "research"
        ? { branch_id: "branch-target", chat_jid: "web:target", root_chat_jid: "web:source", parent_branch_id: "branch-source", agent_name: "research" }
        : null,
    });

    const result = await relay({
      source_chat_jid: "web:source",
      target_agent_name: "@research",
      content: "  Please inspect this branch.  ",
      mode: "queue",
    });

    expect(forwarded.url).toBe("http://internal/agent/default/message?chat_jid=web%3Atarget");
    expect(forwarded.headers?.["reply-to"]).toBe("@source-handle <jid:web:source>");
    expect(forwarded.headers?.["x-piclaw-persist-steer"]).toBe("1");
    expect(forwarded.payload).toEqual({
      content: "From: Smith (@source-handle) <jid:web:source>\nReply-To: @source-handle <jid:web:source>\nTo: @research <jid:web:target>\n\nPlease inspect this branch.",
      content_blocks: [{
        type: "peer_message",
        relay: "chat_tool",
        source_chat_jid: "web:source",
        source_agent_name: "source-handle",
        source_agent_display_name: "Smith",
        target_chat_jid: "web:target",
        target_agent_name: "research",
        target_agent_display_name: "Smith",
        reply_to: {
          chat_jid: "web:source",
          agent_name: "source-handle",
          agent_display_name: "Smith",
          session_tree: {
            branch_id: "branch-source",
            chat_jid: "web:source",
            root_chat_jid: "web:source",
            parent_branch_id: null,
            agent_name: "source-handle",
          },
        },
        source_session_tree: {
          branch_id: "branch-source",
          chat_jid: "web:source",
          root_chat_jid: "web:source",
          parent_branch_id: null,
          agent_name: "source-handle",
        },
        target_session_tree: {
          branch_id: "branch-target",
          chat_jid: "web:target",
          root_chat_jid: "web:source",
          parent_branch_id: "branch-source",
          agent_name: "research",
        },
        body: "Please inspect this branch.",
      }],
      mode: "queue",
      persist_steer: true,
    });
    expect(result).toMatchObject({
      status: "ok",
      relayed: true,
      source_chat_jid: "web:source",
      source_agent_name: "source-handle",
      source_agent_display_name: "Smith",
      target_chat_jid: "web:target",
      target_agent_name: "research",
      target_agent_display_name: "Smith",
      reply_to: {
        chat_jid: "web:source",
        agent_name: "source-handle",
        agent_display_name: "Smith",
        session_tree: {
          branch_id: "branch-source",
          chat_jid: "web:source",
          root_chat_jid: "web:source",
          parent_branch_id: null,
          agent_name: "source-handle",
        },
      },
      source_session_tree: {
        branch_id: "branch-source",
        chat_jid: "web:source",
        root_chat_jid: "web:source",
        parent_branch_id: null,
        agent_name: "source-handle",
      },
      target_session_tree: {
        branch_id: "branch-target",
        chat_jid: "web:target",
        root_chat_jid: "web:source",
        parent_branch_id: "branch-source",
        agent_name: "research",
      },
      queued: "followup",
      thread_id: null,
    });
  });

  test("uses the trusted agent-message entry point when available instead of auth-guarded request routing", async () => {
    let handleAgentMessageCalled = false;
    let handleRequestCalled = false;
    const relay = createDirectChatToolRelayHandler(makeAgentPool(), {
      handleAgentMessage: async (req, pathname) => {
        handleAgentMessageCalled = true;
        expect(pathname).toBe("/agent/default/message");
        expect(req.url).toBe("http://internal/agent/default/message?chat_jid=web%3Atarget");
        return jsonResponse({ created: true, row_id: 123 }, 201);
      },
      handleRequest: async () => {
        handleRequestCalled = true;
        return jsonResponse({ error: "Unauthorized" }, 401);
      },
    }, {
      getAgentDisplayName: () => "Smith",
      getChatBranchByChatJid: () => null,
      getChatBranchByAgentName: () => null,
    });

    const result = await relay({
      source_chat_jid: "web:source",
      target_agent_name: "@research",
      content: "hello",
      mode: "auto",
    });

    expect(handleAgentMessageCalled).toBe(true);
    expect(handleRequestCalled).toBe(false);
    expect(result).toMatchObject({
      status: "ok",
      relayed: true,
      target_chat_jid: "web:target",
      target_agent_name: "research",
      created: true,
      row_id: 123,
    });
  });

  test("does not accept sender aliases from the request and rejects self-targets", async () => {
    const relay = createDirectChatToolRelayHandler(makeAgentPool(), {
      handleRequest: async () => jsonResponse({ created: true }, 201),
    }, { getAgentDisplayName: () => "Smith", getChatBranchByChatJid: () => null });

    await expect(relay({
      source_chat_jid: "web:source",
      target_chat_jid: "web:source",
      content: "hello",
      mode: "auto",
    })).rejects.toThrow("source_chat_jid and target chat must differ");

    const result = await relay({
      source_chat_jid: "web:source",
      target_chat_jid: "web:target",
      content: "hello",
      mode: "auto",
    });
    expect(result.source_agent_name).toBe("source-handle");
    expect(result.source_agent_display_name).toBe("Smith");
  });

  test("acknowledges a durable steer without waiting for the busy recipient handler to finish", async () => {
    let releaseRecipient!: () => void;
    const recipientGate = new Promise<void>((resolve) => { releaseRecipient = resolve; });
    let handlerFinished = false;
    const relay = createDirectChatToolRelayHandler(makeAgentPool(), {
      handleAgentMessage: async (_req: Request, _pathname: string, onAccepted?: (value: unknown) => void) => {
        onAccepted?.({ chat_jid: "web:target", row_id: 77, thread_id: 77, created: true });
        await recipientGate;
        handlerFinished = true;
        return jsonResponse({ queued: "steer", row_id: 77, created: true }, 201);
      },
    } as any, {
      ackTimeoutMs: 50,
      getAgentDisplayName: () => "Smith",
      getChatBranchByChatJid: () => null,
      getChatBranchByAgentName: () => null,
    } as any);

    const result = await Promise.race([
      relay({ source_chat_jid: "web:source", target_agent_name: "research", content: "act now", mode: "steer" }),
      Bun.sleep(100).then(() => { throw new Error("sender stayed blocked"); }),
    ]);
    expect(result).toMatchObject({
      status: "ok", relayed: true, target_chat_jid: "web:target", row_id: 77,
      acknowledged: true, delivery_disposition: "accepted",
    });
    expect(handlerFinished).toBe(false);
    releaseRecipient();
    await Bun.sleep(0);
  });

  test("returns an explicit indeterminate result when durable acknowledgement times out", async () => {
    const relay = createDirectChatToolRelayHandler(makeAgentPool(), {
      handleAgentMessage: async () => await new Promise<Response>(() => {}),
    }, {
      ackTimeoutMs: 15,
      getAgentDisplayName: () => "Smith",
      getChatBranchByChatJid: () => null,
      getChatBranchByAgentName: () => null,
    } as any);

    const result = await Promise.race([
      relay({ source_chat_jid: "web:source", target_agent_name: "research", content: "uncertain", mode: "steer" }),
      Bun.sleep(100).then(() => { throw new Error("relay timeout was unbounded"); }),
    ]);
    expect(result).toMatchObject({
      status: "indeterminate", relayed: false, acknowledged: false, timed_out: true,
      delivery_disposition: "indeterminate", target_chat_jid: "web:target",
    });
  });

  test("deduplicates indeterminate retries by idempotency key and rejects conflicting reuse", async () => {
    let handlerCalls = 0;
    const relay = createDirectChatToolRelayHandler(makeAgentPool(), {
      handleAgentMessage: async () => {
        handlerCalls += 1;
        return await new Promise<Response>(() => {});
      },
    }, {
      ackTimeoutMs: 10,
      getAgentDisplayName: () => "Smith",
      getChatBranchByChatJid: () => null,
      getChatBranchByAgentName: () => null,
    } as any);
    const request = {
      source_chat_jid: "web:source", target_agent_name: "research", content: "once", mode: "steer",
      idempotency_key: "relay-once",
    } as any;

    const first = await relay(request);
    const retry = await relay(request);
    expect(first).toMatchObject({ status: "indeterminate", timed_out: true });
    expect(retry).toEqual(first);
    expect(handlerCalls).toBe(1);
    await expect(relay({ ...request, content: "different" })).rejects.toThrow("idempotency key");
    expect(handlerCalls).toBe(1);
  });

  test("bounds idempotency retention without evicting unresolved deliveries", async () => {
    let clock = 0;
    let handlerCalls = 0;
    const acceptByKey = new Map<string, (value: any) => void>();
    const relay = createDirectChatToolRelayHandler(makeAgentPool(), {
      handleAgentMessage: async (req, _pathname, onAccepted) => {
        handlerCalls += 1;
        acceptByKey.set(req.headers.get("x-piclaw-idempotency-key")!, onAccepted!);
        return await new Promise<Response>(() => {});
      },
    }, {
      ackTimeoutMs: 5,
      idempotencyMaxEntries: 2,
      idempotencyRetentionMs: 10,
      now: () => clock,
      getAgentDisplayName: () => "Smith",
      getChatBranchByChatJid: () => null,
      getChatBranchByAgentName: () => null,
    });
    const request = (key: string) => ({
      source_chat_jid: "web:source", target_agent_name: "research", content: key, mode: "steer" as const,
      idempotency_key: key,
    });

    const first = await relay(request("key-a"));
    await relay(request("key-b"));
    expect(handlerCalls).toBe(2);

    clock = 100;
    expect(await relay(request("key-a"))).toEqual(first);
    await expect(relay(request("key-c"))).rejects.toThrow("idempotency capacity (2) is exhausted");
    expect(handlerCalls).toBe(2);

    acceptByKey.get("key-a")!({
      chat_jid: "web:target", row_id: 83, thread_id: 83, accepted_at: "now", created: true,
    });
    expect(await relay(request("key-a"))).toMatchObject({
      status: "ok", row_id: 83, acknowledged: true, delivery_disposition: "accepted",
    });
    expect(handlerCalls).toBe(2);

    clock = 111;
    expect(await relay(request("key-c"))).toMatchObject({ status: "indeterminate", timed_out: true });
    expect(handlerCalls).toBe(3);
    await expect(relay(request("key-d"))).rejects.toThrow("idempotency capacity (2) is exhausted");
    expect(handlerCalls).toBe(3);
  });

  test("keeps timed-out attempts unresolved after an unacknowledged forward completion", async () => {
    let clock = 0;
    let handlerCalls = 0;
    let settleFirst!: (response: Response) => void;
    const relay = createDirectChatToolRelayHandler(makeAgentPool(), {
      handleAgentMessage: async () => {
        handlerCalls += 1;
        return await new Promise<Response>((resolve) => { settleFirst = resolve; });
      },
    }, {
      ackTimeoutMs: 5,
      idempotencyMaxEntries: 1,
      idempotencyRetentionMs: 10,
      now: () => clock,
      getAgentDisplayName: () => "Smith",
      getChatBranchByChatJid: () => null,
      getChatBranchByAgentName: () => null,
    });
    const request = (key: string) => ({
      source_chat_jid: "web:source", target_agent_name: "research", content: key, mode: "steer" as const,
      idempotency_key: key,
    });

    const first = await relay(request("unresolved"));
    settleFirst(jsonResponse({ row_id: 84, created: true }, 201));
    await Bun.sleep(0);

    clock = 100;
    expect(await relay(request("unresolved"))).toEqual(first);
    await expect(relay(request("blocked"))).rejects.toThrow("idempotency capacity (1) is exhausted");
    expect(handlerCalls).toBe(1);
  });

  test("does not redeliver after acknowledged delivery later fails in recipient handling", async () => {
    let handlerCalls = 0;
    let rejectRecipient!: (error: Error) => void;
    const relay = createDirectChatToolRelayHandler(makeAgentPool(), {
      handleAgentMessage: async (_req, _pathname, onAccepted) => {
        handlerCalls += 1;
        onAccepted?.({ chat_jid: "web:target", row_id: 79, thread_id: 79, accepted_at: "now", created: true });
        return await new Promise<Response>((_resolve, reject) => { rejectRecipient = reject; });
      },
    }, {
      ackTimeoutMs: 10,
      getAgentDisplayName: () => "Smith",
      getChatBranchByChatJid: () => null,
      getChatBranchByAgentName: () => null,
    });
    const request = {
      source_chat_jid: "web:source", target_agent_name: "research", content: "accepted once", mode: "steer" as const,
      idempotency_key: "accepted-then-failed",
    };

    const accepted = await relay(request);
    rejectRecipient(new Error("recipient failed after persistence"));
    await Bun.sleep(0);
    expect(await relay(request)).toEqual(accepted);
    expect(handlerCalls).toBe(1);
  });

  test("retains an unacknowledged successful response through TTL and reconciles a late acceptance", async () => {
    let clock = 0;
    let handlerCalls = 0;
    let accept!: (value: any) => void;
    const relay = createDirectChatToolRelayHandler(makeAgentPool(), {
      handleAgentMessage: async (_req, _pathname, onAccepted) => {
        handlerCalls += 1;
        accept = onAccepted!;
        return jsonResponse({ row_id: 80, created: true }, 201);
      },
    }, {
      ackTimeoutMs: 10,
      idempotencyMaxEntries: 1,
      idempotencyRetentionMs: 10,
      now: () => clock,
      getAgentDisplayName: () => "Smith",
      getChatBranchByChatJid: () => null,
      getChatBranchByAgentName: () => null,
    });
    const request = {
      source_chat_jid: "web:source", target_agent_name: "research", content: "no ack", mode: "steer" as const,
      idempotency_key: "no-ack",
    };

    const first = await relay(request);
    expect(first).toMatchObject({
      status: "indeterminate", relayed: false, acknowledged: false,
      delivery_disposition: "indeterminate", row_id: 80,
    });

    clock = 100;
    expect(await relay(request)).toEqual(first);
    await expect(relay({ ...request, idempotency_key: "blocked" })).rejects.toThrow("idempotency capacity (1) is exhausted");
    expect(handlerCalls).toBe(1);

    accept({ chat_jid: "web:target", row_id: 80, thread_id: 80, accepted_at: "now", created: true });
    expect(await relay(request)).toMatchObject({
      status: "ok", row_id: 80, acknowledged: true, delivery_disposition: "accepted",
    });
    expect(handlerCalls).toBe(1);
  });

  test("allows an idempotent retry after deferred pre-acceptance failure", async () => {
    let handlerCalls = 0;
    let rejectFirst!: (error: Error) => void;
    const relay = createDirectChatToolRelayHandler(makeAgentPool(), {
      handleAgentMessage: async (_req, _pathname, onAccepted) => {
        handlerCalls += 1;
        if (handlerCalls === 1) {
          return await new Promise<Response>((_resolve, reject) => { rejectFirst = reject; });
        }
        onAccepted?.({ chat_jid: "web:target", row_id: 80, thread_id: 80, accepted_at: "now", created: true });
        return await new Promise<Response>(() => {});
      },
    }, {
      ackTimeoutMs: 10,
      getAgentDisplayName: () => "Smith",
      getChatBranchByChatJid: () => null,
      getChatBranchByAgentName: () => null,
    });
    const request = {
      source_chat_jid: "web:source", target_agent_name: "research", content: "retry", mode: "steer" as const,
      idempotency_key: "retry-after-failure",
    };

    expect(await relay(request)).toMatchObject({ status: "indeterminate", timed_out: true });
    rejectFirst(new Error("failed before persistence"));
    await Bun.sleep(0);
    expect(await relay(request)).toMatchObject({
      status: "ok", row_id: 80, acknowledged: true, delivery_disposition: "accepted",
    });
    expect(handlerCalls).toBe(2);
  });

  test("reconciles a late acknowledgement without redelivering an idempotent retry", async () => {
    let handlerCalls = 0;
    let accept!: (value: any) => void;
    const relay = createDirectChatToolRelayHandler(makeAgentPool(), {
      handleAgentMessage: async (_req, _pathname, onAccepted) => {
        handlerCalls += 1;
        accept = onAccepted!;
        return await new Promise<Response>(() => {});
      },
    }, {
      ackTimeoutMs: 10,
      getAgentDisplayName: () => "Smith",
      getChatBranchByChatJid: () => null,
      getChatBranchByAgentName: () => null,
    });
    const request = {
      source_chat_jid: "web:source", target_agent_name: "research", content: "once", mode: "steer" as const,
      idempotency_key: "late-ack",
    };

    expect(await relay(request)).toMatchObject({ status: "indeterminate", timed_out: true });
    accept({ chat_jid: "web:target", row_id: 81, thread_id: 81, accepted_at: "now", created: true });
    expect(await relay(request)).toMatchObject({
      status: "ok", row_id: 81, acknowledged: true, delivery_disposition: "accepted",
    });
    expect(handlerCalls).toBe(1);
  });

  test("keeps queue mode coupled to the recipient response", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const relay = createDirectChatToolRelayHandler(makeAgentPool(), {
      handleAgentMessage: async (_req, _pathname, onAccepted) => {
        onAccepted?.({ chat_jid: "web:target", row_id: 82, thread_id: 82, accepted_at: "now", created: true });
        await gate;
        return jsonResponse({ queued: "followup", row_id: 82, created: true }, 201);
      },
    }, {
      ackTimeoutMs: 10,
      getAgentDisplayName: () => "Smith",
      getChatBranchByChatJid: () => null,
      getChatBranchByAgentName: () => null,
    });

    const pending = relay({ source_chat_jid: "web:source", target_agent_name: "research", content: "later", mode: "queue" });
    const returnedEarly = await Promise.race([pending.then(() => true), Bun.sleep(15).then(() => false)]);
    expect(returnedEarly).toBe(false);
    release();
    expect(await pending).toMatchObject({ status: "ok", relayed: true, queued: "followup" });
  });

  test("reports cancellation before acknowledgement as indeterminate delivery", async () => {
    const controller = new AbortController();
    const relay = createDirectChatToolRelayHandler(makeAgentPool(), {
      handleAgentMessage: async () => await new Promise<Response>(() => {}),
    }, {
      ackTimeoutMs: 100,
      getAgentDisplayName: () => "Smith",
      getChatBranchByChatJid: () => null,
      getChatBranchByAgentName: () => null,
    });
    controller.abort();

    const result = await relay({
      source_chat_jid: "web:source", target_agent_name: "research", content: "cancel", mode: "steer",
      signal: controller.signal,
    });
    expect(result).toMatchObject({
      status: "cancelled", relayed: false, acknowledged: false, delivery_disposition: "cancelled",
    });
  });

  test("rejects unknown destinations instead of routing to unverified chats", async () => {
    const relay = createDirectChatToolRelayHandler(makeAgentPool({
      listKnownChats: () => [{ chat_jid: "web:source", agent_name: "source-handle" }],
      findChatByAgentName: () => null,
    }), {
      handleRequest: async () => jsonResponse({ created: true }, 201),
    }, { getAgentDisplayName: () => "Smith", getChatBranchByChatJid: () => null });

    await expect(relay({
      source_chat_jid: "web:source",
      target_agent_name: "unknown",
      content: "hello",
      mode: "auto",
    })).rejects.toThrow("Unknown target agent: unknown");

    await expect(relay({
      source_chat_jid: "web:source",
      target_chat_jid: "web:not-registered",
      content: "hello",
      mode: "auto",
    })).rejects.toThrow("Unknown target chat: web:not-registered");
  });
});
