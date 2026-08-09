import { afterEach, expect, test } from "bun:test";

import { withChatContext } from "../../src/core/chat-context.js";
import { sessionControl, setSessionControlHandler } from "../../src/extensions/session-control.js";

function makePi() {
  const tools = new Map<string, any>();
  const beforeAgentStartHandlers: any[] = [];
  const api = {
    on(eventName: string, handler: any) {
      if (eventName === "before_agent_start") beforeAgentStartHandlers.push(handler);
    },
    registerTool(tool: any) { tools.set(tool.name, tool); },
  };
  sessionControl(api as any);
  return { tools, beforeAgentStartHandlers };
}

afterEach(() => {
  setSessionControlHandler(undefined);
});

test("session_control registers a separate tool from chat with startup guidance", async () => {
  const { tools, beforeAgentStartHandlers } = makePi();
  expect(tools.has("session_control")).toBe(true);
  expect(tools.has("chat")).toBe(false);

  const event = await beforeAgentStartHandlers[0]({ systemPrompt: "base" });
  expect(event.systemPrompt).toContain("Cross-session session control");
  expect(event.systemPrompt).toContain("separate from the chat tool");
  expect(event.systemPrompt).toContain("Prefer target_agent_name with an @alias");
});

test("session_control requires exactly one target selector", async () => {
  const { tools } = makePi();
  const tool = tools.get("session_control");
  const noTarget = await withChatContext("web:source", "web", () => tool.execute("call-1", { action: "inspect" }));
  expect(noTarget.details.ok).toBe(false);
  expect(noTarget.details.error).toContain("Provide target_agent_name");

  const bothTargets = await withChatContext("web:source", "web", () => tool.execute("call-2", {
    action: "inspect",
    target_chat_jid: "web:target",
    target_agent_name: "other",
  }));
  expect(bothTargets.details.ok).toBe(false);
  expect(bothTargets.details.error).toContain("only one target");
});

test("session_control requires an expected operation for abort and unblock", async () => {
  let calls = 0;
  setSessionControlHandler(async (request) => {
    calls += 1;
    return {
      ok: true,
      action: request.action,
      source_chat_jid: request.source_chat_jid,
      target_chat_jid: request.target_chat_jid || "web:resolved",
    };
  });

  const tool = makePi().tools.get("session_control");
  for (const action of ["abort", "unblock"]) {
    const result = await withChatContext("web:source", "web", () => tool.execute(`call-${action}`, {
      action,
      target_agent_name: "research",
    }));
    expect(result.details.ok).toBe(false);
    expect(result.details.error).toContain("expected_operation_id");
    expect(result.details.error).toContain("copy the visible operation_id");
    expect(result.content[0].text).toContain("inspect or assess_stuck");
  }
  expect(calls).toBe(0);
});

test("inspect and assess_stuck expose the active operation token in visible results", async () => {
  setSessionControlHandler(async (request) => ({
    ok: true,
    action: request.action,
    source_chat_jid: request.source_chat_jid,
    target_chat_jid: "web:resolved",
    target_agent_name: "research",
    operation_id: "operation-42",
    before: { operation: { operation_id: "operation-42" } },
    ...(request.action === "assess_stuck" ? { assessment: "streaming" } : {}),
  }));

  const tool = makePi().tools.get("session_control");
  for (const action of ["inspect", "assess_stuck"]) {
    const result = await withChatContext("web:source", "web", () => tool.execute(`call-${action}`, {
      action,
      target_agent_name: "research",
    }));
    expect(result.details.operation_id).toBe("operation-42");
    expect(result.content[0].text).toContain("operation_id: operation-42");
    expect(result.content[0].text).toContain("expected_operation_id");
  }
});

test("inspect operation tokens hand off safely to abort and unblock", async () => {
  const calls: any[] = [];
  setSessionControlHandler(async (request) => {
    calls.push(request);
    return {
      ok: true,
      action: request.action,
      source_chat_jid: request.source_chat_jid,
      target_chat_jid: "web:resolved",
      target_agent_name: "research",
      ...(request.action === "inspect"
        ? { operation_id: "operation-42", before: { operation: { operation_id: "operation-42" } } }
        : { message: `${request.action} ok` }),
    };
  });

  const tool = makePi().tools.get("session_control");
  const inspected = await withChatContext("web:source", "web", () => tool.execute("call-inspect", {
    action: "inspect",
    target_agent_name: "research",
  }));
  const operationId = inspected.details.operation_id;

  for (const action of ["abort", "unblock"]) {
    const result = await withChatContext("web:source", "web", () => tool.execute(`call-${action}`, {
      action,
      target_agent_name: "research",
      expected_operation_id: operationId,
    }));
    expect(result.details.ok).toBe(true);
  }
  expect(calls.slice(1)).toEqual([
    expect.objectContaining({ action: "abort", expected_operation_id: "operation-42" }),
    expect.objectContaining({ action: "unblock", expected_operation_id: "operation-42" }),
  ]);
});

test("session_control dispatches inspect, switch_model, and unblock requests to the runtime handler", async () => {
  const calls: any[] = [];
  setSessionControlHandler(async (request) => {
    calls.push(request);
    return {
      ok: true,
      action: request.action,
      source_chat_jid: request.source_chat_jid,
      target_chat_jid: request.target_chat_jid || "web:resolved",
      target_agent_name: request.target_agent_name || null,
      before: { active: false },
      message: `${request.action} ok`,
    };
  });

  const { tools } = makePi();
  const tool = tools.get("session_control");
  const inspect = await withChatContext("web:source", "web", () => tool.execute("call-3", {
    action: "inspect",
    target_agent_name: "research",
  }));
  expect(inspect.details.ok).toBe(true);
  expect(inspect.details.source_chat_jid).toBe("web:source");
  expect(calls[0]).toMatchObject({ action: "inspect", source_chat_jid: "web:source", target_agent_name: "research" });

  const switched = await withChatContext("web:source", "web", () => tool.execute("call-4", {
    action: "switch_model",
    target_chat_jid: "web:target",
    model: "github-copilot/gpt-5.4",
  }));
  expect(switched.details.ok).toBe(true);
  expect(calls[1]).toMatchObject({ action: "switch_model", target_chat_jid: "web:target", model: "github-copilot/gpt-5.4" });

  const unblocked = await withChatContext("web:source", "web", () => tool.execute("call-5", {
    action: "unblock",
    target_chat_jid: "web:target",
    expected_operation_id: "operation-1",
  }));
  expect(unblocked.details.ok).toBe(true);
  expect(calls[2]).toMatchObject({
    action: "unblock",
    target_chat_jid: "web:target",
    expected_operation_id: "operation-1",
  });
});

test("session_control dispatches every supported action name to the runtime handler", async () => {
  const calls: any[] = [];
  setSessionControlHandler(async (request) => {
    calls.push(request);
    return {
      ok: true,
      action: request.action,
      source_chat_jid: request.source_chat_jid,
      target_chat_jid: request.target_chat_jid || "web:resolved",
      target_agent_name: request.target_agent_name || null,
      message: `${request.action} ok`,
    };
  });

  const { tools } = makePi();
  const tool = tools.get("session_control");
  const actions = ["inspect", "assess_stuck", "compact", "abort", "retry_failed", "skip_failed", "wake", "unblock"];
  for (const action of actions) {
    const result = await withChatContext("web:source", "web", () => tool.execute(`call-${action}`, {
      action,
      target_chat_jid: "web:target",
      ...((action === "abort" || action === "unblock") ? { expected_operation_id: "operation-1" } : {}),
    }));
    expect(result.details.ok).toBe(true);
  }
  const modelResult = await withChatContext("web:source", "web", () => tool.execute("call-switch_model", {
    action: "switch_model",
    target_chat_jid: "web:target",
    model: "github-copilot/gpt-5.4",
  }));
  expect(modelResult.details.ok).toBe(true);
  expect(calls.map((call) => call.action)).toEqual([...actions, "switch_model"]);
});
