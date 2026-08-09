import { afterEach, describe, expect, test } from "bun:test";

import { createWebChannelTestFixture } from "./helpers/web-channel-fixture.ts";

let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
});

type AgentMessageEntryServiceStub = {
  handleAgentMessage(req: Request, pathname: string, onAccepted?: (acceptance: any) => void): Promise<Response>;
};

describe("WebChannel agent-message entry delegation", () => {
  test("delegates the public agent-message wrapper to the extracted entry service", async () => {
    const fixture = await createWebChannelTestFixture({ workspace: "temp" });
    cleanup = fixture.cleanup;

    const calls: string[] = [];
    const accepted: unknown[] = [];
    const service: AgentMessageEntryServiceStub = {
      handleAgentMessage: async (req, pathname, onAccepted) => {
        const url = new URL(req.url);
        calls.push(`agent-message:${req.method}:${pathname}:${url.searchParams.get("chat_jid") ?? ""}`);
        onAccepted?.({ chat_jid: "web:branch", row_id: 9, thread_id: 9, accepted_at: "now", created: true });
        return new Response(JSON.stringify({ pathname, chat_jid: url.searchParams.get("chat_jid") }), {
          status: 211,
          headers: { "Content-Type": "application/json" },
        });
      },
    };

    (fixture.channel as unknown as { agentMessageEntryService: AgentMessageEntryServiceStub }).agentMessageEntryService = service;

    const response = await fixture.channel.handleAgentMessage(
      new Request("https://example.com/agent/default/message?chat_jid=web%3Abranch", { method: "POST" }),
      "/agent/default/message",
      (acceptance) => accepted.push(acceptance),
    );

    expect(response.status).toBe(211);
    expect(await response.json()).toEqual({ pathname: "/agent/default/message", chat_jid: "web:branch" });
    expect(calls).toEqual(["agent-message:POST:/agent/default/message:web:branch"]);
    expect(accepted).toEqual([{ chat_jid: "web:branch", row_id: 9, thread_id: 9, accepted_at: "now", created: true }]);
  });
});
