import { describe, expect, test } from "bun:test";
import { runDurableOperationPreflight, runProcessChatPreflight } from "../../../../src/channels/web/runtime/process-chat-preflight-runtime.js";
import {
  beginChatPreflight,
  cancelChatOperation,
  claimNextChatOperation,
  clearChatPreflight,
  completeChatOperation,
  getChatCursor,
  getChatOperation,
  getChatPreflight,
  getFailedRun,
  initDatabase,
  promoteChatOperation,
  storeAcceptedChatMessageSource,
  storeChatMetadata,
} from "../../../../src/db.js";
import { waitFor, withTempWorkspaceEnv } from "../../../helpers.js";

describe("process chat preflight runtime", () => {
  test("falls back to a normal chat run when introspection is unavailable", async () => {
    await withTempWorkspaceEnv("preflight-runtime-", {}, async () => {
      initDatabase();
      const chatJid = "web:test";
      storeChatMetadata(chatJid, "2026-01-01T00:00:00.000Z", "Web");
      const result = await runProcessChatPreflight({ channel: { agentPool: {} } as any, chatJid, agentId: "default", message: { id: "m1", timestamp: "2026-01-01T00:00:01.000Z" }, prevCursor: getChatCursor(chatJid), effectiveThreadRootId: null, turnId: "turn-1", runStartedAt: new Date().toISOString(), streamingHandler() {}, compactionState: { lastCompactionErrorMessage: null, lastCompactionSuppressed: false }, enqueueResume() {} });
      expect(result).toBe("continue");
    });
  });

  test("emergency rotation releases only its owner and queues one bounded resume", async () => {
    await withTempWorkspaceEnv("preflight-runtime-rotation-", {}, async () => {
      initDatabase();
      const chatJid = "web:rotation";
      const prevCursor = "2026-01-01T00:00:00.000Z";
      storeChatMetadata(chatJid, prevCursor, "Web");
      let rotations = 0;
      let resumes = 0;
      let sessionLaneHeld = false;

      const result = await runProcessChatPreflight({
        channel: {
          agentPool: {
            runSessionMutation: async (_chatJid: string, _mutation: string, _request: unknown, action: (session: object) => unknown) => {
              sessionLaneHeld = true;
              try {
                return await action({});
              } finally {
                sessionLaneHeld = false;
              }
            },
            emergencyRotateSession: async () => {
              expect(sessionLaneHeld).toBe(true);
              rotations += 1;
              return { status: "success", message: "rotated" };
            },
          },
        } as any,
        chatJid,
        agentId: "default",
        message: { id: "m-rotation", timestamp: "2026-01-01T00:00:01.000Z" },
        prevCursor,
        effectiveThreadRootId: null,
        turnId: "turn-rotation",
        runStartedAt: "2026-01-01T00:00:02.000Z",
        streamingHandler() {},
        compactionState: { lastCompactionErrorMessage: "summary validation failed", lastCompactionSuppressed: false },
        enqueueResume() { resumes += 1; },
        deps: {
          getForegroundMs: () => 100,
          maybeAutoCompactSessionBeforePrompt: async () => {},
        } as any,
      });

      expect(result).toBe("deferred");
      expect(rotations).toBe(1);
      expect(resumes).toBe(1);
      expect(getChatPreflight(chatJid)).toBeNull();
    });
  });

  test("failed foreground emergency rotation blocks legacy preflight and emits one generic wake", async () => {
    await withTempWorkspaceEnv("preflight-runtime-rotation-failed-", {}, async () => {
      initDatabase();
      const chatJid = "web:rotation-failed";
      const prevCursor = "2026-01-01T00:00:00.000Z";
      storeChatMetadata(chatJid, prevCursor, "Web");
      let resumes = 0;

      const result = await runProcessChatPreflight({
        channel: {
          agentPool: {
            runSessionMutation: async (_chatJid: string, _mutation: string, _request: unknown, action: (session: object) => unknown) => action({}),
            emergencyRotateSession: async () => ({ status: "error", message: "rotation failed" }),
          },
        } as any,
        chatJid,
        agentId: "default",
        message: { id: "m-rotation-failed", timestamp: "2026-01-01T00:00:01.000Z" },
        prevCursor,
        effectiveThreadRootId: 42,
        turnId: "turn-rotation-failed",
        runStartedAt: "2026-01-01T00:00:02.000Z",
        streamingHandler() {},
        compactionState: { lastCompactionErrorMessage: "summary invalid", lastCompactionSuppressed: false },
        enqueueResume(root) {
          expect(root).toBeUndefined();
          resumes += 1;
        },
        deps: {
          getForegroundMs: () => 100,
          maybeAutoCompactSessionBeforePrompt: async () => {},
        } as any,
      });

      expect(result).toBe("deferred");
      expect(resumes).toBe(1);
      expect(getChatPreflight(chatJid)).toBeNull();
      expect(getFailedRun(chatJid)).toMatchObject({ messageId: "m-rotation-failed", prevTs: prevCursor });
    });
  });

  test("retains deferred compaction ownership and queues one resume after compare-and-clear", async () => {
    await withTempWorkspaceEnv("preflight-runtime-owned-", {}, async () => {
      initDatabase();
      const chatJid = "web:owned";
      const prevCursor = "2026-01-01T00:00:00.000Z";
      const message = { id: "m-owned", timestamp: "2026-01-01T00:00:01.000Z" };
      storeChatMetadata(chatJid, prevCursor, "Web");

      let releaseCompaction!: () => void;
      const compactionGate = new Promise<void>((resolve) => { releaseCompaction = resolve; });
      let physicalCompactions = 0;
      let rotations = 0;
      let resumes = 0;
      let sessionLaneHeld = false;
      const channel = {
        agentPool: {
          runSessionMutation: async (_chatJid: string, _mutation: string, _request: unknown, action: (session: object) => unknown) => {
            sessionLaneHeld = true;
            try {
              return await action({});
            } finally {
              sessionLaneHeld = false;
            }
          },
          emergencyRotateSession: async () => {
            expect(sessionLaneHeld).toBe(true);
            rotations += 1;
            return { status: "success", message: "rotated" };
          },
        },
      } as any;
      const deps = {
        getForegroundMs: () => 0,
        maybeAutoCompactSessionBeforePrompt: async () => {
          physicalCompactions += 1;
          await compactionGate;
        },
      } as any;
      const base = {
        channel,
        chatJid,
        agentId: "default",
        message,
        prevCursor,
        effectiveThreadRootId: null,
        browserObservability: undefined,
        streamingHandler() {},
        compactionState: { lastCompactionErrorMessage: "summary invalid", lastCompactionSuppressed: false },
        enqueueResume() { resumes += 1; },
        deps,
      };

      expect(await runProcessChatPreflight({ ...base, turnId: "turn-owner", runStartedAt: "2026-01-01T00:00:02.000Z" })).toBe("deferred");
      expect(getChatPreflight(chatJid)).toEqual({
        chatJid,
        prevTs: prevCursor,
        messageId: message.id,
        startedAt: "2026-01-01T00:00:02.000Z",
      });

      expect(await runProcessChatPreflight({ ...base, turnId: "turn-duplicate", runStartedAt: "2026-01-01T00:00:03.000Z" })).toBe("deferred");
      expect(physicalCompactions).toBe(1);
      expect(resumes).toBe(0);

      releaseCompaction();
      await waitFor(() => resumes === 1, 250, 1);
      expect(rotations).toBe(1);
      expect(getChatPreflight(chatJid)).toBeNull();
      expect(resumes).toBe(1);
    });
  });

  test("foreground legacy replacement at compaction settlement prevents stale rotation and emits one generic wake", async () => {
    await withTempWorkspaceEnv("preflight-runtime-foreground-replaced-", {}, async () => {
      initDatabase();
      const chatJid = "web:legacy-foreground-replaced";
      const prevCursor = "2026-01-01T00:00:00.000Z";
      const owner = {
        prevTs: prevCursor,
        messageId: "m-foreground-original",
        startedAt: "2026-01-01T00:00:02.000Z",
      };
      const replacement = {
        prevTs: prevCursor,
        messageId: "m-foreground-replacement",
        startedAt: "2026-01-01T00:00:03.000Z",
      };
      storeChatMetadata(chatJid, prevCursor, "Web");
      let resumes = 0;
      let rotations = 0;

      const result = await runProcessChatPreflight({
        channel: {
          agentPool: {
            runSessionMutation: async (_chatJid: string, _mutation: string, _request: unknown, action: (session: object) => unknown) => action({}),
            emergencyRotateSession: async () => {
              rotations += 1;
              return { status: "success", message: "must not rotate" };
            },
          },
        } as any,
        chatJid,
        agentId: "default",
        message: { id: owner.messageId, timestamp: "2026-01-01T00:00:01.000Z" },
        prevCursor,
        effectiveThreadRootId: 42,
        turnId: "turn-foreground-original",
        runStartedAt: owner.startedAt,
        streamingHandler() {},
        compactionState: { lastCompactionErrorMessage: "summary invalid", lastCompactionSuppressed: false },
        enqueueResume(root) {
          expect(root).toBeUndefined();
          resumes += 1;
        },
        deps: {
          getForegroundMs: () => 100,
          maybeAutoCompactSessionBeforePrompt: async () => {
            expect(clearChatPreflight(chatJid, owner)).toBe(true);
            expect(beginChatPreflight(chatJid, replacement)).toBe(true);
          },
        } as any,
      });

      expect(result).toBe("deferred");
      expect(rotations).toBe(0);
      expect(resumes).toBe(1);
      expect(getChatPreflight(chatJid)).toEqual({ chatJid, ...replacement });
    });
  });

  test("background legacy replacement prevents stale rotation and emits one generic wake", async () => {
    await withTempWorkspaceEnv("preflight-runtime-replaced-", {}, async () => {
      initDatabase();
      const chatJid = "web:legacy-replaced";
      const prevCursor = "2026-01-01T00:00:00.000Z";
      const owner = {
        prevTs: prevCursor,
        messageId: "m-original",
        startedAt: "2026-01-01T00:00:02.000Z",
      };
      const replacement = {
        prevTs: prevCursor,
        messageId: "m-replacement",
        startedAt: "2026-01-01T00:00:03.000Z",
      };
      storeChatMetadata(chatJid, prevCursor, "Web");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let resumes = 0;
      let rotations = 0;

      const result = await runProcessChatPreflight({
        channel: {
          agentPool: {
            runSessionMutation: async (_chatJid: string, _mutation: string, _request: unknown, action: (session: object) => unknown) => action({}),
            emergencyRotateSession: async () => {
              rotations += 1;
              return { status: "error", message: "replacement must survive" };
            },
          },
        } as any,
        chatJid,
        agentId: "default",
        message: { id: owner.messageId, timestamp: "2026-01-01T00:00:01.000Z" },
        prevCursor,
        effectiveThreadRootId: 42,
        turnId: "turn-original",
        runStartedAt: owner.startedAt,
        streamingHandler() {},
        compactionState: { lastCompactionErrorMessage: "summary invalid", lastCompactionSuppressed: false },
        enqueueResume(root) {
          expect(root).toBeUndefined();
          resumes += 1;
        },
        deps: {
          getForegroundMs: () => 0,
          maybeAutoCompactSessionBeforePrompt: async () => { await gate; },
        } as any,
      });
      expect(result).toBe("deferred");
      expect(clearChatPreflight(chatJid, owner)).toBe(true);
      expect(beginChatPreflight(chatJid, replacement)).toBe(true);

      release();
      await waitFor(() => resumes === 1, 250, 1);
      expect(rotations).toBe(0);
      expect(resumes).toBe(1);
      expect(getChatPreflight(chatJid)).toEqual({ chatJid, ...replacement });
    });
  });

  test("promotes a durable accepted message from pending through preflight to running", async () => {
    await withTempWorkspaceEnv("durable-preflight-runtime-", {}, async () => {
      initDatabase();
      const chatJid = "web:durable";
      storeChatMetadata(chatJid, "", "Web");
      storeAcceptedChatMessageSource({
        chat_jid: chatJid,
        id: "m-durable",
        sender: "user",
        sender_name: "User",
        content: "durable prompt",
        timestamp: "2026-01-01T00:00:01.000Z",
      });
      const claim = claimNextChatOperation(chatJid);
      expect(claim.status).toBe("claimed");
      if (claim.status !== "claimed") throw new Error("expected durable claim");

      const result = await runDurableOperationPreflight({
        channel: { agentPool: {} } as any,
        chatJid,
        agentId: "default",
        message: { id: "m-durable", timestamp: "2026-01-01T00:00:01.000Z" },
        operation: claim.operation,
        effectiveThreadRootId: null,
        turnId: "turn-durable",
        streamingHandler() {},
        compactionState: { lastCompactionErrorMessage: null, lastCompactionSuppressed: false },
        enqueueResume() {},
      });

      expect(result.status).toBe("continue");
      expect(getChatOperation(chatJid)).toMatchObject({
        operationId: claim.operation.operationId,
        sourceSeq: claim.operation.sourceSeq,
        phase: "running",
        generation: 2,
      });
      expect(getChatPreflight(chatJid)).toBeNull();
    });
  });

  test("lost foreground durable promotion emits one generic wake without changing ownership", async () => {
    await withTempWorkspaceEnv("durable-preflight-lost-promotion-", {}, async () => {
      initDatabase();
      const chatJid = "web:durable-lost-promotion";
      storeChatMetadata(chatJid, "", "Web");
      storeAcceptedChatMessageSource({
        chat_jid: chatJid,
        id: "m-lost-promotion",
        sender: "user",
        sender_name: "User",
        content: "lost promotion",
        timestamp: "2026-01-01T00:00:01.000Z",
      });
      const claim = claimNextChatOperation(chatJid);
      if (claim.status !== "claimed") throw new Error("expected durable claim");
      let promotions = 0;
      let resumes = 0;
      let successor: ReturnType<typeof getChatOperation> = null;

      const result = await runDurableOperationPreflight({
        channel: {
          agentPool: {
            runSessionMutation: async (_chatJid: string, _mutation: string, _request: unknown, action: (session: object) => unknown) => action({}),
            emergencyRotateSession: async () => ({ status: "success", message: "unused" }),
          },
        } as any,
        chatJid,
        agentId: "default",
        message: { id: "m-lost-promotion", timestamp: "2026-01-01T00:00:01.000Z" },
        operation: claim.operation,
        effectiveThreadRootId: 42,
        turnId: "turn-lost-promotion",
        streamingHandler() {},
        compactionState: { lastCompactionErrorMessage: null, lastCompactionSuppressed: false },
        enqueueResume(root) {
          expect(root).toBeUndefined();
          resumes += 1;
        },
        deps: {
          getForegroundMs: () => 100,
          maybeAutoCompactSessionBeforePrompt: async () => {},
          promoteChatOperation: (jid, owner, phase) => {
            promotions += 1;
            if (promotions === 1) return promoteChatOperation(jid, owner, phase);
            const cancelled = cancelChatOperation(jid, owner, {
              cause: "test_replace",
              requestedAt: "2026-08-08T09:10:00.000Z",
            });
            if (cancelled.status !== "applied") throw new Error("expected cancellation");
            const completed = completeChatOperation(jid, {
              owner: {
                operationId: cancelled.operation.operationId,
                sourceSeq: cancelled.operation.sourceSeq,
                phase: cancelled.operation.phase,
                generation: cancelled.operation.generation,
              },
              outcome: "cancelled",
              cause: "test_replace",
              provenance: "preflight_test",
              createdAt: "2026-08-08T09:10:01.000Z",
            });
            if (completed.status !== "completed") throw new Error("expected completion");
            storeAcceptedChatMessageSource({
              chat_jid: jid,
              id: "m-lost-promotion-successor",
              sender: "user",
              sender_name: "User",
              content: "successor",
              timestamp: "2026-01-01T00:00:02.000Z",
            });
            const claimed = claimNextChatOperation(jid);
            if (claimed.status !== "claimed") throw new Error("expected successor claim");
            successor = claimed.operation;
            return promoteChatOperation(jid, owner, phase);
          },
        },
      });

      expect(result.status).toBe("deferred");
      expect(promotions).toBe(2);
      expect(resumes).toBe(1);
      expect(successor).not.toBeNull();
      expect(getChatOperation(chatJid)).toEqual(successor);
    });
  });

  test("cancellation during deferred durable compaction prevents mutation and emits one ownership-neutral wake", async () => {
    await withTempWorkspaceEnv("durable-preflight-cancelled-", {}, async () => {
      initDatabase();
      const chatJid = "web:durable-cancelled";
      storeChatMetadata(chatJid, "", "Web");
      storeAcceptedChatMessageSource({
        chat_jid: chatJid,
        id: "m-cancelled",
        sender: "user",
        sender_name: "User",
        content: "cancelled prompt",
        timestamp: "2026-01-01T00:00:01.000Z",
      });
      const claim = claimNextChatOperation(chatJid);
      if (claim.status !== "claimed") throw new Error("expected durable claim");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let rotations = 0;
      let resumes = 0;

      const result = await runDurableOperationPreflight({
        channel: {
          agentPool: {
            runSessionMutation: async (_chatJid: string, _mutation: string, _request: unknown, action: (session: object) => unknown) => action({}),
            emergencyRotateSession: async () => {
              rotations += 1;
              return { status: "success", message: "rotated" };
            },
          },
        } as any,
        chatJid,
        agentId: "default",
        message: { id: "m-cancelled", timestamp: "2026-01-01T00:00:01.000Z" },
        operation: claim.operation,
        effectiveThreadRootId: null,
        turnId: "turn-cancelled",
        streamingHandler() {},
        compactionState: { lastCompactionErrorMessage: "force rotation", lastCompactionSuppressed: false },
        enqueueResume() { resumes += 1; },
        deps: {
          getForegroundMs: () => 0,
          maybeAutoCompactSessionBeforePrompt: async () => { await gate; },
        },
      });
      expect(result.status).toBe("deferred");
      const preflight = getChatOperation(chatJid)!;
      const cancelled = cancelChatOperation(chatJid, {
        operationId: preflight.operationId,
        sourceSeq: preflight.sourceSeq,
        phase: preflight.phase,
        generation: preflight.generation,
      }, { cause: "remote_abort", requestedAt: "2026-08-08T08:55:00.000Z" });
      expect(cancelled.status).toBe("applied");

      release();
      await Bun.sleep(20);
      expect(rotations).toBe(0);
      expect(resumes).toBe(1);
      expect(getChatOperation(chatJid)).toMatchObject({
        operationId: claim.operation.operationId,
        phase: "preflight",
        cancellation: { cause: "remote_abort" },
      });
    });
  });

  test("replaced durable ownership during deferred work remains untouched and emits one generic wake", async () => {
    await withTempWorkspaceEnv("durable-preflight-replaced-", {}, async () => {
      initDatabase();
      const chatJid = "web:durable-replaced";
      storeChatMetadata(chatJid, "", "Web");
      storeAcceptedChatMessageSource({
        chat_jid: chatJid,
        id: "m-replaced-first",
        sender: "user",
        sender_name: "User",
        content: "first",
        timestamp: "2026-01-01T00:00:01.000Z",
      });
      const claim = claimNextChatOperation(chatJid);
      if (claim.status !== "claimed") throw new Error("expected durable claim");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let resumes = 0;

      const result = await runDurableOperationPreflight({
        channel: {
          agentPool: {
            runSessionMutation: async (_chatJid: string, _mutation: string, _request: unknown, action: (session: object) => unknown) => action({}),
            emergencyRotateSession: async () => ({ status: "success", message: "unused" }),
          },
        } as any,
        chatJid,
        agentId: "default",
        message: { id: "m-replaced-first", timestamp: "2026-01-01T00:00:01.000Z" },
        operation: claim.operation,
        effectiveThreadRootId: null,
        turnId: "turn-replaced",
        streamingHandler() {},
        compactionState: { lastCompactionErrorMessage: null, lastCompactionSuppressed: false },
        enqueueResume(root) {
          expect(root).toBeUndefined();
          resumes += 1;
        },
        deps: {
          getForegroundMs: () => 0,
          maybeAutoCompactSessionBeforePrompt: async () => { await gate; },
        },
      });
      expect(result.status).toBe("deferred");
      const preflight = getChatOperation(chatJid)!;
      const cancelled = cancelChatOperation(chatJid, {
        operationId: preflight.operationId,
        sourceSeq: preflight.sourceSeq,
        phase: preflight.phase,
        generation: preflight.generation,
      }, { cause: "test_replace", requestedAt: "2026-08-08T09:00:00.000Z" });
      if (cancelled.status !== "applied") throw new Error("expected cancellation");
      expect(completeChatOperation(chatJid, {
        owner: {
          operationId: cancelled.operation.operationId,
          sourceSeq: cancelled.operation.sourceSeq,
          phase: cancelled.operation.phase,
          generation: cancelled.operation.generation,
        },
        outcome: "cancelled",
        cause: "test_replace",
        provenance: "preflight_test",
        createdAt: "2026-08-08T09:00:01.000Z",
      }).status).toBe("completed");
      storeAcceptedChatMessageSource({
        chat_jid: chatJid,
        id: "m-replaced-second",
        sender: "user",
        sender_name: "User",
        content: "second",
        timestamp: "2026-01-01T00:00:02.000Z",
      });
      const successor = claimNextChatOperation(chatJid);
      if (successor.status !== "claimed") throw new Error("expected successor claim");

      release();
      await waitFor(() => resumes === 1, 250, 1);
      expect(getChatOperation(chatJid)).toEqual(successor.operation);
    });
  });

  test("failed background durable rotation exact-owner blocks and emits one generic wake", async () => {
    await withTempWorkspaceEnv("durable-preflight-rotation-failed-", {}, async () => {
      initDatabase();
      const chatJid = "web:durable-rotation-failed";
      storeChatMetadata(chatJid, "", "Web");
      storeAcceptedChatMessageSource({
        chat_jid: chatJid,
        id: "m-durable-rotation-failed",
        sender: "user",
        sender_name: "User",
        content: "rotate",
        timestamp: "2026-01-01T00:00:01.000Z",
      });
      const claim = claimNextChatOperation(chatJid);
      if (claim.status !== "claimed") throw new Error("expected durable claim");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let resumes = 0;

      const result = await runDurableOperationPreflight({
        channel: {
          agentPool: {
            runSessionMutation: async (_chatJid: string, _mutation: string, _request: unknown, action: (session: object) => unknown) => action({}),
            emergencyRotateSession: async () => ({ status: "error", message: "rotation failed" }),
          },
        } as any,
        chatJid,
        agentId: "default",
        message: { id: "m-durable-rotation-failed", timestamp: "2026-01-01T00:00:01.000Z" },
        operation: claim.operation,
        effectiveThreadRootId: null,
        turnId: "turn-durable-rotation-failed",
        streamingHandler() {},
        compactionState: { lastCompactionErrorMessage: "summary invalid", lastCompactionSuppressed: false },
        enqueueResume(root) {
          expect(root).toBeUndefined();
          resumes += 1;
        },
        deps: {
          getForegroundMs: () => 0,
          maybeAutoCompactSessionBeforePrompt: async () => { await gate; },
        },
      });
      expect(result.status).toBe("deferred");
      release();
      await waitFor(() => resumes === 1, 250, 1);
      expect(getChatOperation(chatJid)).toMatchObject({
        operationId: claim.operation.operationId,
        phase: "blocked",
        generation: 2,
      });
    });
  });

  test("retains durable preflight ownership across deferred compaction and resumes as running", async () => {
    await withTempWorkspaceEnv("durable-preflight-deferred-", {}, async () => {
      initDatabase();
      const chatJid = "web:durable-deferred";
      storeChatMetadata(chatJid, "", "Web");
      storeAcceptedChatMessageSource({
        chat_jid: chatJid,
        id: "m-deferred",
        sender: "user",
        sender_name: "User",
        content: "deferred prompt",
        timestamp: "2026-01-01T00:00:01.000Z",
      });
      const claim = claimNextChatOperation(chatJid);
      if (claim.status !== "claimed") throw new Error("expected durable claim");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let resumes = 0;
      let physicalCompactions = 0;
      const base = {
        channel: {
          agentPool: {
            runSessionMutation: async (_chatJid: string, _mutation: string, _request: unknown, action: (session: object) => unknown) => action({}),
            emergencyRotateSession: async () => ({ status: "success", message: "rotated" }),
          },
        } as any,
        chatJid,
        agentId: "default",
        message: { id: "m-deferred", timestamp: "2026-01-01T00:00:01.000Z" },
        effectiveThreadRootId: 42,
        streamingHandler() {},
        compactionState: { lastCompactionErrorMessage: null, lastCompactionSuppressed: false },
        enqueueResume(root: number | undefined) {
          expect(root).toBeUndefined();
          resumes += 1;
        },
        deps: {
          getForegroundMs: () => 0,
          maybeAutoCompactSessionBeforePrompt: async () => {
            physicalCompactions += 1;
            await gate;
          },
        },
      };

      const result = await runDurableOperationPreflight({
        ...base,
        operation: claim.operation,
        turnId: "turn-deferred",
      });
      expect(result.status).toBe("deferred");
      const ownedPreflight = getChatOperation(chatJid)!;
      expect(ownedPreflight.phase).toBe("preflight");

      const duplicate = await runDurableOperationPreflight({
        ...base,
        operation: ownedPreflight,
        turnId: "turn-duplicate",
      });
      expect(duplicate.status).toBe("deferred");
      expect(physicalCompactions).toBe(1);
      expect(resumes).toBe(0);
      release();
      await waitFor(() => resumes === 1, 250, 1);
      expect(getChatOperation(chatJid)).toMatchObject({ phase: "running", generation: 2 });
    });
  });
});
