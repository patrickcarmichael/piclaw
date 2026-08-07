import { describe, expect, test } from "bun:test";
import { runProcessChatPreflight } from "../../../../src/channels/web/runtime/process-chat-preflight-runtime.js";
import { getChatCursor, getChatPreflight, initDatabase, storeChatMetadata } from "../../../../src/db.js";
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

      const result = await runProcessChatPreflight({
        channel: {
          agentPool: {
            getSessionForIntrospection: async () => ({}),
            emergencyRotateSession: async () => {
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
      let resumes = 0;
      const channel = {
        agentPool: {
          getSessionForIntrospection: async () => ({}),
          emergencyRotateSession: async () => ({ status: "success", message: "rotated" }),
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
        compactionState: { lastCompactionErrorMessage: null, lastCompactionSuppressed: false },
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
      expect(getChatPreflight(chatJid)).toBeNull();
      expect(resumes).toBe(1);
    });
  });
});
