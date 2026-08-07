import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { waitFor } from "../helpers.js";
import {
  endChatRun,
  extensionKvClear,
  getAllChatCursors,
  getChatCursor,
  getChatPreflight,
  getDb,
  getDeferredQueuedFollowups,
  getMessagesSince,
  getPreflightRuns,
  initDatabase,
  storeMessage as storeDbMessage,
} from "../../src/db.js";
import { runProcessChatPreflight } from "../../src/channels/web/runtime/process-chat-preflight-runtime.js";
import { resumePendingChats, type WebRecoveryContext } from "../../src/channels/web/runtime/recovery.js";
import { AgentQueue } from "../../src/queue.js";
import { runWebStartupRecoveryBootstrap } from "../../src/runtime/startup.js";
import { storeWebMessage } from "../../src/channels/web/messaging/message-store.js";
import {
  EXIT_PROCESS_HANDOFF_EXTENSION_ID,
  RESTART_CONTINUATION_SCREEN_HINT,
  listRestartHandoffs,
  markRestartHandoffReady,
  prepareRestartHandoff,
  recoverPendingRestartHandoffs,
  type RestartHandoffRecoveryWebChannel,
} from "../../src/runtime/restart-handoff.js";

interface RecoveryEvent {
  kind: "store" | "broadcast" | "resume";
  chatJid?: string;
  content?: string;
  isBot?: boolean;
  eventType?: string;
  rowId?: number;
}

function createRecoveryWeb(
  events: RecoveryEvent[],
  options: { failStorePhase?: "completion" | "resume"; throwOnResume?: boolean } = {},
): RestartHandoffRecoveryWebChannel {
  const linkPreviewChannel = {
    pendingLinkPreviews: new Set<number>(),
    broadcastEvent: () => {},
  };

  return {
    storeMessage(chatJid, content, isBot, mediaIds, storeOptions = {}) {
      const phase = isBot ? "completion" : "resume";
      events.push({ kind: "store", chatJid, content, isBot });
      if (options.failStorePhase === phase) return null;
      return storeWebMessage(
        linkPreviewChannel,
        {
          chatJid,
          content,
          isBot,
          mediaIds,
          agentId: "default",
          agentName: "PiClaw",
          userName: "You",
        },
        storeOptions,
      );
    },
    broadcastEvent(eventType, data) {
      events.push({
        kind: "broadcast",
        eventType,
        rowId: typeof (data as { id?: unknown })?.id === "number"
          ? (data as { id: number }).id
          : undefined,
      });
    },
    resumeChat(chatJid, rowId) {
      events.push({ kind: "resume", chatJid, rowId: rowId ?? undefined });
      if (options.throwOnResume) throw new Error("simulated queue interruption");
    },
  };
}

function createReadyHandoff(input: {
  chatJid: string;
  reason: string;
  resumeMessage?: string | null;
}) {
  const preparing = prepareRestartHandoff(input);
  return markRestartHandoffReady(preparing, Math.floor(Math.random() * 100_000) + 1);
}

function getChatMessages(chatJid: string): Array<{
  rowid: number;
  content: string;
  content_blocks: string | null;
  screen_hint: string | null;
  is_bot_message: number;
}> {
  return getDb().prepare(`
    SELECT rowid, content, content_blocks, screen_hint, is_bot_message
    FROM messages
    WHERE chat_jid = ?
    ORDER BY timestamp ASC, rowid ASC
  `).all(chatJid) as ReturnType<typeof getChatMessages>;
}

describe("restart handoff recovery", () => {
  beforeAll(() => {
    initDatabase();
  });

  afterEach(() => {
    extensionKvClear(EXIT_PROCESS_HANDOFF_EXTENSION_ID);
  });

  test("posts the visible completion before a labelled inbound continuation and starts one turn", () => {
    const chatJid = `web:restart-resume-${crypto.randomUUID()}`;
    const handoff = createReadyHandoff({
      chatJid,
      reason: "Load the phase 2 build.",
      resumeMessage: "Continue the most recent task after recovery.",
    });
    const events: RecoveryEvent[] = [];

    const summary = recoverPendingRestartHandoffs(createRecoveryWeb(events));

    expect(summary).toEqual({
      discovered: 1,
      recovered: 1,
      discarded: 0,
      failed: 0,
      completionMessagesCreated: 1,
      resumeMessagesCreated: 1,
      turnsResumed: 1,
    });
    expect(events.map((event) => `${event.kind}:${event.eventType || (event.isBot ? "agent" : "inbound")}`)).toEqual([
      "store:agent",
      "broadcast:agent_response",
      "store:inbound",
      "broadcast:new_post",
      "resume:inbound",
    ]);

    const messages = getChatMessages(chatJid);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      content: "Restart completed.",
      is_bot_message: 1,
    });
    expect(messages[1]).toMatchObject({
      content: "Continue the most recent task after recovery.",
      screen_hint: RESTART_CONTINUATION_SCREEN_HINT,
      is_bot_message: 0,
    });

    const completionBlocks = JSON.parse(messages[0].content_blocks || "[]");
    const resumeBlocks = JSON.parse(messages[1].content_blocks || "[]");
    expect(completionBlocks).toContainEqual(expect.objectContaining({
      type: "restart_handoff",
      source: "exit_process",
      restart_id: handoff.restartId,
      phase: "completion",
    }));
    expect(resumeBlocks).toContainEqual({
      type: "self_continuation",
      source: "exit_process",
      restart_id: handoff.restartId,
    });
    expect(listRestartHandoffs()).toEqual([]);

    const repeated = recoverPendingRestartHandoffs(createRecoveryWeb(events));
    expect(repeated.discovered).toBe(0);
    expect(getChatMessages(chatJid)).toHaveLength(2);
  });

  test("can materialize startup continuation without independently queuing the turn", () => {
    const chatJid = `web:restart-scan-owned-${crypto.randomUUID()}`;
    createReadyHandoff({
      chatJid,
      reason: "Let startup pending scan own resume.",
      resumeMessage: "Resume through the startup scan.",
    });
    const events: RecoveryEvent[] = [];

    const summary = recoverPendingRestartHandoffs(createRecoveryWeb(events), { resumeTurns: false });

    expect(summary).toMatchObject({
      recovered: 1,
      resumeMessagesCreated: 1,
      turnsResumed: 0,
    });
    expect(events.some((event) => event.kind === "resume")).toBe(false);
    expect(getChatMessages(chatJid).map((message) => message.content)).toContain("Resume through the startup scan.");
  });

  test("recovers multiple handoffs for one chat with distinct targeted turns", () => {
    const chatJid = `web:restart-multiple-${crypto.randomUUID()}`;
    createReadyHandoff({ chatJid, reason: "First restart.", resumeMessage: "Resume first task." });
    createReadyHandoff({ chatJid, reason: "Second restart.", resumeMessage: "Resume second task." });
    const events: RecoveryEvent[] = [];

    const summary = recoverPendingRestartHandoffs(createRecoveryWeb(events));

    expect(summary).toMatchObject({
      discovered: 2,
      recovered: 2,
      failed: 0,
      completionMessagesCreated: 2,
      resumeMessagesCreated: 2,
      turnsResumed: 2,
    });
    const resumeEvents = events.filter((event) => event.kind === "resume");
    expect(resumeEvents).toHaveLength(2);
    expect(new Set(resumeEvents.map((event) => event.rowId)).size).toBe(2);
    const content = getChatMessages(chatJid).map((message) => message.content);
    expect(content.filter((value) => value === "Restart completed.")).toHaveLength(2);
    expect(content).toContain("Resume first task.");
    expect(content).toContain("Resume second task.");
    expect(listRestartHandoffs()).toEqual([]);
  });

  test("startup handoff and pending scan share one owner through deferred compaction", async () => {
    const chatJid = `web:restart-owned-${crypto.randomUUID()}`;
    const otherChatJid = `web:restart-unrelated-${crypto.randomUUID()}`;
    createReadyHandoff({
      chatJid,
      reason: "Exercise startup ownership.",
      resumeMessage: "Resume exactly once after deferred compaction.",
    });
    const recoveryEvents: RecoveryEvent[] = [];
    const recoveryWeb = createRecoveryWeb(recoveryEvents);
    recoveryWeb.storeMessage(otherChatJid, "Unrelated pending work.", false, []);

    const queue = new AgentQueue();
    let releaseCompaction!: () => void;
    const compactionGate = new Promise<void>((resolve) => { releaseCompaction = resolve; });
    let targetCompacted = false;
    let physicalCompactions = 0;
    const prompted: string[] = [];
    const processCalls: string[] = [];
    const preflightChannel = {
      agentPool: {
        getSessionForIntrospection: async () => ({}),
        emergencyRotateSession: async () => ({ status: "success", message: "rotated" }),
      },
    } as any;

    const processChat = async (jid: string): Promise<void> => {
      processCalls.push(jid);
      if (getChatPreflight(jid)) return;
      const prevCursor = getChatCursor(jid);
      const [message] = getMessagesSince(jid, prevCursor, "PiClaw");
      if (!message) return;
      const startedAt = new Date(Date.now() + processCalls.length).toISOString();
      const result = await runProcessChatPreflight({
        channel: preflightChannel,
        chatJid: jid,
        agentId: "default",
        message: { id: message.id, timestamp: message.timestamp },
        prevCursor,
        effectiveThreadRootId: null,
        turnId: `turn-${processCalls.length}`,
        runStartedAt: startedAt,
        streamingHandler() {},
        compactionState: { lastCompactionErrorMessage: null, lastCompactionSuppressed: false },
        enqueueResume: () => {
          queue.enqueue(() => processChat(jid), `compaction-resume:${jid}:${message.id}`, `chat:${jid}`);
        },
        deps: {
          getForegroundMs: () => 0,
          maybeAutoCompactSessionBeforePrompt: async () => {
            if (jid !== chatJid || targetCompacted) return;
            physicalCompactions += 1;
            await compactionGate;
            targetCompacted = true;
          },
        } as any,
      });
      if (result === "deferred") return;
      prompted.push(`${jid}:${message.id}`);
      endChatRun(jid);
      const [next] = getMessagesSince(jid, getChatCursor(jid), "PiClaw");
      if (next) {
        queue.enqueue(() => processChat(jid), `drain:${jid}:${next.id}`, `chat:${jid}`);
      }
    };

    const allowed = new Set([chatJid, otherChatJid]);
    const recoveryStore = {
      getPreflightRuns: () => getPreflightRuns().filter((entry) => allowed.has(entry.chatJid)),
      getAllChatCursors: () => Object.fromEntries(Object.entries(getAllChatCursors()).filter(([jid]) => allowed.has(jid))),
      getKnownChatJids: () => [...allowed],
      getDeferredQueuedFollowups,
      getMessagesSince,
    } as any;
    const ctx: WebRecoveryContext = {
      assistantName: "PiClaw",
      defaultAgentId: "default",
      enqueue: (task, key, laneKey) => queue.enqueue(task, key, laneKey),
      processChat: async (jid) => processChat(jid),
    };
    const startupWeb = {
      updateAgentStatus: () => {},
      recoverInflightRuns: () => {},
      resumePendingChats: () => resumePendingChats(ctx, undefined, recoveryStore),
    };
    const scheduled: Array<() => void> = [];

    let resumeMessageId = "";
    let laterMessageId = "";
    runWebStartupRecoveryBootstrap(startupWeb, () => {
      recoverPendingRestartHandoffs(recoveryWeb, { resumeTurns: false });
      const resumeRow = getDb().prepare(`
        SELECT id, timestamp FROM messages
        WHERE chat_jid = ? AND is_bot_message = 0
        ORDER BY timestamp DESC, rowid DESC LIMIT 1
      `).get(chatJid) as { id: string; timestamp: string };
      resumeMessageId = resumeRow.id;
      laterMessageId = `later-${crypto.randomUUID()}`;
      storeDbMessage({
        id: laterMessageId,
        chat_jid: chatJid,
        sender: "web-user",
        sender_name: "You",
        content: "Later FIFO work.",
        timestamp: new Date(Date.parse(resumeRow.timestamp) + 1_000).toISOString(),
        is_from_me: false,
        is_bot_message: false,
      });
    }, (resume) => { scheduled.push(resume); });
    expect(recoveryEvents.some((event) => event.kind === "resume")).toBe(false);
    expect(scheduled).toHaveLength(1);

    scheduled[0]();
    await waitFor(() => getChatPreflight(chatJid) !== null, 500, 1);
    startupWeb.resumePendingChats();
    await waitFor(() => prompted.some((entry) => entry.startsWith(`${otherChatJid}:`)), 500, 1);
    expect(prompted.filter((entry) => entry.startsWith(`${chatJid}:`))).toHaveLength(0);
    expect(physicalCompactions).toBe(1);

    releaseCompaction();
    await waitFor(() => prompted.filter((entry) => entry.startsWith(`${chatJid}:`)).length === 2, 500, 1);
    expect(prompted.filter((entry) => entry.startsWith(`${chatJid}:`))).toEqual([
      `${chatJid}:${resumeMessageId}`,
      `${chatJid}:${laterMessageId}`,
    ]);
    expect(physicalCompactions).toBe(1);
    expect(queue.getMetrics().retriesScheduled).toBe(0);
    await queue.shutdown(100);
  });

  test("posts only the completion message when no continuation was requested", () => {
    const chatJid = `web:restart-no-resume-${crypto.randomUUID()}`;
    createReadyHandoff({
      chatJid,
      reason: "Restart without follow-up.",
    });
    const events: RecoveryEvent[] = [];

    const summary = recoverPendingRestartHandoffs(createRecoveryWeb(events));

    expect(summary.recovered).toBe(1);
    expect(summary.completionMessagesCreated).toBe(1);
    expect(summary.resumeMessagesCreated).toBe(0);
    expect(summary.turnsResumed).toBe(0);
    expect(events.map((event) => event.kind)).toEqual(["store", "broadcast"]);
    expect(getChatMessages(chatJid).map((message) => message.content)).toEqual([
      "Restart completed.",
    ]);
    expect(listRestartHandoffs()).toEqual([]);
  });

  test("retries an interrupted recovery without duplicating either timeline message", () => {
    const chatJid = `web:restart-interrupted-${crypto.randomUUID()}`;
    createReadyHandoff({
      chatJid,
      reason: "Exercise duplicate protection.",
      resumeMessage: "Resume exactly once.",
    });
    const interruptedEvents: RecoveryEvent[] = [];

    const interrupted = recoverPendingRestartHandoffs(createRecoveryWeb(interruptedEvents, {
      throwOnResume: true,
    }));

    expect(interrupted.failed).toBe(1);
    expect(interrupted.recovered).toBe(0);
    expect(getChatMessages(chatJid)).toHaveLength(2);
    expect(listRestartHandoffs()).toEqual([
      expect.objectContaining({ state: "resume_posted" }),
    ]);

    const retryEvents: RecoveryEvent[] = [];
    const retried = recoverPendingRestartHandoffs(createRecoveryWeb(retryEvents));

    expect(retried).toMatchObject({
      discovered: 1,
      recovered: 1,
      failed: 0,
      completionMessagesCreated: 0,
      resumeMessagesCreated: 0,
      turnsResumed: 1,
    });
    expect(retryEvents).toEqual([
      expect.objectContaining({ kind: "resume", chatJid }),
    ]);
    expect(getChatMessages(chatJid)).toHaveLength(2);
    expect(listRestartHandoffs()).toEqual([]);
  });

  test("leaves a ready handoff recoverable when startup message persistence fails", () => {
    const chatJid = `web:restart-store-failure-${crypto.randomUUID()}`;
    createReadyHandoff({
      chatJid,
      reason: "Retry after startup storage failure.",
      resumeMessage: "Continue after retry.",
    });

    const failed = recoverPendingRestartHandoffs(createRecoveryWeb([], {
      failStorePhase: "completion",
    }));

    expect(failed.failed).toBe(1);
    expect(failed.recovered).toBe(0);
    expect(getChatMessages(chatJid)).toEqual([]);
    expect(listRestartHandoffs()).toEqual([
      expect.objectContaining({ state: "ready", chatJid }),
    ]);

    const recovered = recoverPendingRestartHandoffs(createRecoveryWeb([]));
    expect(recovered.recovered).toBe(1);
    expect(getChatMessages(chatJid)).toHaveLength(2);
    expect(listRestartHandoffs()).toEqual([]);
  });

  test("discards an incomplete preparing handoff without posting anything", () => {
    const chatJid = `web:restart-preparing-${crypto.randomUUID()}`;
    prepareRestartHandoff({
      chatJid,
      reason: "The pre-shutdown notice never completed.",
      resumeMessage: "Do not run this.",
    });
    const events: RecoveryEvent[] = [];

    const summary = recoverPendingRestartHandoffs(createRecoveryWeb(events));

    expect(summary).toMatchObject({
      discovered: 1,
      recovered: 0,
      discarded: 1,
      failed: 0,
      turnsResumed: 0,
    });
    expect(events).toEqual([]);
    expect(getChatMessages(chatJid)).toEqual([]);
    expect(listRestartHandoffs()).toEqual([]);
  });
});
