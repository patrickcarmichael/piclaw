import { describe, expect, test } from "bun:test";

import { WebAgentMessageEntryService } from "../../../../src/channels/web/messaging/agent-message-entry-service.js";
import { createTrustedAgentMessageRequestContext } from "../../../../src/channels/web/messaging/agent-message-provenance.js";

describe("WebAgentMessageEntryService", () => {
  test("parses chat_jid and falls back to the default chat before forwarding", async () => {
    const calls: Array<{ req: Request; pathname: string; chatJid: string; agentId: string }> = [];
    const service = new WebAgentMessageEntryService({
      defaultChatJid: "web:default",
      defaultAgentId: "default",
      forwardAgentMessageRequest: async (req, pathname, chatJid, agentId) => {
        calls.push({ req, pathname, chatJid, agentId });
        return Response.json({ pathname, chat_jid: chatJid, agent_id: agentId }, { status: 201 });
      },
    });

    const explicitRequest = new Request("https://example.com/agent/custom/message?chat_jid=web%3Abranch", { method: "POST" });
    const explicitResponse = await service.handleAgentMessage(explicitRequest, "/agent/custom/message");
    expect(explicitResponse.status).toBe(201);
    expect(await explicitResponse.json()).toEqual({
      pathname: "/agent/custom/message",
      chat_jid: "web:branch",
      agent_id: "default",
    });

    const fallbackRequest = new Request("https://example.com/agent/default/message?chat_jid=%20%20", { method: "POST" });
    const fallbackResponse = await service.handleAgentMessage(fallbackRequest, "/agent/default/message");
    expect(fallbackResponse.status).toBe(201);
    expect(await fallbackResponse.json()).toEqual({
      pathname: "/agent/default/message",
      chat_jid: "web:default",
      agent_id: "default",
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      req: explicitRequest,
      pathname: "/agent/custom/message",
      chatJid: "web:branch",
      agentId: "default",
    });
    expect(calls[1]).toEqual({
      req: fallbackRequest,
      pathname: "/agent/default/message",
      chatJid: "web:default",
      agentId: "default",
    });
  });

  test("forwards durable acceptance and opaque provenance through the trusted entry seam", async () => {
    const accepted: unknown[] = [];
    let forwardedContext: object | undefined;
    const service = new WebAgentMessageEntryService({
      defaultChatJid: "web:default",
      defaultAgentId: "default",
      forwardAgentMessageRequest: async (_req, _pathname, _chatJid, _agentId, onAccepted, context) => {
        forwardedContext = context;
        onAccepted?.({
          chat_jid: "web:branch",
          row_id: 42,
          thread_id: 42,
          accepted_at: "2026-08-08T22:00:00.000Z",
          created: true,
        });
        return Response.json({ created: true }, { status: 201 });
      },
    });

    const context = createTrustedAgentMessageRequestContext({ source: "runtime.test" });
    await service.handleAgentMessage(
      new Request("https://example.com/agent/default/message?chat_jid=web%3Abranch", { method: "POST" }),
      "/agent/default/message",
      (acceptance) => accepted.push(acceptance),
      context,
    );

    expect(forwardedContext).toBe(context);
    expect(accepted).toEqual([{
      chat_jid: "web:branch",
      row_id: 42,
      thread_id: 42,
      accepted_at: "2026-08-08T22:00:00.000Z",
      created: true,
    }]);
  });

  test("returns the forwarded response unchanged", async () => {
    const forwardedResponse = new Response("accepted", { status: 202 });
    const service = new WebAgentMessageEntryService({
      defaultChatJid: "web:default",
      defaultAgentId: "default",
      forwardAgentMessageRequest: async () => forwardedResponse,
    });

    const response = await service.handleAgentMessage(
      new Request("https://example.com/agent/default/message", { method: "POST" }),
      "/agent/default/message",
    );

    expect(response).toBe(forwardedResponse);
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("accepted");
  });
});
