import { describe, expect, test } from "bun:test";
import { storeAgentTurn } from "../../../../src/channels/web/messaging/agent-message-store.js";
import type { WebChannel } from "../../../../src/channels/web.js";
import type { AgentEventEmitter } from "../../../../src/channels/web/sse/agent-events.js";

/** Minimal mock of WebChannel that tracks placeholder and store calls. */
function createMockChannel(placeholderIds: number[] = []) {
  const calls: string[] = [];
  const queue = [...placeholderIds];
  return {
    calls,
    channel: {
      consumeQueuedFollowupPlaceholder: (chatJid: string) => {
        const next = queue.shift() ?? null;
        if (next) calls.push(`consume:${chatJid}:${next}`);
        return next;
      },
      replaceQueuedFollowupPlaceholder: (
        chatJid: string,
        rowId: number,
        _text: string,
        _mediaIds: number[],
        _contentBlocks: unknown,
        threadId: number | undefined,
        isTerminalAgentReply?: boolean,
        beforeBroadcast?: (interaction: any) => boolean,
      ) => {
        calls.push(
          `replace:${chatJid}:${rowId}:thread=${threadId ?? "undefined"}:terminal=${isTerminalAgentReply ? 1 : 0}`
        );
        const interaction = { id: rowId, timestamp: "t", data: {} };
        beforeBroadcast?.(interaction);
        return interaction;
      },
      storeMessage: (
        chatJid: string,
        _content: string,
        _isBot: boolean,
        _mediaIds: number[],
        opts?: { threadId?: number; isTerminalAgentReply?: boolean }
      ) => {
        calls.push(
          `store:${chatJid}:thread=${opts?.threadId ?? "undefined"}:terminal=${opts?.isTerminalAgentReply ? 1 : 0}`
        );
        return { id: 100, timestamp: "t", data: {} };
      },
    } as unknown as WebChannel,
  };
}

function createMockEmitter() {
  const calls: string[] = [];
  return {
    calls,
    emitter: {
      response: (interaction: unknown) => calls.push(`response:${(interaction as any).id}`),
    } as unknown as AgentEventEmitter,
  };
}

describe("storeAgentTurn", () => {
  test("consumes placeholder when skipPlaceholder is false (default)", () => {
    const { channel, calls } = createMockChannel([50]);
    const { emitter } = createMockEmitter();

    storeAgentTurn(channel, emitter, {
      chatJid: "web:default",
      text: "follow-up response",
      attachments: [],
      channelName: "web",
      threadId: 1,
    });

    expect(calls).toEqual([
      "consume:web:default:50",
      "replace:web:default:50:thread=undefined:terminal=0",
    ]);
  });

  test("does NOT consume placeholder when skipPlaceholder is true", () => {
    const { channel, calls } = createMockChannel([50]);
    const { emitter, calls: emitterCalls } = createMockEmitter();

    storeAgentTurn(channel, emitter, {
      chatJid: "web:default",
      text: "original turn response",
      attachments: [],
      channelName: "web",
      threadId: 1,
      skipPlaceholder: true,
    });

    // Should NOT touch the placeholder at all — stored as a new message instead
    expect(calls).toEqual(["store:web:default:thread=1:terminal=0"]);
    expect(emitterCalls).toEqual(["response:100"]);
  });

  test("placeholder thread_id is NOT overridden (preserves /queue thread)", () => {
    const { channel, calls } = createMockChannel([50]);
    const { emitter } = createMockEmitter();

    storeAgentTurn(channel, emitter, {
      chatJid: "web:default",
      text: "response",
      attachments: [],
      channelName: "web",
      threadId: 999, // processChat's resolvedThreadRootId — should NOT be used
    });

    // The replace call should pass threadId=undefined, preserving the placeholder's original thread
    expect(calls).toEqual([
      "consume:web:default:50",
      "replace:web:default:50:thread=undefined:terminal=0",
    ]);
  });

  test("intermediate then final turn: placeholder consumed only by final", () => {
    const { channel, calls } = createMockChannel([50]);
    const { emitter, calls: emitterCalls } = createMockEmitter();

    // Intermediate turn (original response) — skipPlaceholder: true
    storeAgentTurn(channel, emitter, {
      chatJid: "web:default",
      text: "original response",
      attachments: [],
      channelName: "web",
      threadId: 1,
      skipPlaceholder: true,
    });

    // Final turn (follow-up response) — skipPlaceholder: false (default)
    storeAgentTurn(channel, emitter, {
      chatJid: "web:default",
      text: "follow-up response",
      attachments: [],
      channelName: "web",
      threadId: 1,
    });

    expect(calls).toEqual([
      // Intermediate: stored as new message, no placeholder touched
      "store:web:default:thread=1:terminal=0",
      // Final: consumed placeholder, replaced with undefined thread (preserving original)
      "consume:web:default:50",
      "replace:web:default:50:thread=undefined:terminal=0",
    ]);
    expect(emitterCalls).toEqual(["response:100"]);
  });

  test("stores as new message when no placeholder is queued", () => {
    const { channel, calls } = createMockChannel([]);
    const { emitter, calls: emitterCalls } = createMockEmitter();

    storeAgentTurn(channel, emitter, {
      chatJid: "web:default",
      text: "normal response",
      attachments: [],
      channelName: "web",
      threadId: 5,
    });

    expect(calls).toEqual(["store:web:default:thread=5:terminal=0"]);
    expect(emitterCalls).toEqual(["response:100"]);
  });

  test("commits a durable terminal after persistence and before response broadcast", () => {
    const order: string[] = [];
    const interaction = { id: 100, timestamp: "t", data: {} as Record<string, unknown> };
    const channel = {
      consumeQueuedFollowupPlaceholder: () => null,
      storeMessage: (_chatJid: string, _content: string, _isBot: boolean, _mediaIds: number[], options: { isTerminalAgentReply?: boolean }) => {
        order.push(`persist:terminal=${options.isTerminalAgentReply ? 1 : 0}`);
        return interaction;
      },
    } as unknown as WebChannel;
    const emitter = {
      response: () => order.push("broadcast"),
    } as unknown as AgentEventEmitter;

    const rowId = storeAgentTurn(channel, emitter, {
      chatJid: "web:default",
      text: "final response",
      attachments: [],
      channelName: "web",
      threadId: 5,
      isTerminalAgentReply: true,
      commitTerminal: (persistedRowId) => {
        order.push(`complete:${persistedRowId}`);
        return true;
      },
    });

    expect(rowId).toBe(100);
    expect(order).toEqual(["persist:terminal=0", "complete:100", "broadcast"]);
    expect(interaction.data.is_terminal_agent_reply).toBe(true);
  });

  test("does not let an auxiliary stored callback prevent durable completion or broadcast", () => {
    const order: string[] = [];
    const channel = {
      consumeQueuedFollowupPlaceholder: () => null,
      storeMessage: () => {
        order.push("persist");
        return { id: 100, timestamp: "t", data: {} };
      },
    } as unknown as WebChannel;
    const emitter = {
      response: () => order.push("broadcast"),
    } as unknown as AgentEventEmitter;

    expect(storeAgentTurn(channel, emitter, {
      chatJid: "web:default",
      text: "final response",
      attachments: [],
      channelName: "web",
      threadId: 5,
      isTerminalAgentReply: true,
      onMessageStored: () => {
        order.push("auxiliary");
        throw new Error("auxiliary write failed");
      },
      commitTerminal: () => {
        order.push("complete");
        return true;
      },
    })).toBe(100);

    expect(order).toEqual(["persist", "auxiliary", "complete", "broadcast"]);
  });

  test("suppresses response broadcast when durable terminal completion is rejected", () => {
    const order: string[] = [];
    const channel = {
      consumeQueuedFollowupPlaceholder: () => null,
      storeMessage: () => {
        order.push("persist");
        return { id: 100, timestamp: "t", data: {} };
      },
    } as unknown as WebChannel;
    const emitter = {
      response: () => order.push("broadcast"),
    } as unknown as AgentEventEmitter;

    const rowId = storeAgentTurn(channel, emitter, {
      chatJid: "web:default",
      text: "final response",
      attachments: [],
      channelName: "web",
      threadId: 5,
      isTerminalAgentReply: true,
      commitTerminal: () => {
        order.push("complete-rejected");
        return false;
      },
    });

    expect(rowId).toBeNull();
    expect(order).toEqual(["persist", "complete-rejected"]);
  });

  test("completes a durable placeholder before its update while preserving thread association", () => {
    const { channel, calls } = createMockChannel([50]);
    const { emitter } = createMockEmitter();

    const rowId = storeAgentTurn(channel, emitter, {
      chatJid: "web:default",
      text: "follow-up response",
      attachments: [],
      channelName: "web",
      threadId: 999,
      isTerminalAgentReply: true,
      commitTerminal: (persistedRowId) => {
        calls.push(`complete:${persistedRowId}`);
        return true;
      },
    });

    expect(rowId).toBe(50);
    expect(calls).toEqual([
      "consume:web:default:50",
      "replace:web:default:50:thread=undefined:terminal=0",
      "complete:50",
    ]);
  });

  test("marks terminal assistant replies when requested", () => {
    const { channel, calls } = createMockChannel([]);
    const { emitter } = createMockEmitter();

    storeAgentTurn(channel, emitter, {
      chatJid: "web:default",
      text: "final response",
      attachments: [],
      channelName: "web",
      threadId: 5,
      isTerminalAgentReply: true,
    });

    expect(calls).toEqual(["store:web:default:thread=5:terminal=1"]);
  });
});
