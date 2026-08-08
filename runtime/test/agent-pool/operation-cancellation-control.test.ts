import { afterEach, expect, test } from "bun:test";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";

import { createTempWorkspace, importFresh, setEnv, waitFor } from "../helpers.js";
import { createAgentPoolModelOptions } from "../model-services-fixture.js";

let restoreEnv: (() => void) | null = null;

afterEach(() => {
  restoreEnv?.();
  restoreEnv = null;
});

function createRuntime(session: any): AgentSessionRuntime {
  return {
    session,
    cwd: "/workspace",
    diagnostics: [],
    services: {} as any,
    modelFallbackMessage: undefined,
    newSession: async () => ({ cancelled: false }),
    switchSession: async () => ({ cancelled: false }),
    fork: async () => ({ cancelled: false }),
    importFromJsonl: async () => ({ cancelled: false }),
    dispose: async () => { session.dispose?.(); },
  } as any;
}

test("remote cancellation persists before aborting only the exact gateway occupant", async () => {
  const ws = createTempWorkspace("piclaw-operation-cancel-control-");
  restoreEnv = setEnv({ PICLAW_WORKSPACE: ws.workspace, PICLAW_STORE: ws.store, PICLAW_DATA: ws.data });

  const db = await importFresh<typeof import("../../src/db.js")>("../src/db.js");
  db.initDatabase();
  const chatJid = "web:operation-cancel-control";
  db.registerAcceptedChatSource({
    chatJid,
    sourceClass: "prompt",
    sourceKind: "queued_followup",
    sourceId: "followup-1",
    acceptedAt: "2026-08-08T08:40:00.000Z",
    payloadRef: "followup:followup-1",
  });
  const operation = db.claimNextChatOperation(chatJid).operation;
  if (!operation) throw new Error("expected operation");
  const owner = {
    operationId: operation.operationId,
    sourceSeq: operation.sourceSeq,
    phase: operation.phase,
    generation: operation.generation,
  };

  let promptStarted = false;
  let releasePrompt!: () => void;
  const promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });
  let cancellationSeenByAbort: unknown = null;
  let abortCalls = 0;
  class BlockingSession {
    subscribe() { return () => {}; }
    async prompt() {
      promptStarted = true;
      await promptGate;
    }
    async abort() {
      abortCalls += 1;
      cancellationSeenByAbort = db.getChatOperation(chatJid)?.cancellation ?? null;
      releasePrompt();
    }
    dispose() {}
  }

  const { AgentPool } = await importFresh<typeof import("../../src/agent-pool.js")>("../src/agent-pool.js");
  const pool = new AgentPool({
    ...createAgentPoolModelOptions(),
    createSession: async () => createRuntime(new BlockingSession()) as any,
  });
  const run = pool.runAgent("continue", chatJid, { timeoutMs: 0, operationOwner: owner });
  await waitFor(() => promptStarted, 1_000);

  const stale = await pool.cancelOperationAndAbort(chatJid, `${operation.operationId}:stale`);
  expect(stale).toMatchObject({ status: "no_op", reason: "operation_mismatch", physicallyAborted: false });
  expect(abortCalls).toBe(0);
  expect(db.getChatOperation(chatJid)?.cancellation).toBeNull();

  const cancelled = await pool.cancelOperationAndAbort(chatJid, operation.operationId);
  expect(cancelled.status).toBe("cancelled");
  expect(cancelled.physicallyAborted).toBe(true);
  expect(abortCalls).toBe(1);
  expect(cancellationSeenByAbort).toMatchObject({ cause: "remote_abort" });
  expect(db.getChatOperation(chatJid)?.cancellation).toEqual(cancellationSeenByAbort);

  await run;
  await pool.shutdown();
  ws.cleanup();
});

test("remote cancellation persists when the exact operation has no gateway occupant", async () => {
  const ws = createTempWorkspace("piclaw-operation-cancel-idle-");
  restoreEnv = setEnv({ PICLAW_WORKSPACE: ws.workspace, PICLAW_STORE: ws.store, PICLAW_DATA: ws.data });

  const db = await importFresh<typeof import("../../src/db.js")>("../src/db.js");
  db.initDatabase();
  const chatJid = "web:operation-cancel-idle";
  db.registerAcceptedChatSource({
    chatJid,
    sourceClass: "prompt",
    sourceKind: "queued_followup",
    sourceId: "followup-idle",
    acceptedAt: "2026-08-08T08:41:00.000Z",
    payloadRef: "followup:followup-idle",
  });
  const operation = db.claimNextChatOperation(chatJid).operation;
  if (!operation) throw new Error("expected operation");

  let abortCalls = 0;
  class IdleSession {
    subscribe() { return () => {}; }
    async prompt() {}
    async abort() { abortCalls += 1; }
    dispose() {}
  }
  const { AgentPool } = await importFresh<typeof import("../../src/agent-pool.js")>("../src/agent-pool.js");
  const pool = new AgentPool({
    ...createAgentPoolModelOptions(),
    createSession: async () => createRuntime(new IdleSession()) as any,
  });

  const result = await pool.cancelOperationAndAbort(chatJid, operation.operationId);
  expect(result).toMatchObject({ status: "cancelled", physicallyAborted: false });
  expect(abortCalls).toBe(0);
  expect(db.getChatOperation(chatJid)?.cancellation).toMatchObject({ cause: "remote_abort" });

  await pool.shutdown();
  ws.cleanup();
});
