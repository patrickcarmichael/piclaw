import { describe, expect, test } from "bun:test";
import {
  getThreadRootId,
  resumeChat,
  retryFailedOnModelSwitch,
  skipFailedOnModelSwitch,
  type ChatRunControlStore,
  type ResumeChatContext,
} from "../../../../src/channels/web/runtime/chat-run-control.js";
import { AgentQueue } from "../../../../src/queue.js";

describe("web chat run control helpers", () => {
  test("getThreadRootId delegates to store", () => {
    const store: ChatRunControlStore = {
      getThreadRootId: (chatJid, messageId) => (chatJid === "web:1" && messageId === "m1" ? 123 : null),
      getFailedRun: () => undefined,
      getChatCursor: () => "",
      setChatCursor: () => {},
      clearFailedRun: () => {},
    };

    expect(getThreadRootId("web:1", "m1", store)).toBe(123);
    expect(getThreadRootId("web:1", "m2", store)).toBeNull();
  });

  test("resumeChat enqueues task and invokes processChat with default agent", async () => {
    const enqueued: Array<{ key: string; task: () => Promise<void> }> = [];
    const processed: Array<{ chatJid: string; agentId: string; threadRootId?: number | null }> = [];

    const ctx: ResumeChatContext = {
      defaultAgentId: "default",
      enqueue: (task, key) => {
        enqueued.push({ task, key });
      },
      processChat: async (chatJid, agentId, threadRootId) => {
        processed.push({ chatJid, agentId, threadRootId });
      },
    };

    resumeChat("web:1", 77, ctx);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].key).toBe("resume:web:1:77");

    await enqueued[0].task();
    expect(processed).toEqual([{ chatJid: "web:1", agentId: "default", threadRootId: 77 }]);
  });

  test("resumeChat uses stable wake key when no thread root is provided", async () => {
    const enqueued: Array<{ key: string; task: () => Promise<void> }> = [];

    const ctx: ResumeChatContext = {
      defaultAgentId: "default",
      enqueue: (task, key) => {
        enqueued.push({ task, key });
      },
      processChat: async () => {},
    };

    resumeChat("web:1", undefined, ctx);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].key).toBe("resume:web:1:wake");

    // A second call with no threadRootId produces the same key, so the queue
    // will deduplicate it.
    resumeChat("web:1", null, ctx);
    expect(enqueued).toHaveLength(2);
    expect(enqueued[1].key).toBe("resume:web:1:wake");
  });

  test("resumeChat drains a same-ID wake enqueued by the executing chat lane", async () => {
    const queue = new AgentQueue();
    const processed: number[] = [];
    let ctx!: ResumeChatContext;

    ctx = {
      defaultAgentId: "default",
      enqueue: (task, key, laneKey) => queue.enqueue(task, key, laneKey),
      processChat: async () => {
        processed.push(processed.length + 1);
        if (processed.length === 1) resumeChat("web:1", undefined, ctx);
      },
    };

    resumeChat("web:1", undefined, ctx);
    await Bun.sleep(80);

    expect(processed).toEqual([1, 2]);
    expect(queue.getMetrics()).toEqual(expect.objectContaining({
      enqueued: 2,
      deduplicated: 0,
      succeeded: 2,
    }));

    await queue.shutdown(100);
  });

  test("skipFailedOnModelSwitch advances cursor only when needed and clears failure", () => {
    const setCalls: Array<{ chatJid: string; ts: string }> = [];
    const clearCalls: string[] = [];

    const store: ChatRunControlStore = {
      getThreadRootId: () => null,
      getFailedRun: () => ({ prevTs: "2024-01-01T00:00:00.000Z", failedTs: "2024-01-01T00:00:05.000Z" }),
      getChatCursor: () => "2024-01-01T00:00:00.000Z",
      setChatCursor: (chatJid, ts) => {
        setCalls.push({ chatJid, ts });
      },
      clearFailedRun: (chatJid) => {
        clearCalls.push(chatJid);
      },
    };

    skipFailedOnModelSwitch("web:1", store);

    expect(setCalls).toEqual([{ chatJid: "web:1", ts: "2024-01-01T00:00:05.000Z" }]);
    expect(clearCalls).toEqual(["web:1"]);
  });

  test("retryFailedOnModelSwitch rewinds cursor to the failed prevTs and clears failure", () => {
    const setCalls: Array<{ chatJid: string; ts: string }> = [];
    const clearCalls: string[] = [];

    const store: ChatRunControlStore = {
      getThreadRootId: () => null,
      getFailedRun: () => ({ prevTs: "2024-01-01T00:00:00.000Z", failedTs: "2024-01-01T00:00:05.000Z" }),
      getChatCursor: () => "2024-01-01T00:00:05.000Z",
      setChatCursor: (chatJid, ts) => {
        setCalls.push({ chatJid, ts });
      },
      clearFailedRun: (chatJid) => {
        clearCalls.push(chatJid);
      },
    };

    retryFailedOnModelSwitch("web:1", store);

    expect(setCalls).toEqual([{ chatJid: "web:1", ts: "2024-01-01T00:00:00.000Z" }]);
    expect(clearCalls).toEqual(["web:1"]);
  });
});
