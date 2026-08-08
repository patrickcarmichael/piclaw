import { beforeAll, expect, test } from "bun:test";

import {
  blockChatOperation,
  cancelChatOperation,
  claimNextChatOperation,
  completeChatOperation,
  ensureChatBranch,
  getChatOperation,
  initDatabase,
  registerAcceptedChatSource,
  renameChatBranchIdentity,
  retryBlockedChatOperation,
  storeChatMetadata,
} from "../../src/db.js";
import { createSessionControlHandler } from "../../src/runtime/startup.js";

process.env.PICLAW_DB_IN_MEMORY = "1";

let serial = 0;

function createOperation(agentName: string, sourceCount = 1) {
  serial += 1;
  const chatJid = `web:session-control:${serial}`;
  storeChatMetadata(chatJid, new Date().toISOString(), agentName);
  ensureChatBranch({ chat_jid: chatJid, agent_name: agentName });
  for (let index = 0; index < sourceCount; index += 1) {
    registerAcceptedChatSource({
      chatJid,
      sourceClass: "prompt",
      sourceKind: "queued_followup",
      sourceId: `${chatJid}:source:${index}`,
      acceptedAt: `2026-08-08T08:${String(index).padStart(2, "0")}:00.000Z`,
      payloadRef: `followup:${chatJid}:source:${index}`,
    });
  }
  const operation = claimNextChatOperation(chatJid).operation;
  if (!operation) throw new Error("expected claimed operation");
  return { chatJid, operation };
}

function owner(operation: NonNullable<ReturnType<typeof getChatOperation>>) {
  return {
    operationId: operation.operationId,
    sourceSeq: operation.sourceSeq,
    phase: operation.phase,
    generation: operation.generation,
  };
}

function createHarness(options: {
  chatJid: string;
  agentName: string;
  active?: boolean;
  onSnapshot?: () => void;
}) {
  const abortCalls: Array<{ chatJid: string; expectedOperationId: string }> = [];
  const resumes: string[] = [];
  let snapshotHook = options.onSnapshot;
  const agentPool = {
    async getAvailableModels() {
      const hook = snapshotHook;
      snapshotHook = undefined;
      hook?.();
      return { current: "test/model", thinking_level: "off", models: [] };
    },
    async getContextUsageForChat() { return null; },
    getSessionTreeForChat() { return null; },
    isActive() { return Boolean(options.active); },
    isStreaming() { return Boolean(options.active); },
    listKnownChats() { return [{ chat_jid: options.chatJid, agent_name: options.agentName }]; },
    findChatByAgentName(agentName: string) {
      return agentName === options.agentName
        ? { chat_jid: options.chatJid, agent_name: options.agentName }
        : null;
    },
    async cancelOperationAndAbort(chatJid: string, expectedOperationId: string) {
      abortCalls.push({ chatJid, expectedOperationId });
      const operation = getChatOperation(chatJid);
      return { status: "cancelled", operation, physicallyAborted: false };
    },
    resolveModelInput() { return { model: null, error: "unused" }; },
  };
  const web = {
    retryFailedOnModelSwitch(chatJid: string) {
      const operation = getChatOperation(chatJid);
      if (!operation || operation.phase !== "blocked") return false;
      return retryBlockedChatOperation(chatJid, owner(operation)).status === "applied";
    },
    skipFailedOnModelSwitch() { return false; },
    resumeChat(chatJid: string) { resumes.push(chatJid); },
  };
  return {
    handler: createSessionControlHandler(agentPool as any, web as any),
    abortCalls,
    resumes,
  };
}

beforeAll(() => {
  initDatabase();
});

test("inspect exposes the resolved durable operation owner and cancellation state", async () => {
  const { chatJid, operation } = createOperation(`inspect-${serial + 1}`);
  const harness = createHarness({ chatJid, agentName: `inspect-${serial}` });
  const result = await harness.handler({
    action: "inspect",
    source_chat_jid: "web:source",
    target_chat_jid: chatJid,
  });

  expect(result.ok).toBe(true);
  expect(result.before?.operation).toEqual({
    operation_id: operation.operationId,
    source_seq: operation.sourceSeq,
    phase: operation.phase,
    generation: operation.generation,
    cancellation: null,
  });
});

test("abort is an explicit no-op when the inspected operation is absent or stale", async () => {
  const { chatJid, operation } = createOperation(`stale-${serial + 1}`);
  const harness = createHarness({ chatJid, agentName: `stale-${serial}`, active: true });

  const result = await harness.handler({
    action: "abort",
    source_chat_jid: "web:source",
    target_chat_jid: chatJid,
    expected_operation_id: `${operation.operationId}:stale`,
  });

  expect(result).toMatchObject({
    ok: true,
    status: "no_op",
    no_op: true,
    reason: "operation_mismatch",
    expected_operation_id: `${operation.operationId}:stale`,
    observed_operation_id: operation.operationId,
  });
  expect(harness.abortCalls).toEqual([]);
});

test("abort is an explicit no-op when the resolved alias has no active operation", async () => {
  serial += 1;
  const chatJid = `web:session-control:${serial}`;
  const agentName = `absent-${serial}`;
  storeChatMetadata(chatJid, new Date().toISOString(), agentName);
  ensureChatBranch({ chat_jid: chatJid, agent_name: agentName });
  const harness = createHarness({ chatJid, agentName, active: true });

  const result = await harness.handler({
    action: "abort",
    source_chat_jid: "web:source",
    target_agent_name: agentName,
    expected_operation_id: "operation-observed-earlier",
  });

  expect(result).toMatchObject({
    status: "no_op",
    reason: "no_active_operation",
    observed_operation_id: null,
  });
  expect(harness.abortCalls).toEqual([]);
});

test("alias retargeting cannot mutate the previously resolved chat even when its operation is unchanged", async () => {
  const alias = `retarget-${serial + 1}`;
  const original = createOperation(alias);
  const replacement = createOperation(`replacement-${serial + 1}`);
  const harness = createHarness({
    chatJid: original.chatJid,
    agentName: alias,
    active: true,
    onSnapshot() {
      renameChatBranchIdentity({ chat_jid: original.chatJid, agent_name: `${alias}-old` });
      renameChatBranchIdentity({ chat_jid: replacement.chatJid, agent_name: alias });
    },
  });

  const result = await harness.handler({
    action: "abort",
    source_chat_jid: "web:source",
    target_agent_name: alias,
    expected_operation_id: original.operation.operationId,
  });

  expect(getChatOperation(original.chatJid)?.operationId).toBe(original.operation.operationId);
  expect(getChatOperation(replacement.chatJid)?.operationId).toBe(replacement.operation.operationId);
  expect(result).toMatchObject({
    status: "no_op",
    reason: "target_changed",
    target_chat_jid: original.chatJid,
    observed_target_chat_jid: replacement.chatJid,
    observed_operation_id: replacement.operation.operationId,
  });
  expect(harness.abortCalls).toEqual([]);
});

test("alias resolution cannot abort a successor that replaces the inspected operation during snapshotting", async () => {
  const agentName = `race-${serial + 1}`;
  const { chatJid, operation: first } = createOperation(agentName, 2);
  const harness = createHarness({
    chatJid,
    agentName,
    active: true,
    onSnapshot() {
      const cancelled = cancelChatOperation(chatJid, owner(first), {
        cause: "test_race",
        requestedAt: "2026-08-08T08:30:00.000Z",
      });
      if (cancelled.status !== "applied") throw new Error("expected cancellation");
      const completed = completeChatOperation(chatJid, {
        owner: owner(cancelled.operation),
        outcome: "cancelled",
        cause: "test_race",
        provenance: "test",
        createdAt: "2026-08-08T08:30:01.000Z",
      });
      if (completed.status !== "completed") throw new Error("expected completion");
      if (!claimNextChatOperation(chatJid).operation) throw new Error("expected successor");
    },
  });

  const result = await harness.handler({
    action: "abort",
    source_chat_jid: "web:source",
    target_agent_name: agentName,
    expected_operation_id: first.operationId,
  });
  const successor = getChatOperation(chatJid);

  expect(successor?.operationId).not.toBe(first.operationId);
  expect(result).toMatchObject({
    status: "no_op",
    reason: "operation_mismatch",
    expected_operation_id: first.operationId,
    observed_operation_id: successor?.operationId,
    target_chat_jid: chatJid,
    target_agent_name: agentName,
  });
  expect(harness.abortCalls).toEqual([]);
});

test("unblock retries only the exact blocked operation and resumes it", async () => {
  const agentName = `blocked-${serial + 1}`;
  const { chatJid, operation } = createOperation(agentName);
  const blocked = blockChatOperation(chatJid, owner(operation));
  if (blocked.status !== "applied") throw new Error("expected blocked operation");
  const harness = createHarness({ chatJid, agentName });

  const result = await harness.handler({
    action: "unblock",
    source_chat_jid: "web:source",
    target_agent_name: agentName,
    expected_operation_id: blocked.operation.operationId,
  });

  expect(result.ok).toBe(true);
  expect(result.retried_failed_run).toBe(true);
  expect(harness.resumes).toEqual([chatJid]);
  expect(getChatOperation(chatJid)?.phase).toBe("pending");
});
