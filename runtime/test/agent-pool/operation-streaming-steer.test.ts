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

function ownerOf(operation: any) {
  return {
    operationId: operation.operationId,
    sourceSeq: operation.sourceSeq,
    phase: operation.phase,
    generation: operation.generation,
  };
}

async function setup(name: string, chatJid = `web:${name}`) {
  const ws = createTempWorkspace(name);
  restoreEnv = setEnv({ PICLAW_WORKSPACE: ws.workspace, PICLAW_STORE: ws.store, PICLAW_DATA: ws.data });
  const db = await importFresh<typeof import("../../src/db.js")>("../src/db.js");
  db.initDatabase();
  db.registerAcceptedChatSource({
    chatJid,
    sourceClass: "prompt",
    sourceKind: "queued_followup",
    sourceId: "root",
    acceptedAt: "2026-08-08T20:00:00.000Z",
    payloadRef: "followup:root",
  });
  const operation = db.claimNextChatOperation(chatJid).operation;
  if (!operation) throw new Error("expected durable operation");
  return { ws, db, chatJid, operation };
}

test("real concurrent durable prompt admits exact-owner streaming steers in source_seq FIFO order", async () => {
  const { ws, db, chatJid, operation } = await setup("operation-steer-fifo");
  let promptStarted = false;
  let releasePrompt!: () => void;
  const promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });
  const queued: string[] = [];

  class BlockingSession {
    isStreaming = false;
    private listeners: Array<(event: any) => void> = [];
    subscribe(listener: (event: any) => void) { this.listeners.push(listener); return () => {}; }
    async steer(text: string) {
      if (text === "first steer") await Bun.sleep(20);
      queued.push(text);
    }
    async prompt(_text: string) {
      this.isStreaming = true;
      promptStarted = true;
      await promptGate;
      this.isStreaming = false;
      for (const listener of this.listeners) listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done" } });
    }
    async abort() { releasePrompt(); }
    bindExtensions() {}
    dispose() {}
  }

  const { AgentPool } = await importFresh<typeof import("../../src/agent-pool.js")>("../src/agent-pool.js");
  const pool = new AgentPool({
    ...createAgentPoolModelOptions(),
    createSession: async () => createRuntime(new BlockingSession()) as any,
  });
  const owner = ownerOf(operation);
  const run = pool.runAgent("root", chatJid, { timeoutMs: 0, operationOwner: owner });
  await waitFor(() => promptStarted, 1_000);

  const results = await Promise.all(["first steer", "second steer"].map((text, index) => (
    pool.queueStreamingMessage(chatJid, text, "steer", {
      operationOwner: owner,
      beforeQueue: () => {
        const registered = db.registerChatOperationIntent(chatJid, owner, {
          sourceKind: "steer",
          sourceId: `steer-${index + 1}`,
          acceptedAt: `2026-08-08T20:00:0${index + 1}.000Z`,
          payloadRef: `message:steer-${index + 1}`,
        });
        if (registered.status === "rejected") throw new Error(registered.reason);
        return { sourceSeq: registered.source.sourceSeq };
      },
    })
  )));
  expect(results).toEqual([
    expect.objectContaining({ queued: true, operationIntentSourceSeq: expect.any(Number) }),
    expect.objectContaining({ queued: true, operationIntentSourceSeq: expect.any(Number) }),
  ]);

  expect(queued).toEqual(["first steer", "second steer"]);
  expect(db.getChatOperationIntentSources(operation.operationId).map((source: any) => source.sourceId))
    .toEqual(["steer-1", "steer-2"]);
  const bypass = await pool.queueStreamingMessage(chatJid, "unregistered steer", "steer", { operationOwner: owner });
  expect(bypass).toMatchObject({ queued: false, error: expect.stringContaining("operation_intent_required") });
  let followUpRegistered = false;
  const followUp = await pool.queueStreamingMessage(chatJid, "not an OOB steer", "followUp", {
    operationOwner: owner,
    beforeQueue: () => { followUpRegistered = true; return { sourceSeq: 999 }; },
  });
  expect(followUp).toMatchObject({ queued: false, error: expect.stringContaining("operation_queue_behavior_mismatch") });
  expect(followUpRegistered).toBe(false);
  expect(queued).toEqual(["first steer", "second steer"]);

  releasePrompt();
  await run;
  await pool.shutdown();
  ws.cleanup();
});

test("owner drift after intent registration rejects SDK queueing and truthfully disposes the intent", async () => {
  const { ws, db, chatJid, operation } = await setup("operation-steer-drift");
  let promptStarted = false;
  let releasePrompt!: () => void;
  const promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });
  let queuedEffects = 0;

  class BlockingSession {
    isStreaming = false;
    private listeners: Array<(event: any) => void> = [];
    subscribe(listener: (event: any) => void) { this.listeners.push(listener); return () => {}; }
    async steer(_text: string) { queuedEffects += 1; }
    async prompt(_text: string) {
      this.isStreaming = true;
      promptStarted = true;
      await promptGate;
      this.isStreaming = false;
      for (const listener of this.listeners) listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done" } });
    }
    async abort() { releasePrompt(); }
    bindExtensions() {}
    dispose() {}
  }

  const { AgentPool } = await importFresh<typeof import("../../src/agent-pool.js")>("../src/agent-pool.js");
  const pool = new AgentPool({
    ...createAgentPoolModelOptions(),
    createSession: async () => createRuntime(new BlockingSession()) as any,
  });
  const originalOwner = ownerOf(operation);
  const run = pool.runAgent("root", chatJid, { timeoutMs: 0, operationOwner: originalOwner });
  await waitFor(() => promptStarted, 1_000);
  let intentSourceSeq = 0;

  const result = await pool.queueStreamingMessage(chatJid, "drift steer", "steer", {
    operationOwner: originalOwner,
    beforeQueue: () => {
      const registered = db.registerChatOperationIntent(chatJid, originalOwner, {
        sourceKind: "steer", sourceId: "drift-steer", acceptedAt: "2026-08-08T20:00:01.000Z", payloadRef: "message:drift-steer",
      });
      if (registered.status === "rejected") throw new Error(registered.reason);
      intentSourceSeq = registered.source.sourceSeq;
      expect(db.blockChatOperation(chatJid, originalOwner).status).toBe("applied");
      return { sourceSeq: intentSourceSeq };
    },
    onQueueFailure: () => {
      const observed = db.getChatOperation(chatJid);
      if (!observed) throw new Error("missing operation");
      expect(db.disposeChatOperationIntent(chatJid, ownerOf(observed), {
        sourceSeq: intentSourceSeq, outcome: "failed", cause: "steer_queue_failed",
        provenance: "test_owner_drift", createdAt: "2026-08-08T20:00:02.000Z",
      }).status).toBe("disposed");
    },
  });

  expect(result).toMatchObject({ queued: false, operationIntentSourceSeq: intentSourceSeq, error: expect.stringContaining("phase_mismatch") });
  expect(queuedEffects).toBe(0);
  expect(db.getChatOperationDisposition(intentSourceSeq)).toMatchObject({ outcome: "failed", cause: "steer_queue_failed" });

  releasePrompt();
  await run;
  await pool.shutdown();
  ws.cleanup();
});

test("cancellation after intent registration prevents the SDK effect and leaves terminal cancellation accounting", async () => {
  const { ws, db, chatJid, operation } = await setup("operation-steer-post-registration-cancel");
  let promptStarted = false;
  let releasePrompt!: () => void;
  const promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });
  let queuedEffects = 0;

  class BlockingSession {
    isStreaming = false;
    private listeners: Array<(event: any) => void> = [];
    subscribe(listener: (event: any) => void) { this.listeners.push(listener); return () => {}; }
    async steer(_text: string) { queuedEffects += 1; }
    async prompt(_text: string) {
      this.isStreaming = true;
      promptStarted = true;
      await promptGate;
      this.isStreaming = false;
      for (const listener of this.listeners) listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done" } });
    }
    async abort() { releasePrompt(); }
    bindExtensions() {}
    dispose() {}
  }

  const { AgentPool } = await importFresh<typeof import("../../src/agent-pool.js")>("../src/agent-pool.js");
  const pool = new AgentPool({
    ...createAgentPoolModelOptions(),
    createSession: async () => createRuntime(new BlockingSession()) as any,
  });
  const originalOwner = ownerOf(operation);
  const run = pool.runAgent("root", chatJid, { timeoutMs: 0, operationOwner: originalOwner });
  await waitFor(() => promptStarted, 1_000);
  let intentSourceSeq = 0;
  let failureCallbacks = 0;

  const result = await pool.queueStreamingMessage(chatJid, "cancelled after registration", "steer", {
    operationOwner: originalOwner,
    beforeQueue: () => {
      const registered = db.registerChatOperationIntent(chatJid, originalOwner, {
        sourceKind: "steer",
        sourceId: "post-registration-cancel",
        acceptedAt: "2026-08-08T20:00:01.000Z",
        payloadRef: "message:post-registration-cancel",
      });
      if (registered.status === "rejected") throw new Error(registered.reason);
      intentSourceSeq = registered.source.sourceSeq;
      expect(db.cancelChatOperation(chatJid, originalOwner, {
        cause: "remote_abort",
        requestedAt: "2026-08-08T20:00:02.000Z",
      }).status).toBe("applied");
      return { sourceSeq: intentSourceSeq };
    },
    onQueueFailure: (_failure, registration) => {
      failureCallbacks += 1;
      const observed = db.getChatOperation(chatJid);
      if (!observed) throw new Error("missing cancelled operation");
      expect(db.disposeChatOperationIntent(chatJid, ownerOf(observed), {
        sourceSeq: registration.sourceSeq,
        outcome: "failed",
        cause: "steer_queue_failed",
        provenance: "test_post_registration_cancel",
        createdAt: "2026-08-08T20:00:03.000Z",
      })).toMatchObject({ status: "rejected", reason: "operation_cancelled" });
    },
  });

  expect(result).toMatchObject({
    queued: false,
    operationIntentSourceSeq: intentSourceSeq,
    error: expect.stringContaining("generation_mismatch"),
  });
  expect(failureCallbacks).toBe(1);
  expect(queuedEffects).toBe(0);
  expect(db.getChatOperationDisposition(intentSourceSeq)).toBeNull();

  releasePrompt();
  await run;
  const cancelled = db.getChatOperation(chatJid);
  if (!cancelled?.cancellation) throw new Error("expected cancelled operation");
  const completed = db.completeChatOperation(chatJid, {
    owner: ownerOf(cancelled),
    outcome: "cancelled",
    cause: cancelled.cancellation.cause,
    provenance: "test_post_registration_cancel",
    createdAt: "2026-08-08T20:00:04.000Z",
    intentDispositions: [{
      sourceSeq: intentSourceSeq,
      outcome: "cancelled",
      cause: cancelled.cancellation.cause,
      provenance: "test_post_registration_cancel",
    }],
  });
  expect(completed.status).toBe("completed");
  expect(db.getChatOperationDisposition(intentSourceSeq)).toMatchObject({
    outcome: "cancelled",
    cause: "remote_abort",
    provenance: "test_post_registration_cancel",
  });

  await pool.shutdown();
  ws.cleanup();
});

test("durable queue failure runs truthful accounting callback and never reports queued", async () => {
  const { ws, db, chatJid, operation } = await setup("operation-steer-failure");
  let promptStarted = false;
  let releasePrompt!: () => void;
  const promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });
  let failureCallbacks = 0;

  class FailingQueueSession {
    isStreaming = false;
    private listeners: Array<(event: any) => void> = [];
    subscribe(listener: (event: any) => void) { this.listeners.push(listener); return () => {}; }
    async steer(_text: string) { throw new Error("SDK queue failed"); }
    async prompt(_text: string) {
      this.isStreaming = true;
      promptStarted = true;
      await promptGate;
      this.isStreaming = false;
      for (const listener of this.listeners) listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done" } });
    }
    async abort() { releasePrompt(); }
    bindExtensions() {}
    dispose() {}
  }

  const { AgentPool } = await importFresh<typeof import("../../src/agent-pool.js")>("../src/agent-pool.js");
  const pool = new AgentPool({
    ...createAgentPoolModelOptions(),
    createSession: async () => createRuntime(new FailingQueueSession()) as any,
  });
  const owner = ownerOf(operation);
  const run = pool.runAgent("root", chatJid, { timeoutMs: 0, operationOwner: owner });
  await waitFor(() => promptStarted, 1_000);

  const result = await pool.queueStreamingMessage(chatJid, "failed steer", "steer", {
    operationOwner: owner,
    beforeQueue: () => {
      const registered = db.registerChatOperationIntent(chatJid, owner, {
        sourceKind: "steer",
        sourceId: "failed-steer",
        acceptedAt: "2026-08-08T20:00:01.000Z",
        payloadRef: "message:failed-steer",
      });
      if (registered.status === "rejected") throw new Error(registered.reason);
      return { sourceSeq: registered.source.sourceSeq };
    },
    onQueueFailure: () => { failureCallbacks += 1; },
  });

  expect(result).toMatchObject({ queued: false, error: "SDK queue failed", operationIntentSourceSeq: expect.any(Number) });
  expect(failureCallbacks).toBe(1);
  expect(db.getChatOperationIntentSources(operation.operationId).map((source: any) => source.sourceId))
    .toEqual(["failed-steer"]);

  await expect(pool.queueStreamingMessage(chatJid, "failed steer with broken accounting", "steer", {
    operationOwner: owner,
    beforeQueue: () => {
      const registered = db.registerChatOperationIntent(chatJid, owner, {
        sourceKind: "steer", sourceId: "failed-steer-accounting", acceptedAt: "2026-08-08T20:00:02.000Z",
        payloadRef: "message:failed-steer-accounting",
      });
      if (registered.status === "rejected") throw new Error(registered.reason);
      return { sourceSeq: registered.source.sourceSeq };
    },
    onQueueFailure: () => { throw new Error("accounting callback failed"); },
  })).rejects.toThrow("accounting callback failed");

  releasePrompt();
  await run;
  await pool.shutdown();
  ws.cleanup();
});

test("prompt completion waits for suspended queue failure accounting before durable release", async () => {
  const { ws, db, chatJid, operation } = await setup("operation-steer-suspended-failure");
  let promptStarted = false;
  let releasePrompt!: () => void;
  const promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });
  let queueStarted = false;
  let releaseQueue!: () => void;
  const queueGate = new Promise<void>((resolve) => { releaseQueue = resolve; });

  class SuspendedFailingQueueSession {
    isStreaming = false;
    private listeners: Array<(event: any) => void> = [];
    subscribe(listener: (event: any) => void) { this.listeners.push(listener); return () => {}; }
    async steer(_text: string) {
      queueStarted = true;
      await queueGate;
      throw new Error("suspended SDK queue failed");
    }
    async prompt(_text: string) {
      this.isStreaming = true;
      promptStarted = true;
      await promptGate;
      this.isStreaming = false;
      for (const listener of this.listeners) listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done" } });
    }
    async abort() { releasePrompt(); }
    bindExtensions() {}
    dispose() {}
  }

  const { AgentPool } = await importFresh<typeof import("../../src/agent-pool.js")>("../src/agent-pool.js");
  const pool = new AgentPool({
    ...createAgentPoolModelOptions(),
    createSession: async () => createRuntime(new SuspendedFailingQueueSession()) as any,
  });
  const owner = ownerOf(operation);
  let runResolved = false;
  const run = pool.runAgent("root", chatJid, { timeoutMs: 0, operationOwner: owner })
    .finally(() => { runResolved = true; });
  await waitFor(() => promptStarted, 1_000);

  let intentSourceSeq = 0;
  const queued = pool.queueStreamingMessage(chatJid, "suspended steer", "steer", {
    operationOwner: owner,
    beforeQueue: () => {
      const registered = db.registerChatOperationIntent(chatJid, owner, {
        sourceKind: "steer", sourceId: "suspended-steer", acceptedAt: "2026-08-08T20:00:01.000Z",
        payloadRef: "message:suspended-steer",
      });
      if (registered.status === "rejected") throw new Error(registered.reason);
      intentSourceSeq = registered.source.sourceSeq;
      return { sourceSeq: intentSourceSeq };
    },
    onQueueFailure: (_failure, registration) => {
      const observed = db.getChatOperation(chatJid);
      if (!observed) throw new Error("operation released before queue accounting");
      const disposed = db.disposeChatOperationIntent(chatJid, ownerOf(observed), {
        sourceSeq: registration.sourceSeq, outcome: "failed", cause: "steer_queue_failed",
        provenance: "test_suspended_queue_failure", createdAt: "2026-08-08T20:00:02.000Z",
      });
      if (disposed.status === "rejected") throw new Error(disposed.reason);
    },
  });
  await waitFor(() => queueStarted, 1_000);
  expect(pool.hasPendingStreamingQueue(chatJid)).toBe(true);
  releasePrompt();
  await Bun.sleep(25);
  expect(runResolved).toBe(false);
  expect(db.getChatOperation(chatJid)).not.toBeNull();

  releaseQueue();
  const queueResult = await queued;
  await Promise.resolve();
  expect(pool.hasPendingStreamingQueue(chatJid)).toBe(false);
  expect(queueResult).toMatchObject({ queued: false, error: "suspended SDK queue failed", operationIntentSourceSeq: intentSourceSeq });
  expect(db.getChatOperationDisposition(intentSourceSeq)).toMatchObject({ outcome: "failed", cause: "steer_queue_failed" });
  await run;
  expect(runResolved).toBe(true);
  const completed = db.completeChatOperation(chatJid, {
    owner, outcome: "succeeded", cause: "normal", provenance: "test_provider", createdAt: "2026-08-08T20:00:03.000Z",
    artifact: { message: {
      id: "suspended-bot", chat_jid: chatJid, sender: "bot", sender_name: "Pi", content: "done",
      timestamp: "2026-08-08T20:00:03.000Z", is_from_me: true, is_bot_message: true, is_terminal_agent_reply: true,
    } },
    intentDispositions: [],
  });
  expect(completed.status).toBe("completed");
  expect(db.getChatOperationDisposition(intentSourceSeq)).toMatchObject({
    outcome: "failed", cause: "steer_queue_failed", provenance: "test_suspended_queue_failure",
  });

  await pool.shutdown();
  ws.cleanup();
});

test("real concurrent durable prompt accepts a compose steer through WebChannel", async () => {
  const { ws, db, chatJid, operation } = await setup("operation-steer-web", "web:default");
  db.storeChatMetadata(chatJid, "2026-08-08T20:00:00.000Z", "Web");
  let promptStarted = false;
  let releasePrompt!: () => void;
  const promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });
  const queued: string[] = [];

  class BlockingSession {
    isStreaming = false;
    private listeners: Array<(event: any) => void> = [];
    subscribe(listener: (event: any) => void) { this.listeners.push(listener); return () => {}; }
    async steer(text: string) { queued.push(text); }
    async prompt(_text: string) {
      this.isStreaming = true;
      promptStarted = true;
      await promptGate;
      this.isStreaming = false;
      for (const listener of this.listeners) listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done" } });
    }
    async abort() { releasePrompt(); }
    bindExtensions() {}
    dispose() {}
  }

  const { AgentPool } = await importFresh<typeof import("../../src/agent-pool.js")>("../src/agent-pool.js");
  const pool = new AgentPool({
    ...createAgentPoolModelOptions(),
    createSession: async () => createRuntime(new BlockingSession()) as any,
  });
  const run = pool.runAgent("root", chatJid, { timeoutMs: 0, operationOwner: ownerOf(operation) });
  await waitFor(() => promptStarted, 1_000);

  const { WebChannel } = await importFresh<typeof import("../../src/channels/web.js")>("../src/channels/web.js");
  const web = new (WebChannel as any)({ queue: { enqueue: () => {} }, agentPool: pool });
  const response = await web.handleRequest(new Request("http://test/agent/default/message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "compose steer", mode: "steer" }),
  }));
  const payload = await response.json();

  expect(response.status).toBe(201);
  expect(payload.queued).toBe("steer");
  expect(queued).toEqual(["compose steer"]);
  const intents = db.getChatOperationIntentSources(operation.operationId);
  expect(intents).toHaveLength(1);
  expect(intents[0]).toMatchObject({ sourceKind: "steer", operationId: operation.operationId });
  expect(db.getDb().prepare("SELECT is_steering_message FROM messages WHERE chat_jid = ? AND id = ?")
    .get(chatJid, intents[0].sourceId)).toEqual({ is_steering_message: 1 });

  releasePrompt();
  await run;
  await pool.shutdown();
  ws.cleanup();
});

test("compose steer queue failure is durably failed and never degrades into an ordinary prompt", async () => {
  const { ws, db, chatJid, operation } = await setup("operation-steer-web-failure", "web:default");
  db.storeChatMetadata(chatJid, "2026-08-08T20:00:00.000Z", "Web");
  let promptStarted = false;
  let releasePrompt!: () => void;
  const promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });

  class FailingQueueSession {
    isStreaming = false;
    private listeners: Array<(event: any) => void> = [];
    subscribe(listener: (event: any) => void) { this.listeners.push(listener); return () => {}; }
    async steer(_text: string) { throw new Error("SDK queue failed"); }
    async prompt(_text: string) {
      this.isStreaming = true;
      promptStarted = true;
      await promptGate;
      this.isStreaming = false;
      for (const listener of this.listeners) listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done" } });
    }
    async abort() { releasePrompt(); }
    bindExtensions() {}
    dispose() {}
  }

  const { AgentPool } = await importFresh<typeof import("../../src/agent-pool.js")>("../src/agent-pool.js");
  const pool = new AgentPool({
    ...createAgentPoolModelOptions(),
    createSession: async () => createRuntime(new FailingQueueSession()) as any,
  });
  const run = pool.runAgent("root", chatJid, { timeoutMs: 0, operationOwner: ownerOf(operation) });
  await waitFor(() => promptStarted, 1_000);

  const { WebChannel } = await importFresh<typeof import("../../src/channels/web.js")>("../src/channels/web.js");
  const events: string[] = [];
  const web = new (WebChannel as any)({ queue: { enqueue: () => {} }, agentPool: pool });
  web.broadcastEvent = (type: string) => { events.push(type); };
  const response = await web.handleRequest(new Request("http://test/agent/default/message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "failed compose steer", mode: "steer" }),
  }));
  const payload = await response.json();

  expect(response.status).toBe(201);
  expect(payload).toMatchObject({ queued: "steer_failed", error: "SDK queue failed" });
  const intents = db.getChatOperationIntentSources(operation.operationId);
  expect(intents).toHaveLength(1);
  expect(db.getChatOperationDisposition(intents[0].sourceSeq)).toMatchObject({
    outcome: "failed",
    cause: "steer_queue_failed",
    provenance: "web_compose_steer_queue_failure",
  });
  expect(db.getDb().prepare("SELECT is_steering_message FROM messages WHERE chat_jid = ? AND id = ?")
    .get(chatJid, intents[0].sourceId)).toEqual({ is_steering_message: 1 });
  expect(events).toContain("agent_steer_failed");
  expect(db.getDb().prepare("SELECT COUNT(*) AS count FROM chat_accepted_sources WHERE selectable = 1").get())
    .toEqual({ count: 1 });

  releasePrompt();
  await run;
  await pool.shutdown();
  ws.cleanup();
});

test("cancellation racing compose steer rejects before intent registration or SDK queue effects", async () => {
  const { ws, db, chatJid, operation } = await setup("operation-steer-web-cancel", "web:default");
  db.storeChatMetadata(chatJid, "2026-08-08T20:00:00.000Z", "Web");
  let promptStarted = false;
  let releasePrompt!: () => void;
  const promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });
  let queuedEffects = 0;

  class BlockingSession {
    isStreaming = false;
    private listeners: Array<(event: any) => void> = [];
    subscribe(listener: (event: any) => void) { this.listeners.push(listener); return () => {}; }
    async steer(_text: string) { queuedEffects += 1; }
    async prompt(_text: string) {
      this.isStreaming = true;
      promptStarted = true;
      await promptGate;
      this.isStreaming = false;
      for (const listener of this.listeners) listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done" } });
    }
    async abort() { releasePrompt(); }
    bindExtensions() {}
    dispose() {}
  }

  const { AgentPool } = await importFresh<typeof import("../../src/agent-pool.js")>("../src/agent-pool.js");
  const pool = new AgentPool({
    ...createAgentPoolModelOptions(),
    createSession: async () => createRuntime(new BlockingSession()) as any,
  });
  const run = pool.runAgent("root", chatJid, { timeoutMs: 0, operationOwner: ownerOf(operation) });
  await waitFor(() => promptStarted, 1_000);
  expect(db.cancelChatOperation(chatJid, ownerOf(operation), {
    cause: "remote_abort",
    requestedAt: "2026-08-08T20:00:01.000Z",
  }).status).toBe("applied");

  const { WebChannel } = await importFresh<typeof import("../../src/channels/web.js")>("../src/channels/web.js");
  const web = new (WebChannel as any)({ queue: { enqueue: () => {} }, agentPool: pool });
  const response = await web.handleRequest(new Request("http://test/agent/default/message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "cancelled steer", mode: "steer" }),
  }));
  const payload = await response.json();

  expect(response.status).toBe(201);
  expect(payload.queued).toBe("steer_rejected");
  expect(queuedEffects).toBe(0);
  expect(db.getChatOperationIntentSources(operation.operationId)).toEqual([]);

  releasePrompt();
  await run;
  await pool.shutdown();
  ws.cleanup();
});
