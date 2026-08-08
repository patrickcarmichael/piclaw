import { beforeEach, describe, expect, test } from "bun:test";
import { storeAgentTurn } from "../../../../src/channels/web/messaging/agent-message-store.js";
import type { WebChannel } from "../../../../src/channels/web.js";
import type { AgentEventEmitter } from "../../../../src/channels/web/sse/agent-events.js";
import {
  claimNextChatOperation,
  completeChatOperation,
  deleteChatOperationLifecycleState,
  getChatCursor,
  getChatOperation,
  getChatOperationDisposition,
  getDb,
  getMessageByRowId,
  initDatabase,
  promoteChatOperation,
  storeAcceptedChatMessageSource,
  storeMessage as storeDbMessage,
} from "../../../../src/db.js";

/** Minimal mock of WebChannel that tracks placeholder and store calls. */
function createMockChannel(placeholderIds: number[] = []) {
  const calls: string[] = [];
  const queue = [...placeholderIds];
  return {
    calls,
    channel: {
      peekQueuedFollowupPlaceholder: () => queue[0] ?? null,
      consumeQueuedFollowupPlaceholder: (chatJid: string, expectedRowId?: number) => {
        if (expectedRowId !== undefined && queue[0] !== expectedRowId) return null;
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
        deferBroadcast?: boolean,
      ) => {
        calls.push(
          `replace:${chatJid}:${rowId}:thread=${threadId ?? "undefined"}:terminal=${isTerminalAgentReply ? 1 : 0}`
        );
        const interaction = { id: rowId, timestamp: "t", data: {} };
        beforeBroadcast?.(interaction);
        void deferBroadcast;
        return interaction;
      },
      broadcastQueuedFollowupPlaceholderUpdate: (interaction: { id: number }) => {
        calls.push(`updated:${interaction.id}`);
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
  beforeEach(() => {
    process.env.PICLAW_DB_IN_MEMORY = "1";
    initDatabase();
  });
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
      peekQueuedFollowupPlaceholder: () => null,
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
      peekQueuedFollowupPlaceholder: () => null,
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
      peekQueuedFollowupPlaceholder: () => null,
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
      "replace:web:default:50:thread=undefined:terminal=0",
      "complete:50",
      "consume:web:default:50",
      "updated:50",
    ]);
  });

  test("atomically binds durable intermediate rows and rolls back stale-owner inserts", () => {
    const chatJid = `web:intermediate-binding-${crypto.randomUUID()}`;
    storeAcceptedChatMessageSource({
      id: `source-${crypto.randomUUID()}`,
      chat_jid: chatJid,
      sender: "user",
      sender_name: "User",
      content: "prompt",
      timestamp: "2026-01-01T00:00:01.000Z",
    });
    const claim = claimNextChatOperation(chatJid);
    if (claim.status !== "claimed") throw new Error("expected claim");
    const preflight = promoteChatOperation(chatJid, {
      operationId: claim.operation.operationId,
      sourceSeq: claim.operation.sourceSeq,
      phase: claim.operation.phase,
      generation: claim.operation.generation,
    }, "preflight");
    if (preflight.status !== "applied") throw new Error("expected preflight");
    const running = promoteChatOperation(chatJid, {
      operationId: preflight.operation.operationId,
      sourceSeq: preflight.operation.sourceSeq,
      phase: preflight.operation.phase,
      generation: preflight.operation.generation,
    }, "running");
    if (running.status !== "applied") throw new Error("expected running");
    const exactOwner = {
      operationId: running.operation.operationId,
      sourceSeq: running.operation.sourceSeq,
      phase: running.operation.phase,
      generation: running.operation.generation,
    } as const;
    const channel = {
      peekQueuedFollowupPlaceholder: () => null,
      consumeQueuedFollowupPlaceholder: () => null,
      storeMessage: (targetChatJid: string, content: string) => {
        const rowId = storeDbMessage({
          id: `intermediate-${crypto.randomUUID()}`,
          chat_jid: targetChatJid,
          sender: "agent",
          sender_name: "Agent",
          content,
          timestamp: new Date().toISOString(),
          is_bot_message: true,
        });
        return getMessageByRowId(targetChatJid, rowId)!;
      },
    } as unknown as WebChannel;
    const emitter = { response: () => {} } as unknown as AgentEventEmitter;

    const rowId = storeAgentTurn(channel, emitter, {
      chatJid,
      text: "owned intermediate",
      attachments: [],
      channelName: "web",
      threadId: null,
      operationOwner: exactOwner,
    });
    expect(rowId).toBeNumber();
    expect(getDb().prepare("SELECT operation_id, is_terminal_agent_reply FROM messages WHERE rowid = ?")
      .get(rowId!)).toEqual({ operation_id: exactOwner.operationId, is_terminal_agent_reply: 0 });

    expect(storeAgentTurn(channel, emitter, {
      chatJid,
      text: "stale intermediate",
      attachments: [],
      channelName: "web",
      threadId: null,
      operationOwner: { ...exactOwner, generation: exactOwner.generation - 1 },
    })).toBeNull();
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM messages WHERE chat_jid = ? AND is_bot_message = 1")
      .get(chatJid)).toEqual({ count: 1 });

    const placeholderRowId = storeDbMessage({
      id: `placeholder-${crypto.randomUUID()}`,
      chat_jid: chatJid,
      sender: "agent",
      sender_name: "Agent",
      content: "Queued placeholder",
      timestamp: new Date().toISOString(),
      is_bot_message: true,
    });
    const placeholderQueue = [placeholderRowId];
    const placeholderChannel = {
      peekQueuedFollowupPlaceholder: () => placeholderQueue[0] ?? null,
      consumeQueuedFollowupPlaceholder: (_jid: string, expectedRowId?: number) => {
        if (expectedRowId !== undefined && placeholderQueue[0] !== expectedRowId) return null;
        return placeholderQueue.shift() ?? null;
      },
      replaceQueuedFollowupPlaceholder: (targetChatJid: string, targetRowId: number, text: string) => {
        getDb().prepare("UPDATE messages SET content = ? WHERE chat_jid = ? AND rowid = ?")
          .run(text, targetChatJid, targetRowId);
        return getMessageByRowId(targetChatJid, targetRowId) ?? null;
      },
      broadcastQueuedFollowupPlaceholderUpdate: () => {},
    } as unknown as WebChannel;

    expect(storeAgentTurn(placeholderChannel, emitter, {
      chatJid,
      text: "stale placeholder replacement",
      attachments: [],
      channelName: "web",
      threadId: null,
      operationOwner: { ...exactOwner, generation: exactOwner.generation - 1 },
    })).toBeNull();
    expect(placeholderQueue).toEqual([placeholderRowId]);
    expect(getDb().prepare("SELECT content, operation_id FROM messages WHERE chat_jid = ? AND rowid = ?")
      .get(chatJid, placeholderRowId)).toEqual({ content: "Queued placeholder", operation_id: null });

    expect(storeAgentTurn(placeholderChannel, emitter, {
      chatJid,
      text: "stale terminal replacement",
      attachments: [],
      channelName: "web",
      threadId: null,
      isTerminalAgentReply: true,
      commitTerminal: (rowId) => {
        const message = getDb().prepare("SELECT id FROM messages WHERE chat_jid = ? AND rowid = ?")
          .get(chatJid, rowId) as { id: string };
        const completed = completeChatOperation(chatJid, {
          owner: { ...exactOwner, generation: exactOwner.generation - 1 },
          outcome: "succeeded",
          cause: "stale_terminal_test",
          provenance: "test",
          createdAt: new Date().toISOString(),
          artifact: { messageId: message.id },
        });
        return completed.status === "completed" || completed.status === "repeated";
      },
    })).toBeNull();
    expect(placeholderQueue).toEqual([placeholderRowId]);
    expect(getDb().prepare("SELECT content, operation_id, is_terminal_agent_reply FROM messages WHERE chat_jid = ? AND rowid = ?")
      .get(chatJid, placeholderRowId)).toEqual({
      content: "Queued placeholder",
      operation_id: null,
      is_terminal_agent_reply: 0,
    });
    expect(getChatOperation(chatJid)).toEqual(running.operation);
  });

  test("rolls back terminal rows with disposition, cursor, and release on completion faults", () => {
    for (const faultPoint of ["artifact", "disposition"] as const) {
      const chatJid = `web:terminal-fault-${faultPoint}`;
      const accepted = storeAcceptedChatMessageSource({
        id: `source-${faultPoint}`,
        chat_jid: chatJid,
        sender: "user",
        sender_name: "User",
        content: "prompt",
        timestamp: "2026-01-01T00:00:01.000Z",
      });
      const claim = claimNextChatOperation(chatJid);
      if (claim.status !== "claimed") throw new Error("expected claim");
      const preflight = promoteChatOperation(chatJid, {
        operationId: claim.operation.operationId,
        sourceSeq: claim.operation.sourceSeq,
        phase: claim.operation.phase,
        generation: claim.operation.generation,
      }, "preflight");
      if (preflight.status !== "applied") throw new Error("expected preflight");
      const running = promoteChatOperation(chatJid, {
        operationId: preflight.operation.operationId,
        sourceSeq: preflight.operation.sourceSeq,
        phase: preflight.operation.phase,
        generation: preflight.operation.generation,
      }, "running");
      if (running.status !== "applied") throw new Error("expected running");

      const channel = {
        peekQueuedFollowupPlaceholder: () => null,
        consumeQueuedFollowupPlaceholder: () => null,
        storeMessage: (targetChatJid: string, content: string) => {
          const messageId = `terminal-${faultPoint}`;
          const rowId = storeDbMessage({
            id: messageId,
            chat_jid: targetChatJid,
            sender: "agent",
            sender_name: "Agent",
            content,
            timestamp: "2026-01-01T00:00:02.000Z",
            is_bot_message: true,
          });
          return getMessageByRowId(targetChatJid, rowId)!;
        },
      } as unknown as WebChannel;
      const emitter = { response: () => { throw new Error("must not broadcast"); } } as unknown as AgentEventEmitter;

      expect(() => storeAgentTurn(channel, emitter, {
        chatJid,
        text: "terminal",
        attachments: [],
        channelName: "web",
        threadId: null,
        isTerminalAgentReply: true,
        commitTerminal: (rowId) => {
          const row = getDb().prepare("SELECT id FROM messages WHERE chat_jid = ? AND rowid = ?")
            .get(chatJid, rowId) as { id: string };
          completeChatOperation(chatJid, {
            owner: {
              operationId: running.operation.operationId,
              sourceSeq: running.operation.sourceSeq,
              phase: running.operation.phase,
              generation: running.operation.generation,
            },
            outcome: "succeeded",
            cause: "test",
            provenance: "test",
            createdAt: "2026-01-01T00:00:03.000Z",
            artifact: { messageId: row.id },
          }, {
            afterWrite: (point) => {
              if (point === faultPoint) throw new Error(`fault-after-${faultPoint}`);
            },
          });
          return true;
        },
      })).toThrow(`fault-after-${faultPoint}`);

      expect(getDb().prepare("SELECT COUNT(*) AS count FROM messages WHERE chat_jid = ? AND is_bot_message = 1")
        .get(chatJid)).toEqual({ count: 0 });
      expect(getChatOperationDisposition(accepted.source.sourceSeq)).toBeNull();
      expect(getChatCursor(chatJid)).toBe("");
      expect(getChatOperation(chatJid)).toEqual(running.operation);

      deleteChatOperationLifecycleState(chatJid);
      getDb().prepare("DELETE FROM messages WHERE chat_jid = ?").run(chatJid);
      getDb().prepare("DELETE FROM chat_cursors WHERE chat_jid = ?").run(chatJid);
    }
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
