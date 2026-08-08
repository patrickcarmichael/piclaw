/**
 * test/agent-pool/agent-pool.test.ts – Tests for agent pool initialisation and session management.
 *
 * Verifies createAgentPool(), session creation, AGENTS.md loading,
 * config persistence, and workspace directory setup.
 */

import { expect, test, afterEach } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { DEFAULT_COMPACTION_SETTINGS, SessionManager } from "@earendil-works/pi-coding-agent";
import { getAttachmentRegistry } from "../../src/agent-pool/attachments.js";
import { createTempWorkspace, getTestWorkspace, importFresh, setEnv } from "../helpers.js";
import { createAgentPoolModelOptions } from "../model-services-fixture.js";

let restoreEnv: (() => void) | null = null;

function findAgentLogFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return findAgentLogFiles(path);
    if (entry.isFile() && entry.name.startsWith("agent-") && entry.name.endsWith(".log")) return [path];
    return [];
  });
}

function createRuntime(session: any, overrides: Partial<AgentSessionRuntime> = {}): AgentSessionRuntime {
  return {
    session,
    cwd: "/workspace",
    diagnostics: [],
    services: {} as any,
    modelFallbackMessage: undefined,
    newSession: async (options?: any) => ({
      cancelled: typeof session.newSession === "function" ? !(await session.newSession(options)) : false,
    }),
    switchSession: async (path: string) => ({
      cancelled: typeof session.switchSession === "function" ? !(await session.switchSession(path)) : false,
    }),
    fork: async (entryId: string) => (
      typeof session.fork === "function"
        ? await session.fork(entryId)
        : { cancelled: false }
    ),
    importFromJsonl: async () => ({ cancelled: false }),
    dispose: async () => {
      session.dispose?.();
    },
    ...overrides,
  } as any;
}

function cleanupOperationTestChat(db: typeof import("../../src/db.js"), chatJid: string): void {
  db.deleteChatOperationLifecycleState(chatJid);
  db.getDb().prepare(`DELETE FROM message_media WHERE message_rowid IN
    (SELECT rowid FROM messages WHERE chat_jid = ?)` ).run(chatJid);
  db.getDb().prepare("DELETE FROM messages WHERE chat_jid = ?").run(chatJid);
  db.getDb().prepare("DELETE FROM chat_cursors WHERE chat_jid = ?").run(chatJid);
  db.getDb().prepare("DELETE FROM chats WHERE jid = ?").run(chatJid);
}

class PostTurnMaintenanceSession {
  private listeners: Array<(event: any) => void> = [];
  readonly calls: string[] = [];
  compactImpl: (() => Promise<void>) | null = null;
  sessionManager = {
    getLeafId: () => "post-turn-leaf",
    getEntries: () => [{ type: "message", message: { role: "user" } }],
    buildSessionContext: () => ({ messages: [{ role: "user", content: "x".repeat(200) }] }),
  };
  settingsManager = {
    getCompactionSettings: () => ({ ...DEFAULT_COMPACTION_SETTINGS, enabled: true, reserveTokens: 10 }),
  };
  model = { contextWindow: 20, provider: "test", id: "model" };
  isStreaming = false;
  isCompacting = false;
  isRetrying = false;
  subscribe(listener: (event: any) => void) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((entry) => entry !== listener);
    };
  }
  async prompt() {
    this.calls.push("prompt");
    for (const listener of this.listeners) {
      listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done" } });
    }
  }
  async compact() {
    this.calls.push("compact");
    await this.compactImpl?.();
  }
  async abort() {}
  dispose() {}
}

afterEach(async () => {
  restoreEnv?.();
  restoreEnv = null;
  try {
    const sshCore = await import("../../src/extensions/ssh-core.js");
    sshCore.setSshConnectionResolverForTests(null);
    await sshCore.unregisterLiveChatSshSession("web:default");
  } catch (_error) {
    void _error;
  }
});

test("agent pool aggregates streamed text and writes logs", async () => {
  const ws = getTestWorkspace();
  restoreEnv = setEnv({ PICLAW_WORKSPACE: ws.workspace, PICLAW_STORE: ws.store, PICLAW_DATA: ws.data });

  const { initDatabase } = await importFresh<typeof import("../src/db.js")>("../src/db.js");
  initDatabase();
  const { AgentPool } = await importFresh<typeof import("../src/agent-pool.js")>("../src/agent-pool.js");

  class StubSession {
    private listeners: Array<(event: any) => void> = [];
    subscribe(listener: (event: any) => void) {
      this.listeners.push(listener);
      return () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      };
    }
    async prompt(_prompt: string) {
      const deltas = ["Hello", " ", "world"];
      for (const delta of deltas) {
        for (const listener of this.listeners) {
          listener({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta },
          });
        }
      }
    }
    async abort() {}
    dispose() {}
  }

  const pool = new AgentPool({
    ...createAgentPoolModelOptions(),
    createSession: async () => createRuntime(new StubSession()) as any,
  });

  const result = await pool.runAgent("test", "web:default");
  expect(result.status).toBe("success");
  expect(result.result).toBe("Hello world");
  expect(process.env.PICLAW_CHAT_JID).toBeUndefined();

  const logsDir = (pool as any).logsDir || join(process.env.PICLAW_WORKSPACE || ws.workspace, "logs");
  const logFiles = findAgentLogFiles(logsDir);
  expect(logFiles.length).toBeGreaterThan(0);
  const matchingContent = logFiles
    .map((path) => readFileSync(path, "utf8"))
    .find((content) => content.includes("Hello world"));
  expect(matchingContent).toBeDefined();
});

test("real AgentPool awaits terminal output inside the prompt lane before ownerless maintenance", async () => {
  const ws = getTestWorkspace();
  restoreEnv = setEnv({
    PICLAW_WORKSPACE: ws.workspace,
    PICLAW_STORE: ws.store,
    PICLAW_DATA: ws.data,
    PICLAW_AUTO_COMPACTION_ENABLED: "1",
  });
  const db = await importFresh<typeof import("../src/db.js")>("../src/db.js");
  db.initDatabase();
  const { AgentPool } = await importFresh<typeof import("../src/agent-pool.js")>("../src/agent-pool.js");
  const session = new PostTurnMaintenanceSession();
  const pool = new AgentPool({
    ...createAgentPoolModelOptions(),
    createSession: async () => createRuntime(session) as any,
  });
  let releaseTerminalOutput!: () => void;
  const terminalOutputGate = new Promise<void>((resolve) => { releaseTerminalOutput = resolve; });
  let callbackStarted!: () => void;
  const callbackStart = new Promise<void>((resolve) => { callbackStarted = resolve; });

  const run = pool.runAgent("test", "web:terminal-order", {
    timeoutMs: 0,
    skipPrePromptCompaction: true,
    scheduleIdleAutoCompaction: true,
    onTerminalOutput: async () => {
      expect((pool as any).mutationGateway.currentAccess("web:terminal-order")).toEqual({ scope: "legacy" });
      session.calls.push("terminal-output-start");
      callbackStarted();
      await terminalOutputGate;
      session.calls.push("terminal-output-end");
      return true;
    },
  });

  await callbackStart;
  expect(session.calls).toEqual(["prompt", "terminal-output-start"]);
  let competingMutationRan = false;
  const competingMutation = pool.runSessionMutation("web:terminal-order", "queue", {}, async () => {
    competingMutationRan = true;
  });
  await Bun.sleep(10);
  expect(competingMutationRan).toBe(false);
  releaseTerminalOutput();

  expect((await run).status).toBe("success");
  await competingMutation;
  expect(competingMutationRan).toBe(true);
  expect(session.calls).toEqual(["prompt", "terminal-output-start", "terminal-output-end", "compact"]);
  expect((pool as any).mutationGateway.currentAccess("web:terminal-order")).toBeNull();
  await pool.shutdown();
  cleanupOperationTestChat(db, "web:terminal-order");
});

test("real AgentPool preserves callback-free fallback without accidental maintenance", async () => {
  const ws = getTestWorkspace();
  restoreEnv = setEnv({
    PICLAW_WORKSPACE: ws.workspace,
    PICLAW_STORE: ws.store,
    PICLAW_DATA: ws.data,
    PICLAW_AUTO_COMPACTION_ENABLED: "1",
  });
  const db = await importFresh<typeof import("../src/db.js")>("../src/db.js");
  db.initDatabase();
  const { AgentPool } = await importFresh<typeof import("../src/agent-pool.js")>("../src/agent-pool.js");
  const session = new PostTurnMaintenanceSession();
  const pool = new AgentPool({
    ...createAgentPoolModelOptions(),
    createSession: async () => createRuntime(session) as any,
  });

  const result = await pool.runAgent("test", "web:no-terminal-callback", {
    timeoutMs: 0,
    skipPrePromptCompaction: true,
    scheduleIdleAutoCompaction: true,
  });

  expect(result.status).toBe("success");
  expect(session.calls).toEqual(["prompt"]);
  await pool.shutdown();
  cleanupOperationTestChat(db, "web:no-terminal-callback");
});

test("real AgentPool suppresses maintenance when terminal output returns false or throws", async () => {
  const ws = getTestWorkspace();
  restoreEnv = setEnv({
    PICLAW_WORKSPACE: ws.workspace,
    PICLAW_STORE: ws.store,
    PICLAW_DATA: ws.data,
    PICLAW_AUTO_COMPACTION_ENABLED: "1",
  });
  const db = await importFresh<typeof import("../src/db.js")>("../src/db.js");
  db.initDatabase();
  const { AgentPool } = await importFresh<typeof import("../src/agent-pool.js")>("../src/agent-pool.js");
  const falseSession = new PostTurnMaintenanceSession();
  const falsePool = new AgentPool({
    ...createAgentPoolModelOptions(),
    createSession: async () => createRuntime(falseSession) as any,
  });
  const falseResult = await falsePool.runAgent("test", "web:false-terminal-callback", {
    timeoutMs: 0,
    skipPrePromptCompaction: true,
    scheduleIdleAutoCompaction: true,
    onTerminalOutput: () => false,
  });
  expect(falseResult.status).toBe("success");
  expect(falseSession.calls).toEqual(["prompt"]);
  await falsePool.shutdown();

  const throwSession = new PostTurnMaintenanceSession();
  const throwPool = new AgentPool({
    ...createAgentPoolModelOptions(),
    createSession: async () => createRuntime(throwSession) as any,
  });
  const failedRun = throwPool.runAgent("test", "web:throw-terminal-callback", {
    timeoutMs: 0,
    skipPrePromptCompaction: true,
    scheduleIdleAutoCompaction: true,
    onTerminalOutput: () => { throw new Error("terminal commit failed"); },
  });
  await expect(failedRun).rejects.toThrow("terminal commit failed");
  expect(throwSession.calls).toEqual(["prompt"]);
  await throwPool.shutdown();
  cleanupOperationTestChat(db, "web:false-terminal-callback");
  cleanupOperationTestChat(db, "web:throw-terminal-callback");
});

test("real AgentPool swallows successor legacy conflict only for post-turn maintenance", async () => {
  const ws = getTestWorkspace();
  restoreEnv = setEnv({
    PICLAW_WORKSPACE: ws.workspace,
    PICLAW_STORE: ws.store,
    PICLAW_DATA: ws.data,
    PICLAW_AUTO_COMPACTION_ENABLED: "1",
  });
  const db = await importFresh<typeof import("../src/db.js")>("../src/db.js");
  db.initDatabase();
  const { AgentPool } = await importFresh<typeof import("../src/agent-pool.js")>("../src/agent-pool.js");
  const session = new PostTurnMaintenanceSession();
  const pool = new AgentPool({
    ...createAgentPoolModelOptions(),
    createSession: async () => createRuntime(session) as any,
  });
  const chatJid = "web:maintenance-successor";

  const result = await pool.runAgent("test", chatJid, {
    timeoutMs: 0,
    skipPrePromptCompaction: true,
    scheduleIdleAutoCompaction: true,
    onTerminalOutput: () => {
      db.storeAcceptedChatMessageSource({
        id: `msg-${crypto.randomUUID()}`,
        chat_jid: chatJid,
        sender: "user",
        sender_name: "User",
        content: "successor",
        timestamp: new Date().toISOString(),
        is_from_me: false,
        is_bot_message: false,
      });
      expect(db.claimNextChatOperation(chatJid)).not.toBeNull();
      return true;
    },
  });

  expect(result.status).toBe("success");
  expect(session.calls).toEqual(["prompt"]);
  expect(db.getChatOperation(chatJid)).not.toBeNull();
  await expect(pool.runSessionMutation(chatJid, "compaction", {}, async () => {}))
    .rejects.toThrow("legacy_conflict");
  await pool.shutdown();
  cleanupOperationTestChat(db, chatJid);
});

test("maintenance failure after terminal commit preserves one durable terminal disposition", async () => {
  const ws = getTestWorkspace();
  restoreEnv = setEnv({
    PICLAW_WORKSPACE: ws.workspace,
    PICLAW_STORE: ws.store,
    PICLAW_DATA: ws.data,
    PICLAW_AUTO_COMPACTION_ENABLED: "1",
  });
  const db = await importFresh<typeof import("../src/db.js")>("../src/db.js");
  db.initDatabase();
  const { AgentPool } = await importFresh<typeof import("../src/agent-pool.js")>("../src/agent-pool.js");
  const chatJid = "web:maintenance-failure-after-commit";
  db.storeChatMetadata(chatJid, "", "Web");
  const source = db.storeAcceptedChatMessageSource({
    id: `msg-${crypto.randomUUID()}`,
    chat_jid: chatJid,
    sender: "user",
    sender_name: "User",
    content: "commit then maintenance fails",
    timestamp: "2026-08-08T10:00:00.000Z",
    is_from_me: false,
    is_bot_message: false,
  }).source;
  const claim = db.claimNextChatOperation(chatJid);
  if (claim.status !== "claimed") throw new Error("expected durable claim");
  const session = new PostTurnMaintenanceSession();
  const pool = new AgentPool({
    ...createAgentPoolModelOptions(),
    createSession: async () => createRuntime(session) as any,
  });
  const originalRunSessionMutation = pool.runSessionMutation.bind(pool);

  const result = await pool.runAgent("test", chatJid, {
    timeoutMs: 0,
    skipPrePromptCompaction: true,
    scheduleIdleAutoCompaction: true,
    operationOwner: claim.operation,
    onTerminalOutput: () => {
      const completed = db.completeChatOperation(chatJid, {
        owner: {
          operationId: claim.operation.operationId,
          sourceSeq: claim.operation.sourceSeq,
          phase: claim.operation.phase,
          generation: claim.operation.generation,
        },
        outcome: "succeeded",
        cause: "normal",
        provenance: "agent_pool_test",
        createdAt: "2026-08-08T10:00:01.000Z",
        artifact: {
          message: {
            id: `bot-${crypto.randomUUID()}`,
            chat_jid: chatJid,
            sender: "agent",
            sender_name: "Agent",
            content: "done",
            timestamp: "2026-08-08T10:00:01.000Z",
            is_from_me: true,
            is_bot_message: true,
            is_terminal_agent_reply: true,
          },
        },
      });
      expect(completed.status).toBe("completed");
      (pool as any).runSessionMutation = async () => { throw new Error("maintenance exploded"); };
      return true;
    },
  });
  (pool as any).runSessionMutation = originalRunSessionMutation;

  expect(result.status).toBe("success");
  expect(db.getChatOperation(chatJid)).toBeNull();
  expect(db.getChatOperationDisposition(source.sourceSeq)).toMatchObject({
    outcome: "succeeded",
    terminalMessageId: expect.any(String),
  });
  expect(db.getDb().prepare("SELECT COUNT(*) AS count FROM chat_operation_dispositions WHERE source_seq = ?")
    .get(source.sourceSeq)).toEqual({ count: 1 });
  await pool.shutdown();
  cleanupOperationTestChat(db, chatJid);
});

test("durable successor accepted during ownerless maintenance remains queued until release", async () => {
  const ws = getTestWorkspace();
  restoreEnv = setEnv({
    PICLAW_WORKSPACE: ws.workspace,
    PICLAW_STORE: ws.store,
    PICLAW_DATA: ws.data,
    PICLAW_AUTO_COMPACTION_ENABLED: "1",
  });
  const db = await importFresh<typeof import("../src/db.js")>("../src/db.js");
  db.initDatabase();
  const { AgentPool } = await importFresh<typeof import("../src/agent-pool.js")>("../src/agent-pool.js");
  const session = new PostTurnMaintenanceSession();
  const pool = new AgentPool({
    ...createAgentPoolModelOptions(),
    createSession: async () => createRuntime(session) as any,
  });
  let maintenanceStarted!: () => void;
  const maintenanceStart = new Promise<void>((resolve) => { maintenanceStarted = resolve; });
  let releaseMaintenance!: () => void;
  const maintenanceGate = new Promise<void>((resolve) => { releaseMaintenance = resolve; });
  session.compactImpl = async () => {
    maintenanceStarted();
    await maintenanceGate;
  };
  const chatJid = "web:maintenance-queued-successor";
  const run = pool.runAgent("test", chatJid, {
    timeoutMs: 0,
    skipPrePromptCompaction: true,
    scheduleIdleAutoCompaction: true,
    onTerminalOutput: () => true,
  });
  await maintenanceStart;

  db.storeAcceptedChatMessageSource({
    id: `msg-${crypto.randomUUID()}`,
    chat_jid: chatJid,
    sender: "user",
    sender_name: "User",
    content: "successor",
    timestamp: new Date().toISOString(),
    is_from_me: false,
    is_bot_message: false,
  });
  expect(db.claimNextChatOperation(chatJid).status).toBe("legacy_conflict");

  releaseMaintenance();
  expect((await run).status).toBe("success");
  const claim = db.claimNextChatOperation(chatJid);
  if (claim.status !== "claimed") throw new Error("expected successor claim after maintenance");
  let successorRan = false;
  await pool.runSessionMutation(chatJid, "prompt", { operationOwner: claim.operation }, async () => {
    successorRan = true;
  });
  expect(successorRan).toBe(true);
  expect(session.calls).toEqual(["prompt", "compact"]);
  await pool.shutdown();
  cleanupOperationTestChat(db, chatJid);
});

test("agent pool aggregates recovery counters into memory instrumentation", async () => {
  const ws = getTestWorkspace();
  restoreEnv = setEnv({
    PICLAW_WORKSPACE: ws.workspace,
    PICLAW_STORE: ws.store,
    PICLAW_DATA: ws.data,
    PICLAW_TURN_AUTO_RECOVERY_ENABLED: "1",
    PICLAW_TURN_TRANSIENT_RECOVERY_TOOLS_ENABLED: "1",
    PICLAW_TURN_AUTO_RECOVERY_MAX_ATTEMPTS: "2",
    PICLAW_TURN_AUTO_RECOVERY_TOTAL_BUDGET_MS: "30000",
  });

  const { initDatabase } = await importFresh<typeof import("../src/db.js")>("../src/db.js");
  initDatabase();
  const { AgentPool } = await importFresh<typeof import("../src/agent-pool.js")>("../src/agent-pool.js");

  class RecoveringSession {
    private listeners: Array<(event: any) => void> = [];
    promptCalls = 0;
    subscribe(listener: (event: any) => void) {
      this.listeners.push(listener);
      return () => {
        this.listeners = this.listeners.filter((entry) => entry !== listener);
      };
    }
    async prompt() {
      this.promptCalls += 1;
      if (this.promptCalls === 1) {
        for (const listener of this.listeners) {
          listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial" } });
          listener({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "Response ended with an error before finalization", content: [] } });
        }
        return;
      }
      for (const listener of this.listeners) {
        listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done" } });
      }
    }
    async abort() {}
    dispose() {}
  }

  const pool = new AgentPool({
    ...createAgentPoolModelOptions(),
    createSession: async () => createRuntime(new RecoveringSession()) as any,
  });

  const result = await pool.runAgent("test", "web:default", { timeoutMs: 0 });
  expect(result.status).toBe("success");
  const snapshot = pool.getMemoryInstrumentationSnapshot();
  expect(snapshot.recovery).toEqual({
    attemptsTotal: 1,
    recoveredRuns: 1,
    exhaustedRuns: 0,
  });

  await pool.shutdown();
});

test("agent pool aggregates content-free session resource counts", async () => {
  const ws = getTestWorkspace();
  restoreEnv = setEnv({ PICLAW_WORKSPACE: ws.workspace, PICLAW_STORE: ws.store, PICLAW_DATA: ws.data });

  const { AgentPool } = await importFresh<typeof import("../src/agent-pool.js")>("../src/agent-pool.js");
  const pool = new AgentPool({
    ...createAgentPoolModelOptions(),
    createSession: async () => { throw new Error("unused"); },
  });
  const sessionFile = join(ws.data, "instrumentation-session.jsonl");
  writeFileSync(sessionFile, "1234567890");
  const makeSession = (entries: number, messages: number, skills: number, extensions: number, tools: number) => ({
    sessionFile,
    sessionManager: { getEntries: () => Array.from({ length: entries }, () => ({})) },
    state: { messages: Array.from({ length: messages }, () => ({})) },
    resourceLoader: {
      getSkills: () => ({ skills: Array.from({ length: skills }, () => ({})) }),
      getExtensions: () => ({ extensions: Array.from({ length: extensions }, () => ({})) }),
    },
    extensionRunner: { getAllRegisteredTools: () => Array.from({ length: tools }, () => ({})) },
  });
  (pool as any).pool.set("web:memory-instrumentation-main", { runtime: createRuntime(makeSession(2, 3, 4, 5, 6)), lastUsed: Date.now() });
  (pool as any).sidePool.set("web:memory-instrumentation-side", { runtime: createRuntime(makeSession(7, 8, 9, 10, 11)), lastUsed: Date.now() });
  // This unit test targets only resident resource aggregation; avoid registering
  // synthetic chat IDs through the branch-manager activity query.
  (pool as any).branchManager.listActiveChats = () => [];

  expect(pool.getMemoryInstrumentationSnapshot().sessionResources).toEqual({
    sessionEntries: 9,
    activeMessages: 11,
    persistedSessionBytes: 20,
    loadedSkills: 13,
    loadedExtensions: 15,
    registeredTools: 17,
  });

  await pool.shutdown();
});

test("agent pool raises provider retry defaults for shared session settings", async () => {
  const ws = getTestWorkspace();
  restoreEnv = setEnv({ PICLAW_WORKSPACE: ws.workspace, PICLAW_STORE: ws.store, PICLAW_DATA: ws.data });

  const { AgentPool } = await importFresh<typeof import("../src/agent-pool.js")>("../src/agent-pool.js");
  const pool = new AgentPool({
    ...createAgentPoolModelOptions(),
    createSession: async () => createRuntime({ subscribe: () => () => {}, prompt: async () => {}, abort: async () => {} }) as any,
  });

  const retrySettings = (pool as any).settingsManager.getRetrySettings();
  expect(retrySettings.maxRetries).toBeGreaterThanOrEqual(5);
  expect(retrySettings.baseDelayMs).toBeGreaterThanOrEqual(5000);
});

test("agent pool honors timeout overrides", async () => {
  const ws = getTestWorkspace();
  restoreEnv = setEnv({ PICLAW_WORKSPACE: ws.workspace, PICLAW_STORE: ws.store, PICLAW_DATA: ws.data });

  const { initDatabase } = await importFresh<typeof import("../src/db.js")>("../src/db.js");
  initDatabase();
  const { AgentPool } = await importFresh<typeof import("../src/agent-pool.js")>("../src/agent-pool.js");

  let abortCalled = false;
  class StubSession {
    private listeners: Array<(event: any) => void> = [];
    promptCalls = 0;
    subscribe(listener: (event: any) => void) {
      this.listeners.push(listener);
      return () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      };
    }
    async prompt(_prompt: string) {
      this.promptCalls += 1;
      if (this.promptCalls === 1) {
        await Bun.sleep(250);
        return;
      }
      for (const listener of this.listeners) {
        listener({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "ok" },
        });
      }
    }
    async abort() {
      abortCalled = true;
    }
    dispose() {}
  }

  const pool = new AgentPool({
    ...createAgentPoolModelOptions(),
    createSession: async () => createRuntime(new StubSession()) as any,
  });

  const timedOut = await pool.runAgent("test", "web:default", { timeoutMs: 100 });
  expect(timedOut.status).toBe("error");
  expect(abortCalled).toBe(true);

  abortCalled = false;
  const ok = await pool.runAgent("test", "web:default", { timeoutMs: 0 });
  expect(ok.status).toBe("success");
  expect(abortCalled).toBe(false);
});

test("agent pool clears attachments when a run errors", async () => {
  const ws = getTestWorkspace();
  restoreEnv = setEnv({
    PICLAW_WORKSPACE: ws.workspace,
    PICLAW_STORE: ws.store,
    PICLAW_DATA: ws.data,
    PICLAW_TURN_AUTO_RECOVERY_ENABLED: "0",
  });

  const { AgentPool } = await importFresh<typeof import("../src/agent-pool.js")>("../src/agent-pool.js");
  const attachments = getAttachmentRegistry();
  attachments.clear("web:default");

  class StubSession {
    subscribe(_listener: (event: any) => void) {
      return () => {};
    }
    async prompt(_prompt: string) {
      attachments.register("web:default", {
        id: 1,
        name: "file.txt",
        contentType: "text/plain",
        size: 5,
        kind: "file",
        sourcePath: "/tmp/file.txt",
      });
      throw new Error("boom");
    }
    async abort() {}
    dispose() {}
  }

  const pool = new AgentPool({
    ...createAgentPoolModelOptions(),
    createSession: async () => createRuntime(new StubSession()) as any,
  });

  const result = await pool.runAgent("test", "web:default", { timeoutMs: 0 });
  expect(result.status).toBe("error");
  expect(result.attachments).toBeUndefined();
  expect(attachments.take("web:default").length).toBe(0);
});

test("agent pool stores SSH config for future sessions when no live SSH session exists", async () => {
  const ws = getTestWorkspace();
  restoreEnv = setEnv({ PICLAW_WORKSPACE: ws.workspace, PICLAW_STORE: ws.store, PICLAW_DATA: ws.data });

  const { initDatabase, getSshConfig } = await importFresh<typeof import("../src/db.js")>("../src/db.js");
  initDatabase();
  const { AgentPool } = await importFresh<typeof import("../src/agent-pool.js")>("../src/agent-pool.js");

  let pool: any;
  let createCalls = 0;
  let disposed = 0;

  class StubSession {
    private listeners: Array<(event: any) => void> = [];
    isStreaming = false;
    isBashRunning = false;
    isCompacting = false;
    subscribe(listener: (event: any) => void) {
      this.listeners.push(listener);
      return () => {};
    }
    async prompt(_prompt: string) {
      this.isStreaming = true;
      try {
        const result = await pool.setSshConfig("web:other", {
          ssh_target: "agent@example.com:/srv/project",
          ssh_port: 22,
          private_key_keychain: "ssh-prod",
          known_hosts_keychain: null,
          strict_host_key_checking: "yes",
        });
        expect(result.apply_timing).toBe("next_session");
        expect(getSshConfig("web:other")?.ssh_target).toBe("agent@example.com:/srv/project");
        for (const listener of this.listeners) {
          listener({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "ok" },
          });
        }
      } finally {
        this.isStreaming = false;
      }
    }
    async abort() {}
    dispose() {
      disposed += 1;
    }
  }

  pool = new AgentPool({
    ...createAgentPoolModelOptions(),
    createSession: async () => {
      createCalls += 1;
      return createRuntime(new StubSession()) as any;
    },
  });

  const result = await pool.runAgent("test", "web:default", { timeoutMs: 0 });
  expect(result.status).toBe("success");
  expect(disposed).toBe(0);
  expect((pool as any).pool.has("web:default")).toBe(true);

  await pool.runAgent("test", "web:default", { timeoutMs: 0 });
  expect(createCalls).toBe(1);

  await pool.shutdown();
});

test("agent pool evicts idle sessions and recreates them", async () => {
  const ws = getTestWorkspace();
  restoreEnv = setEnv({
    PICLAW_WORKSPACE: ws.workspace,
    PICLAW_STORE: ws.store,
    PICLAW_DATA: ws.data,
    PICLAW_TURN_AUTO_RECOVERY_ENABLED: "0",
  });

  const { AgentPool } = await importFresh<typeof import("../src/agent-pool.js")>("../src/agent-pool.js");

  let createCalls = 0;
  let disposed = 0;

  class StubSession {
    subscribe(_listener: (event: any) => void) {
      return () => {};
    }
    async prompt(_prompt: string) {}
    async abort() {}
    dispose() {
      disposed += 1;
    }
  }

  const pool = new AgentPool({
    ...createAgentPoolModelOptions(),
    createSession: async () => {
      createCalls += 1;
      return createRuntime(new StubSession()) as any;
    },
  });

  await pool.runAgent("test", "web:default", { timeoutMs: 0 });
  expect(createCalls).toBe(1);

  const entry = (pool as any).pool.get("web:default");
  entry.lastUsed = Date.now() - 16 * 60 * 1000;
  (pool as any).evictIdle();

  expect(disposed).toBe(1);
  expect((pool as any).pool.has("web:default")).toBe(false);

  await pool.runAgent("test", "web:default", { timeoutMs: 0 });
  expect(createCalls).toBe(2);

  await pool.shutdown();
});

test("agent pool schedules lightweight warmup for the most recent inactive chats", async () => {
  const ws = getTestWorkspace();
  restoreEnv = setEnv({ PICLAW_WORKSPACE: ws.workspace, PICLAW_STORE: ws.store, PICLAW_DATA: ws.data });

  const db = await importFresh<typeof import("../src/db.js")>("../src/db.js");
  db.initDatabase();
  db.storeChatMetadata("web:older", "2026-04-14T10:00:00.000Z", "Older");
  db.storeChatMetadata("web:newer", "2026-04-14T11:00:00.000Z", "Newer");
  db.storeChatMetadata("web:newest", "2026-04-14T12:00:00.000Z", "Newest");

  const { AgentPool } = await importFresh<typeof import("../src/agent-pool.js")>("../src/agent-pool.js");

  const created: string[] = [];
  class StubSession {
    subscribe(_listener: (event: any) => void) {
      return () => {};
    }
    async prompt(_prompt: string) {}
    async abort() {}
    dispose() {}
  }

  const pool = new AgentPool({
    ...createAgentPoolModelOptions(),
    createSession: async (chatJid: string) => {
      created.push(chatJid);
      return createRuntime(new StubSession()) as any;
    },
  });

  const scheduled = (pool as any).scheduleRecentChatWarmup({
    limit: 2,
    excludeChatJids: ["web:default", "web:newest"],
  });
  expect(scheduled).toEqual(["web:newer", "web:older"]);

  await Bun.sleep(20);
  expect(created).toEqual([]);
  expect(pool.getMemoryInstrumentationSnapshot().cachedMainSessions).toBe(0);

  await pool.shutdown();
});

test("agent pool recent-chat warmup skips internal maintenance chats", async () => {
  const ws = getTestWorkspace();
  restoreEnv = setEnv({ PICLAW_WORKSPACE: ws.workspace, PICLAW_STORE: ws.store, PICLAW_DATA: ws.data });

  const db = await importFresh<typeof import("../src/db.js")>("../src/db.js");
  db.initDatabase();
  db.storeChatMetadata("web:ipc-fts-123", "2099-04-14T14:00:00.000Z", "IPC");
  db.storeChatMetadata("dream:auto:web-default:123", "2099-04-14T13:00:00.000Z", "Dream");
  db.storeChatMetadata("control:/compact", "2099-04-14T12:00:00.000Z", "Control");
  db.storeChatMetadata("web:user", "2099-04-14T11:00:00.000Z", "User");

  const { AgentPool } = await importFresh<typeof import("../src/agent-pool.js")>("../src/agent-pool.js");
  const pool = new AgentPool({
    ...createAgentPoolModelOptions(),
    createSession: async () => createRuntime({ subscribe: () => () => {}, prompt: async () => {}, abort: async () => {}, dispose() {} }) as any,
  });

  const scheduled = (pool as any).scheduleRecentChatWarmup({ limit: 4, excludeChatJids: ["web:default"] });
  expect(scheduled).toContain("web:user");
  expect(scheduled).not.toContain("web:ipc-fts-123");
  expect(scheduled).not.toContain("dream:auto:web-default:123");
  expect(scheduled).not.toContain("control:/compact");

  await pool.shutdown();
});

test("agent pool keeps expanding recent-chat warmup past already-warm top rows", async () => {
  const ws = getTestWorkspace();
  restoreEnv = setEnv({ PICLAW_WORKSPACE: ws.workspace, PICLAW_STORE: ws.store, PICLAW_DATA: ws.data });

  const db = await importFresh<typeof import("../src/db.js")>("../src/db.js");
  db.initDatabase();
  const baseTimeMs = Date.parse("2026-04-14T23:59:00.000Z");
  for (let index = 0; index < 101; index += 1) {
    const chatJid = `web:chat-${String(index).padStart(3, "0")}`;
    db.storeChatMetadata(chatJid, new Date(baseTimeMs - index * 60_000).toISOString(), `Chat ${index}`);
  }

  const { AgentPool } = await importFresh<typeof import("../src/agent-pool.js")>("../src/agent-pool.js");
  const pool = new AgentPool({
    ...createAgentPoolModelOptions(),
    createSession: async () => createRuntime({ subscribe: () => () => {}, prompt: async () => {}, abort: async () => {}, dispose() {} }) as any,
  });

  for (let index = 0; index < 100; index += 1) {
    const chatJid = `web:chat-${String(index).padStart(3, "0")}`;
    (pool as any).pool.set(chatJid, { runtime: createRuntime({ dispose() {} }), lastUsed: Date.now() });
  }

  const scheduled = (pool as any).scheduleRecentChatWarmup({
    limit: 1,
    excludeChatJids: ["web:default", "web:user", "web:newest", "web:newer", "web:older"],
  });
  expect(scheduled).toEqual(["web:chat-100"]);

  await pool.shutdown();
});

test("agent pool explicit warmup still materializes a live runtime", async () => {
  const ws = getTestWorkspace();
  restoreEnv = setEnv({ PICLAW_WORKSPACE: ws.workspace, PICLAW_STORE: ws.store, PICLAW_DATA: ws.data });

  const { AgentPool } = await importFresh<typeof import("../src/agent-pool.js")>("../src/agent-pool.js");
  const created: string[] = [];
  const pool = new AgentPool({
    ...createAgentPoolModelOptions(),
    createSession: async (chatJid: string) => {
      created.push(chatJid);
      return createRuntime({ subscribe: () => () => {}, prompt: async () => {}, abort: async () => {}, dispose() {} }) as any;
    },
  });

  expect(pool.scheduleChatWarmup("web:default", { priority: true })).toBe(true);
  await Bun.sleep(20);

  expect(created).toEqual(["web:default"]);
  expect(pool.getMemoryInstrumentationSnapshot().cachedMainSessions).toBe(1);

  await pool.shutdown();
});

test("agent pool cleanup timer applies the shorter memory-pressure idle TTL", async () => {
  const ws = getTestWorkspace();
  restoreEnv = setEnv({
    PICLAW_WORKSPACE: ws.workspace,
    PICLAW_STORE: ws.store,
    PICLAW_DATA: ws.data,
    PICLAW_MAIN_SESSION_PRESSURE_RSS_BYTES: "1",
    PICLAW_MAIN_SESSION_PRESSURE_IDLE_TTL_MS: "1",
    PICLAW_MAIN_SESSION_PRESSURE_POOL_MAX_SIZE: "2",
  });

  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let cleanupCallback: (() => void) | null = null;

  (globalThis as any).setInterval = ((handler: TimerHandler) => {
    cleanupCallback = handler as () => void;
    return 1 as any;
  }) as typeof setInterval;
  (globalThis as any).clearInterval = (() => {}) as typeof clearInterval;

  try {
    const { AgentPool } = await importFresh<typeof import("../src/agent-pool.js")>("../src/agent-pool.js");

    let disposed = 0;
    class StubSession {
      subscribe(_listener: (event: any) => void) {
        return () => {};
      }
      async prompt(_prompt: string) {}
      async abort() {}
      dispose() {
        disposed += 1;
      }
    }

    const pool = new AgentPool({
    ...createAgentPoolModelOptions(),
      createSession: async () => createRuntime(new StubSession()) as any,
    });

    expect(cleanupCallback).not.toBeNull();

    (pool as any).pool.set("web:one", { runtime: createRuntime(new StubSession()) as any, lastUsed: Date.now() - 10 });
    (pool as any).pool.set("web:two", { runtime: createRuntime(new StubSession()) as any, lastUsed: Date.now() });

    cleanupCallback?.();
    await Bun.sleep(0);

    expect((pool as any).pool.has("web:one")).toBe(false);
    expect((pool as any).pool.has("web:two")).toBe(true);
    expect(pool.getMemoryInstrumentationSnapshot().cachedMainSessions).toBe(1);
    expect(disposed).toBe(1);

    await pool.shutdown();
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("agent pool protects a run before the session flips isStreaming", async () => {
  const ws = getTestWorkspace();
  restoreEnv = setEnv({
    PICLAW_WORKSPACE: ws.workspace,
    PICLAW_STORE: ws.store,
    PICLAW_DATA: ws.data,
    PICLAW_MAIN_SESSION_IDLE_TTL_MS: "1",
    PICLAW_MAIN_SESSION_POOL_MAX_SIZE: "1",
    PICLAW_TURN_AUTO_RECOVERY_ENABLED: "0",
  });

  const { AgentPool } = await importFresh<typeof import("../src/agent-pool.js")>("../src/agent-pool.js");
  let promptStarted!: () => void;
  const promptStartedPromise = new Promise<void>((resolve) => { promptStarted = resolve; });
  let finishPrompt!: () => void;
  const promptBlocked = new Promise<void>((resolve) => { finishPrompt = resolve; });
  let disposed = 0;

  class PendingSession {
    isStreaming = false;
    isBashRunning = false;
    isCompacting = false;
    subscribe(_listener: (event: any) => void) { return () => {}; }
    async prompt(_prompt: string) {
      promptStarted();
      await promptBlocked;
    }
    async abort() {}
    dispose() { disposed += 1; }
  }

  const pool = new AgentPool({
    ...createAgentPoolModelOptions(),
    createSession: async () => createRuntime(new PendingSession()) as any,
  });

  const run = pool.runAgent("race", "web:protected", { timeoutMs: 0 });
  await promptStartedPromise;
  const entry = (pool as any).pool.get("web:protected");
  entry.lastUsed = Date.now() - 10_000;

  // Simulate the periodic cleanup firing after runAgent acquired the runtime but
  // before the SDK marks the session as streaming.
  (pool as any).evictIdle();
  expect((pool as any).pool.has("web:protected")).toBe(true);
  expect(disposed).toBe(0);
  expect(pool.getMemoryInstrumentationSnapshot().sessionManager.evictionProtectedChats).toBe(1);

  finishPrompt();
  await run;
  expect(pool.getMemoryInstrumentationSnapshot().sessionManager.evictionProtectedChats).toBe(0);

  entry.lastUsed = Date.now() - 10_000;
  (pool as any).evictIdle();
  expect((pool as any).pool.has("web:protected")).toBe(false);
  expect(disposed).toBe(1);

  await pool.shutdown();
});

test("agent pool applies the pressure pool cap immediately after acquiring a second session", async () => {
  const ws = getTestWorkspace();
  restoreEnv = setEnv({
    PICLAW_WORKSPACE: ws.workspace,
    PICLAW_STORE: ws.store,
    PICLAW_DATA: ws.data,
    PICLAW_MAIN_SESSION_PRESSURE_RSS_BYTES: "1",
    PICLAW_MAIN_SESSION_PRESSURE_POOL_MAX_SIZE: "1",
    PICLAW_TURN_AUTO_RECOVERY_ENABLED: "0",
  });

  const { AgentPool } = await importFresh<typeof import("../src/agent-pool.js")>("../src/agent-pool.js");

  let disposed = 0;
  class StubSession {
    subscribe(_listener: (event: any) => void) {
      return () => {};
    }
    async prompt(_prompt: string) {}
    async abort() {}
    dispose() {
      disposed += 1;
    }
  }

  const pool = new AgentPool({
    ...createAgentPoolModelOptions(),
    createSession: async () => createRuntime(new StubSession()) as any,
  });

  await pool.runAgent("first", "web:one", { timeoutMs: 0 });
  expect((pool as any).pool.has("web:one")).toBe(true);

  await pool.runAgent("second", "web:two", { timeoutMs: 0 });

  expect((pool as any).pool.has("web:one")).toBe(false);
  expect((pool as any).pool.has("web:two")).toBe(true);
  expect(pool.getMemoryInstrumentationSnapshot().cachedMainSessions).toBe(1);
  expect(disposed).toBe(1);

  await pool.shutdown();
});

test("agent pool enables the default pressure trim path at the 512MB threshold", async () => {
  const ws = getTestWorkspace();
  restoreEnv = setEnv({
    PICLAW_WORKSPACE: ws.workspace,
    PICLAW_STORE: ws.store,
    PICLAW_DATA: ws.data,
    PICLAW_MAIN_SESSION_PRESSURE_RSS_BYTES: undefined,
    PICLAW_MAIN_SESSION_PRESSURE_POOL_MAX_SIZE: undefined,
    PICLAW_MAIN_SESSION_POOL_MAX_SIZE: undefined,
    PICLAW_SESSION_POOL_MAX_SIZE: undefined,
  });

  const originalMemoryUsageRss = process.memoryUsage.rss;
  (process.memoryUsage as typeof process.memoryUsage & { rss: () => number }).rss = () => 520 * 1024 * 1024;

  try {
    const { AgentPool } = await importFresh<typeof import("../src/agent-pool.js")>("../src/agent-pool.js");

    let disposed = 0;
    class StubSession {
      subscribe(_listener: (event: any) => void) {
        return () => {};
      }
      async prompt(_prompt: string) {}
      async abort() {}
      dispose() {
        disposed += 1;
      }
    }

    const pool = new AgentPool({
    ...createAgentPoolModelOptions(),
      createSession: async () => createRuntime(new StubSession()) as any,
    });

    (pool as any).pool.set("web:one", { runtime: createRuntime(new StubSession()) as any, lastUsed: Date.now() - 5_000 });
    (pool as any).pool.set("web:two", { runtime: createRuntime(new StubSession()) as any, lastUsed: Date.now() });

    (pool as any).evictIdle();
    await Bun.sleep(0);

    expect((pool as any).pool.has("web:one")).toBe(false);
    expect((pool as any).pool.has("web:two")).toBe(true);
    expect(pool.getMemoryInstrumentationSnapshot().cachedMainSessions).toBe(1);
    expect(disposed).toBe(1);

    await pool.shutdown();
  } finally {
    (process.memoryUsage as typeof process.memoryUsage & { rss: typeof originalMemoryUsageRss }).rss = originalMemoryUsageRss;
  }
});

test("agent pool trims cached main sessions more aggressively when RSS crosses the pressure threshold", async () => {
  const ws = getTestWorkspace();
  restoreEnv = setEnv({
    PICLAW_WORKSPACE: ws.workspace,
    PICLAW_STORE: ws.store,
    PICLAW_DATA: ws.data,
    PICLAW_MAIN_SESSION_PRESSURE_RSS_BYTES: "1",
    PICLAW_MAIN_SESSION_PRESSURE_POOL_MAX_SIZE: "1",
  });

  const { AgentPool } = await importFresh<typeof import("../src/agent-pool.js")>("../src/agent-pool.js");

  let disposed = 0;
  class StubSession {
    subscribe(_listener: (event: any) => void) {
      return () => {};
    }
    async prompt(_prompt: string) {}
    async abort() {}
    dispose() {
      disposed += 1;
    }
  }

  const pool = new AgentPool({
    ...createAgentPoolModelOptions(),
    createSession: async () => createRuntime(new StubSession()) as any,
  });

  (pool as any).pool.set("web:one", { runtime: createRuntime(new StubSession()) as any, lastUsed: Date.now() - 5_000 });
  (pool as any).pool.set("web:two", { runtime: createRuntime(new StubSession()) as any, lastUsed: Date.now() });

  (pool as any).evictIdle();
  await Bun.sleep(0);

  expect((pool as any).pool.has("web:one")).toBe(false);
  expect((pool as any).pool.has("web:two")).toBe(true);
  expect(pool.getMemoryInstrumentationSnapshot().cachedMainSessions).toBe(1);
  expect(disposed).toBe(1);

  await pool.shutdown();
});

test("agent pool rate-limits repeated recent-chat warmup for the same chat", async () => {
  const ws = createTempWorkspace("piclaw-recent-warmup-cooldown-");
  restoreEnv = setEnv({ PICLAW_WORKSPACE: ws.workspace, PICLAW_STORE: ws.store, PICLAW_DATA: ws.data });

  const db = await importFresh<typeof import("../src/db.js")>("../src/db.js");
  db.initDatabase();
  db.storeChatMetadata("web:only", "2026-04-14T12:00:00.000Z", "Only");

  const { AgentPool } = await importFresh<typeof import("../src/agent-pool.js")>("../src/agent-pool.js");
  const pool = new AgentPool({
    ...createAgentPoolModelOptions(),
    createSession: async () => createRuntime({ subscribe: () => () => {}, prompt: async () => {}, abort: async () => {}, dispose() {} }) as any,
  });

  const first = (pool as any).scheduleRecentChatWarmup({ limit: 1, excludeChatJids: ["web:default"] });
  const second = (pool as any).scheduleRecentChatWarmup({ limit: 1, excludeChatJids: ["web:default"] });

  expect(first).toEqual(["web:only"]);
  expect(second).toEqual([]);

  await pool.shutdown();
});

test("agent pool can run a side prompt with the current model and thinking level", async () => {
  const ws = getTestWorkspace();
  restoreEnv = setEnv({ PICLAW_WORKSPACE: ws.workspace, PICLAW_STORE: ws.store, PICLAW_DATA: ws.data });

  const { AgentPool } = await importFresh<typeof import("../src/agent-pool.js")>("../src/agent-pool.js");

  const seen: Array<{ model: string; reasoning: unknown; prompt: string }> = [];
  class StubSession {
    model = {
      provider: "openai",
      id: "gpt-test",
      api: "openai-responses",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    };
    thinkingLevel = "high";
    subscribe(_listener: (event: any) => void) {
      return () => {};
    }
    async prompt(_prompt: string) {}
    async abort() {}
    dispose() {}
  }

  const pool = new AgentPool({
    ...createAgentPoolModelOptions(),
    createSession: async () => createRuntime(new StubSession()) as any,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
      find: () => undefined,
      getAll: () => [],
      getAvailable: () => [],
    } as any,
    sideStreamSimple: (_model: any, context: any, options: any) => {
      seen.push({
        model: `${_model.provider}/${_model.id}`,
        reasoning: options?.reasoning,
        prompt: context.messages[0].content[0].text,
      });
      return (async function* () {
        yield { type: "thinking_delta", delta: "plan" } as any;
        yield { type: "text_delta", delta: "answer" } as any;
        yield {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "answer" }],
            api: "openai-responses",
            provider: "openai",
            model: "gpt-test",
            usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "stop",
            timestamp: Date.now(),
          },
        } as any;
      })() as any;
    },
  });

  const result = await pool.runSidePrompt("web:default", "Side question");
  expect(result.status).toBe("success");
  expect(result.result).toBe("answer");
  expect(result.thinking).toBe("plan");
  expect(result.model).toBe("openai/gpt-test");
  expect(seen).toEqual([{ model: "openai/gpt-test", reasoning: "high", prompt: "Side question" }]);
});

test("agent pool leaves side-prompt auth assembly to the runtime stream boundary", async () => {
  const ws = getTestWorkspace();
  restoreEnv = setEnv({ PICLAW_WORKSPACE: ws.workspace, PICLAW_STORE: ws.store, PICLAW_DATA: ws.data });

  const { AgentPool } = await importFresh<typeof import("../src/agent-pool.js")>("../src/agent-pool.js");

  const seen: Array<{ apiKey: unknown }> = [];
  class StubSession {
    model = {
      provider: "openai",
      id: "gpt-test",
      api: "openai-responses",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    };
    thinkingLevel = "high";
    subscribe(_listener: (event: any) => void) {
      return () => {};
    }
    async prompt(_prompt: string) {}
    async abort() {}
    dispose() {}
  }

  const pool = new AgentPool({
    ...createAgentPoolModelOptions(),
    createSession: async () => createRuntime(new StubSession()) as any,
    modelRegistry: {
      getApiKey: async () => "side-api-key",
      find: () => undefined,
      getAll: () => [],
      getAvailable: () => [],
    } as any,
    sideStreamSimple: (_model: any, _context: any, options: any) => {
      seen.push({ apiKey: options?.apiKey });
      return (async function* () {
        yield {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "key answer" }],
            api: "openai-responses",
            provider: "openai",
            model: "gpt-test",
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "stop",
            timestamp: Date.now(),
          },
        } as any;
      })() as any;
    },
  });

  const result = await pool.runSidePrompt("web:default", "Side question");
  expect(result.status).toBe("success");
  expect(result.result).toBe("key answer");
  expect(seen).toEqual([{ apiKey: undefined }]);
});

test("agent pool forks active chats from the previous stable turn boundary", async () => {
  const ws = createTempWorkspace("piclaw-active-fork-");
  restoreEnv = setEnv({ PICLAW_WORKSPACE: ws.workspace, PICLAW_STORE: ws.store, PICLAW_DATA: ws.data });

  const db = await importFresh<typeof import("../src/db.js")>("../src/db.js");
  db.initDatabase();
  const { AgentPool } = await importFresh<typeof import("../src/agent-pool.js")>("../src/agent-pool.js");

  const createAssistantMessage = (text: string) => ({
    role: "assistant",
    content: [{ type: "text", text }],
    provider: "openai",
    model: "gpt-test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  } as const);

  class ForkableSession {
    private listeners: Array<(event: any) => void> = [];
    sessionManager: SessionManager;
    sessionFile: string | undefined;
    sessionName = "Research";
    model = { provider: "openai", id: "gpt-test", reasoning: true } as const;
    thinkingLevel = "high" as const;
    isStreaming = false;
    isCompacting = false;
    isRetrying = false;
    isBashRunning = false;
    pendingMessageCount = 0;
    sessionId: string;
    gate: Promise<void> | null = null;

    constructor(private workspace: string, private sessionDir: string, seed = false) {
      this.sessionManager = SessionManager.create(workspace, sessionDir);
      if (seed) {
        this.sessionManager.appendMessage({ role: "user", content: "stable user", timestamp: Date.now() } as const);
        this.sessionManager.appendMessage(createAssistantMessage("stable assistant"));
      }
      this.sessionFile = this.sessionManager.getSessionFile();
      this.sessionId = this.sessionManager.getSessionId();
    }

    subscribe(listener: (event: any) => void) {
      this.listeners.push(listener);
      return () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      };
    }

    async newSession(options?: { parentSession?: string; setup?: (sessionManager: SessionManager) => Promise<void> | void }) {
      const manager = SessionManager.create(this.workspace, this.sessionDir);
      manager.newSession({ parentSession: options?.parentSession });
      if (options?.setup) {
        await options.setup(manager);
      }
      this.sessionManager = manager;
      this.sessionFile = manager.getSessionFile();
      this.sessionId = manager.getSessionId();
      return true;
    }

    async prompt(_prompt: string) {
      this.isStreaming = true;
      this.sessionManager.appendMessage({ role: "user", content: "in-flight user", timestamp: Date.now() } as const);
      this.sessionFile = this.sessionManager.getSessionFile();
      if (this.gate) {
        await this.gate;
      }
      for (const listener of this.listeners) {
        listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done" } });
      }
      this.isStreaming = false;
    }

    async setModel(_model: any) {}
    setThinkingLevel(_level: any) {}
    setSessionName(name: string) { this.sessionName = name; }
    async abort() {}
    dispose() {}
  }

  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const sourceChatJid = "web:default";
  const sourceSession = new ForkableSession(ws.workspace, join(ws.workspace, "sessions-source"), true);
  sourceSession.gate = gate;
  const created: Record<string, ForkableSession> = { [sourceChatJid]: sourceSession };

  const pool = new AgentPool({
    ...createAgentPoolModelOptions(),
    createSession: async (chatJid: string, sessionDir: string) => {
      if (created[chatJid]) return createRuntime(created[chatJid]) as any;
      const session = new ForkableSession(ws.workspace, sessionDir, false);
      created[chatJid] = session;
      return createRuntime(session) as any;
    },
  });

  const runPromise = pool.runAgent("continue", sourceChatJid, { timeoutMs: 0 });
  await Bun.sleep(20);

  const branch = await (pool as any).createForkedChatBranch(sourceChatJid);
  expect(branch.chat_jid).not.toBe(sourceChatJid);
  await (pool as any).getSessionForIntrospection(branch.chat_jid);
  const forkedSession = created[branch.chat_jid];
  const forkedMessages = forkedSession.sessionManager.buildSessionContext().messages;
  const serialized = JSON.stringify(forkedMessages);
  expect(serialized).toContain("stable user");
  expect(serialized).toContain("stable assistant");
  expect(serialized).not.toContain("in-flight user");

  release();
  const result = await runPromise;
  expect(result.status).toBe("success");

  await pool.shutdown();
  ws.cleanup();
});

test("agent pool refuses to prune an active branch session", async () => {
  const ws = createTempWorkspace("piclaw-active-prune-");
  restoreEnv = setEnv({ PICLAW_WORKSPACE: ws.workspace, PICLAW_STORE: ws.store, PICLAW_DATA: ws.data });

  const db = await importFresh<typeof import("../src/db.js")>("../src/db.js");
  db.initDatabase();
  db.storeChatMetadata("web:default", new Date().toISOString(), "Default");
  const root = db.getChatBranchByChatJid("web:default");
  db.storeChatMetadata("web:default:branch:active", new Date().toISOString(), "Research");
  db.ensureChatBranch({
    chat_jid: "web:default:branch:active",
    root_chat_jid: "web:default",
    parent_branch_id: root?.branch_id ?? null,
    agent_name: "research",
  });

  const { AgentPool } = await importFresh<typeof import("../src/agent-pool.js")>("../src/agent-pool.js");

  class ActiveBranchSession {
    sessionName = "Research";
    sessionId = "branch-session";
    isStreaming = true;
    isCompacting = false;
    isRetrying = false;
    isBashRunning = false;
    subscribe(_listener: (event: any) => void) { return () => {}; }
    async prompt(_prompt: string) {}
    async abort() {}
    dispose() {}
  }

  const pool = new AgentPool({
    ...createAgentPoolModelOptions(),
    createSession: async () => createRuntime(new ActiveBranchSession()) as any,
  });

  await (pool as any).getOrCreate("web:default:branch:active");

  await expect((pool as any).pruneChatBranch("web:default:branch:active")).rejects.toThrow(
    "Cannot prune a branch while it is active."
  );
  expect(db.getChatBranchByChatJid("web:default:branch:active")?.archived_at).toBeNull();

  await pool.shutdown();
  ws.cleanup();
});

test("agent pool reports side prompt errors when no model is active", async () => {
  const ws = getTestWorkspace();
  restoreEnv = setEnv({ PICLAW_WORKSPACE: ws.workspace, PICLAW_STORE: ws.store, PICLAW_DATA: ws.data });

  const { AgentPool } = await importFresh<typeof import("../src/agent-pool.js")>("../src/agent-pool.js");

  class StubSession {
    model = null;
    subscribe(_listener: (event: any) => void) {
      return () => {};
    }
    async prompt(_prompt: string) {}
    async abort() {}
    dispose() {}
  }

  const pool = new AgentPool({
    ...createAgentPoolModelOptions(),
    createSession: async () => createRuntime(new StubSession()) as any,
  });

  const result = await pool.runSidePrompt("web:default", "Side question");
  expect(result.status).toBe("error");
  expect(result.error).toContain("No active model selected");
});

test("agent pool can run a tool-capable side prompt through a separate side session", async () => {
  const ws = getTestWorkspace();
  restoreEnv = setEnv({ PICLAW_WORKSPACE: ws.workspace, PICLAW_STORE: ws.store, PICLAW_DATA: ws.data });

  const { AgentPool } = await importFresh<typeof import("../src/agent-pool.js")>("../src/agent-pool.js");

  const mainModel = {
    provider: "openai",
    id: "gpt-test",
    api: "openai-responses",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  };

  class MainSession {
    model = mainModel;
    thinkingLevel = "high";
    sessionManager = {
      buildSessionContext: () => ({
        messages: [{ role: "user", content: [{ type: "text", text: "main context" }], timestamp: Date.now() }],
        thinkingLevel: "high",
        model: { provider: "openai", modelId: "gpt-test" },
      }),
    };
    getActiveToolNames() { return ["read", "bash"]; }
    subscribe(_listener: (event: any) => void) { return () => {}; }
    async prompt(_prompt: string) {}
    async abort() {}
    dispose() {}
  }

  const seen: any = { model: null, thinking: null, persistedThinking: null, tools: null, prompt: null, seeded: false };
  class SideSession {
    model = undefined;
    isStreaming = false;
    isCompacting = false;
    isRetrying = false;
    isBashRunning = false;
    listeners: Array<(event: any) => void> = [];
    subscribe(listener: (event: any) => void) {
      this.listeners.push(listener);
      return () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      };
    }
    async newSession(options: any) {
      seen.seeded = typeof options?.setup === "function";
      if (typeof options?.setup === "function") {
        await options.setup({
          appendSessionInfo: () => {},
          appendModelChange: () => {},
          appendThinkingLevelChange: (level: string) => { seen.persistedThinking = level; },
          appendCompaction: () => {},
          appendCustomMessageEntry: () => {},
          appendMessage: () => {},
        });
      }
      return true;
    }
    async setModel(model: any) { this.model = model; seen.model = `${model.provider}/${model.id}`; }
    setThinkingLevel(level: any) { seen.thinking = level; }
    setActiveToolsByName(toolNames: string[]) { seen.tools = [...toolNames]; }
    async prompt(prompt: string) {
      seen.prompt = prompt;
      for (const listener of this.listeners) {
        listener({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "tool plan" } });
        listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "tool answer" } });
        listener({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "tool answer" }],
            usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "stop",
            timestamp: Date.now(),
          },
        });
      }
    }
    async abort() {}
    getLastAssistantText() { return "tool answer"; }
    dispose() {}
  }

  const pool = new AgentPool({
    ...createAgentPoolModelOptions(),
    createSession: async () => createRuntime(new MainSession()) as any,
    createSideSession: async () => createRuntime(new SideSession()) as any,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
      find: () => undefined,
      getAll: () => [],
      getAvailable: () => [],
    } as any,
  });

  const result = await pool.runSidePrompt("web:default", "Inspect workspace", { systemPrompt: "Use tools if needed." });
  expect(result.status).toBe("success");
  expect(result.result).toBe("tool answer");
  expect(result.thinking).toBe("tool plan");
  expect(result.model).toBe("openai/gpt-test");
  expect(seen).toEqual({
    model: "openai/gpt-test",
    thinking: "high",
    persistedThinking: "high",
    tools: ["read", "bash"],
    prompt: "Use tools if needed.\n\nInspect workspace",
    seeded: true,
  });
});
