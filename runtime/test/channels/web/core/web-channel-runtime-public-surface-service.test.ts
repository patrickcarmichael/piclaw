import { describe, expect, test } from "bun:test";

import type { InteractionRow } from "../../../../src/db.js";
import {
  createWebChannelRuntimePublicSurfaceService,
  getWebChannelRuntimePublicSurfaceService,
} from "../../../../src/channels/web/core/web-channel-runtime-public-surface-service.js";
import { getTrustedAgentMessageProvenance } from "../../../../src/channels/web/messaging/agent-message-provenance.js";

function interaction(id: number): InteractionRow {
  return {
    id,
    chat_jid: "web:test",
    timestamp: "2026-03-28T00:00:00.000Z",
    data: { type: "agent_response", content: `row-${id}` },
  };
}

describe("web channel runtime public surface service", () => {
  test("does not trust a lookalike in-process provenance object", () => {
    expect(getTrustedAgentMessageProvenance({ source: "goal.continuation", durable: true })).toBeNull();
  });

  test("stores only plain text extension working-indicator frames", () => {
    const service = createWebChannelRuntimePublicSurfaceService({
      runtimeFollowupFacade: {} as any,
      messageProcessingStorageService: {} as any,
      sessionBroadcast: {
        sse: {},
        uiBridge: {},
        broadcastEvent: () => undefined,
      } as any,
    });

    service.broadcastEvent("extension_ui_working_indicator", {
      chat_jid: "web:test",
      frames: ["<svg><circle /></svg>", "⠋", "<span>busy</span>", "·"],
      interval_ms: 80,
    });

    expect(service.getExtensionWorkingState("web:test")).toEqual({
      message: null,
      indicator: { mode: "custom", frames: ["⠋", "·"], intervalMs: 80 },
      visible: true,
    });
  });

  test("delegates targeted runtime agent messages to the web handler path when available", async () => {
    const calls: string[] = [];
    let body: Record<string, unknown> | null = null;
    let provenance: ReturnType<typeof getTrustedAgentMessageProvenance> = null;
    const service = createWebChannelRuntimePublicSurfaceService({
      handleAgentMessage: async (req, pathname, _onAccepted, context) => {
        const url = new URL(req.url);
        calls.push(`handler:${pathname}:${url.searchParams.get("chat_jid")}`);
        body = await req.json() as Record<string, unknown>;
        provenance = getTrustedAgentMessageProvenance(context);
        return Response.json({
          user_message: { id: 77, chat_jid: "web:goal", timestamp: "2026-03-28T00:00:00.000Z", data: { thread_id: 77 } },
          thread_id: 77,
        }, { status: 201 });
      },
      runtimeFollowupFacade: {} as any,
      messageProcessingStorageService: {} as any,
      sessionBroadcast: { sse: {}, uiBridge: {}, broadcastEvent: () => undefined } as any,
    });

    const result = await service.enqueueAgentMessage({
      chatJid: "web:goal",
      content: "🎯 Continue goal: Ship it",
      mediaIds: [3],
      contentBlocks: [{ type: "text", text: "inline" }],
      linkPreviews: [{ url: "https://example.invalid" }],
      threadId: 5,
      mode: "queue",
      source: "goal.continuation",
      queuedBy: { source: "goal", sourceMessageId: "goal-source-1" },
    });

    expect(result.status).toBe("ok");
    expect(result.chat_jid).toBe("web:goal");
    expect(result.row_id).toBe(77);
    expect(result.thread_id).toBe(77);
    expect(result.created).toBe(true);
    expect(calls).toEqual(["handler:/agent/default/message:web:goal"]);
    expect(provenance).toEqual({
      source: "goal.continuation",
      queuedBy: { source: "goal", sourceMessageId: "goal-source-1" },
    });
    expect(body).toEqual({
      content: "🎯 Continue goal: Ship it",
      mode: "queue",
      media_ids: [3],
      content_blocks: [{ type: "text", text: "inline" }],
      link_previews: [{ url: "https://example.invalid" }],
      thread_id: 5,
    });
  });

  test("keeps trusted durable acceptance in the legacy direct-storage fallback", async () => {
    const calls: string[] = [];
    const stored = interaction(9);
    stored.data.thread_id = 9;

    const service = createWebChannelRuntimePublicSurfaceService({
      agentPool: {
        isStreaming: (chatJid) => {
          calls.push(`streaming:${chatJid}`);
          return false;
        },
        isActive: (chatJid) => {
          calls.push(`active:${chatJid}`);
          return false;
        },
      },
      runtimeFollowupFacade: {
        getQueuedFollowupCount: (chatJid) => {
          calls.push(`count:${chatJid}`);
          return 0;
        },
        resumeChat: (chatJid, threadRootId) => {
          calls.push(`resume:${chatJid}:${threadRootId ?? "null"}`);
        },
      } as any,
      messageProcessingStorageService: {
        storeMessage: (chatJid, content, isBot, mediaIds, options) => {
          calls.push(`store:${chatJid}:${content}:${isBot ? 1 : 0}:${mediaIds.join(",")}:${options?.threadId ?? "undefined"}:${options?.screenHint ?? ""}:durable=${options?.acceptDurableSource === true ? 1 : 0}`);
          return stored;
        },
      } as any,
      sessionBroadcast: {
        sse: {},
        uiBridge: {},
        broadcastEvent: (eventType, data) => {
          calls.push(`broadcast:${eventType}:${(data as InteractionRow).id ?? ""}`);
        },
      } as any,
    });

    const result = await service.enqueueAgentMessage({
      chatJid: "web:goal",
      content: "🎯 Continue goal: Ship it",
      mediaIds: [3],
      threadId: null,
      screenHint: "goal",
      source: "goal.continuation",
    });

    expect(result.status).toBe("ok");
    expect(result.chat_jid).toBe("web:goal");
    expect(result.row_id).toBe(9);
    expect(result.thread_id).toBe(9);
    expect(result.created).toBe(true);
    expect(calls).toEqual([
      "streaming:web:goal",
      "active:web:goal",
      "count:web:goal",
      "store:web:goal:🎯 Continue goal: Ship it:0:3:undefined:goal:durable=1",
      "broadcast:new_post:9",
      "resume:web:goal:9",
    ]);
  });

  test("keeps trusted durable provenance in the legacy queued fallback", async () => {
    const calls: string[] = [];
    const service = createWebChannelRuntimePublicSurfaceService({
      agentPool: {
        isStreaming: (chatJid) => {
          calls.push(`streaming:${chatJid}`);
          return false;
        },
        isActive: (chatJid) => {
          calls.push(`active:${chatJid}`);
          return true;
        },
      },
      runtimeFollowupFacade: {
        getQueuedFollowupCount: (chatJid) => {
          calls.push(`count:${chatJid}`);
          return 0;
        },
        enqueueQueuedFollowupItem: (chatJid, rowId, queuedContent, threadId, queuedAt, extras) => {
          calls.push(`enqueue:${chatJid}:${rowId}:${queuedContent}:${threadId ?? "null"}:${typeof queuedAt}:${extras?.source ?? ""}:durable=${extras?.durable === true ? 1 : 0}`);
          return 44;
        },
      } as any,
      messageProcessingStorageService: {
        storeMessage: () => {
          calls.push("store-unexpected");
          return null;
        },
      } as any,
      sessionBroadcast: {
        sse: {},
        uiBridge: {},
        broadcastEvent: (eventType, data) => {
          calls.push(`broadcast:${eventType}:${(data as { row_id?: number }).row_id ?? ""}`);
        },
      } as any,
    });

    const result = await service.enqueueAgentMessage({
      chatJid: "web:goal",
      content: "Continue",
      mode: "auto",
      source: "goal.continuation",
    });

    expect(result).toEqual({
      status: "ok",
      chat_jid: "web:goal",
      row_id: 44,
      thread_id: null,
      queued: "followup",
      created: false,
    });
    expect(calls).toEqual([
      "streaming:web:goal",
      "active:web:goal",
      "count:web:goal",
      "enqueue:web:goal:0:Continue:null:string:goal.continuation:durable=1",
      "broadcast:agent_followup_queued:44",
    ]);
  });

  test("delegates runtime/session/storage surfaces to the extracted collaborators", async () => {
    const calls: string[] = [];
    const sse = { kind: "sse-hub" };
    const uiBridge = { kind: "ui-bridge" };
    const placeholder = interaction(1);
    const stored = interaction(2);
    const queuedItem = { rowId: 3, queuedContent: "queued", threadId: 4, queuedAt: "2026-03-28T00:00:00.000Z" };
    const buffer = { text: "draft", totalLines: 5 };
    const status = { type: "intent", title: "Thinking" };

    const service = createWebChannelRuntimePublicSurfaceService({
      runtimeFollowupFacade: {
        sendMessage: async (chatJid, text, options) => {
          calls.push(`send:${chatJid}:${text}:${options?.threadId ?? "null"}`);
        },
        postDashboardWidget: async (chatJid, options) => {
          calls.push(`widget:${chatJid}:${options?.threadId ?? "null"}:${options?.widgetId ?? ""}`);
        },
        queueFollowupPlaceholder: (chatJid, text, threadId, queuedContent) => {
          calls.push(`queue:${chatJid}:${text}:${threadId ?? "null"}:${queuedContent ?? ""}`);
          return placeholder;
        },
        enqueueQueuedFollowupItem: (chatJid, rowId, queuedContent, threadId, queuedAt) => {
          calls.push(`enqueue:${chatJid}:${rowId}:${queuedContent}:${threadId ?? "null"}:${queuedAt ?? ""}`);
          return 41;
        },
        peekQueuedFollowupItem: (chatJid) => {
          calls.push(`peek-item:${chatJid}`);
          return queuedItem;
        },
        consumeQueuedFollowupItem: (chatJid) => {
          calls.push(`consume-item:${chatJid}`);
          return queuedItem;
        },
        prependQueuedFollowupItem: (chatJid, item) => {
          calls.push(`prepend:${chatJid}:${item.rowId}`);
        },
        replaceQueuedFollowupItem: (chatJid, item) => {
          calls.push(`replace-item:${chatJid}:${item.rowId}`);
          return true;
        },
        consumeQueuedFollowupPlaceholder: (chatJid) => {
          calls.push(`consume-placeholder:${chatJid}`);
          return 42;
        },
        getQueuedFollowupCount: (chatJid) => {
          calls.push(`count:${chatJid}`);
          return 2;
        },
        getQueuedFollowupItems: (chatJid) => {
          calls.push(`items:${chatJid}`);
          return [queuedItem];
        },
        removeQueuedFollowupItem: (chatJid, rowId) => {
          calls.push(`remove:${chatJid}:${rowId}`);
          return queuedItem;
        },
        queuePendingSteering: (chatJid, timestamp) => {
          calls.push(`pending-queue:${chatJid}:${timestamp ?? ""}`);
        },
        consumePendingSteering: (chatJid) => {
          calls.push(`pending-consume:${chatJid}`);
          return ["2026-03-28T00:04:00.000Z"];
        },
        updateAgentStatus: (chatJid, nextStatus) => {
          calls.push(`status-update:${chatJid}:${String(nextStatus.title ?? "")}`);
        },
        getAgentStatus: (chatJid) => {
          calls.push(`status-get:${chatJid}`);
          return status;
        },
        setContextUsage: (chatJid, usage) => {
          calls.push(`context-set:${chatJid}:${usage?.percent ?? "null"}`);
        },
        getContextUsage: (chatJid) => {
          calls.push(`context-get:${chatJid}`);
          return { percent: 42 };
        },
        replaceQueuedFollowupPlaceholder: (chatJid, rowId, text, mediaIds, _contentBlocks, threadId, isTerminalAgentReply) => {
          calls.push(`replace:${chatJid}:${rowId}:${text}:${mediaIds.join(",")}:${threadId ?? "null"}:${isTerminalAgentReply ? 1 : 0}`);
          return interaction(4);
        },
        getThreadRootId: (chatJid, messageId) => {
          calls.push(`thread-root:${chatJid}:${messageId}`);
          return 43;
        },
        resumeChat: (chatJid, threadRootId) => {
          calls.push(`resume:${chatJid}:${threadRootId ?? "null"}`);
        },
        skipFailedOnModelSwitch: (chatJid) => {
          calls.push(`skip:${chatJid}`);
          return true;
        },
        retryFailedOnModelSwitch: (chatJid) => {
          calls.push(`retry:${chatJid}`);
          return false;
        },
        recoverInflightRuns: () => {
          calls.push("recover");
        },
        resumePendingChats: (chatJid) => {
          calls.push(`resume-pending:${chatJid ?? ""}`);
        },
        loadState: () => {
          calls.push("load");
        },
        saveState: () => {
          calls.push("save");
        },
        setPanelExpanded: (turnId, panel, expanded) => {
          calls.push(`panel-set:${turnId}:${panel}:${expanded}`);
        },
        isPanelExpanded: (turnId, panel) => {
          calls.push(`panel-get:${turnId}:${panel}`);
          return true;
        },
        updateThoughtBuffer: (turnId, text, totalLines) => {
          calls.push(`thought:${turnId}:${text}:${totalLines}`);
        },
        updateDraftBuffer: (turnId, text, totalLines) => {
          calls.push(`draft:${turnId}:${text}:${totalLines}`);
        },
        getBuffer: (turnId, panel) => {
          calls.push(`buffer:${turnId}:${panel}`);
          return buffer;
        },
      },
      messageProcessingStorageService: {
        processChat: async (chatJid, agentId, threadRootId) => {
          calls.push(`process:${chatJid}:${agentId}:${threadRootId ?? "undefined"}`);
        },
        storeMessage: (chatJid, content, isBot, mediaIds, options) => {
          calls.push(`store:${chatJid}:${content}:${isBot ? 1 : 0}:${mediaIds.join(",")}:${options?.threadId ?? "undefined"}`);
          return stored;
        },
      },
      sessionBroadcast: {
        sse,
        uiBridge,
        broadcastEvent: (eventType, data) => {
          calls.push(`broadcast:${eventType}:${JSON.stringify(data)}`);
        },
      },
    });

    expect(service.sse).toBe(sse);
    expect(service.uiBridge).toBe(uiBridge);
    await service.sendMessage("web:test", "hello", { threadId: 9 });
    await service.postDashboardWidget("web:test", { threadId: 8, widgetId: "widget-runtime" });
    expect(service.queueFollowupPlaceholder("web:test", "queued", 7, "later")).toBe(placeholder);
    expect(service.enqueueQueuedFollowupItem("web:test", 11, "queued", 6, "2026-03-28T00:00:00.000Z")).toBe(41);
    expect(service.peekQueuedFollowupItem("web:test")).toBe(queuedItem);
    expect(service.consumeQueuedFollowupItem("web:test")).toBe(queuedItem);
    service.prependQueuedFollowupItem("web:test", queuedItem);
    expect(service.replaceQueuedFollowupItem("web:test", queuedItem)).toBe(true);
    expect(service.consumeQueuedFollowupPlaceholder("web:test")).toBe(42);
    expect(service.getQueuedFollowupCount("web:test")).toBe(2);
    expect(service.getQueuedFollowupItems("web:test")).toEqual([queuedItem]);
    expect(service.removeQueuedFollowupItem("web:test", 3)).toBe(queuedItem);
    service.queuePendingSteering("web:test", "2026-03-28T00:05:00.000Z");
    expect(service.consumePendingSteering("web:test")).toEqual(["2026-03-28T00:04:00.000Z"]);
    service.updateAgentStatus("web:test", status);
    expect(service.getAgentStatus("web:test")).toEqual(status);
    service.setContextUsage("web:test", { percent: 42 });
    expect(service.getContextUsage("web:test")).toEqual({ percent: 42 });
    service.broadcastEvent("extension_ui_working", { chat_jid: "web:test", message: "Compacting context…" });
    service.broadcastEvent("extension_ui_working_indicator", { chat_jid: "web:test", frames: ["a", "b"], interval_ms: 80 });
    expect(service.getExtensionWorkingState("web:test")).toEqual({
      message: "Compacting context…",
      indicator: { mode: "custom", frames: ["a", "b"], intervalMs: 80 },
      visible: true,
    });
    service.broadcastEvent("agent_response", { chat_jid: "web:test" });
    expect(service.getExtensionWorkingState("web:test")).toBeNull();
    expect(service.replaceQueuedFollowupPlaceholder("web:test", 22, "updated", [1, 2], [{ type: "text" }], 6, true)?.id).toBe(4);
    expect(service.getThreadRootId("web:test", "m-1")).toBe(43);
    service.resumeChat("web:test", 12);
    service.skipFailedOnModelSwitch("web:test");
    service.retryFailedOnModelSwitch("web:test");
    service.recoverInflightRuns();
    service.resumePendingChats("web:test");
    service.loadState();
    service.saveState();
    service.setPanelExpanded("turn-1", "thought", true);
    expect(service.isPanelExpanded("turn-1", "thought")).toBe(true);
    service.updateThoughtBuffer("turn-1", "thought text", 3);
    service.updateDraftBuffer("turn-1", "draft text", 4);
    expect(service.getBuffer("turn-1", "thought")).toEqual(buffer);
    service.broadcastEvent("agent_status", { chat_jid: "web:test", type: "thinking" });
    expect(service.storeMessage("web:test", "stored", true, [7], { threadId: 55 })).toBe(stored);
    await service.processChat("web:test", "default", null);

    expect(calls).toEqual([
      "send:web:test:hello:9",
      "widget:web:test:8:widget-runtime",
      "queue:web:test:queued:7:later",
      "enqueue:web:test:11:queued:6:2026-03-28T00:00:00.000Z",
      "peek-item:web:test",
      "consume-item:web:test",
      "prepend:web:test:3",
      "replace-item:web:test:3",
      "consume-placeholder:web:test",
      "count:web:test",
      "items:web:test",
      "remove:web:test:3",
      "pending-queue:web:test:2026-03-28T00:05:00.000Z",
      "pending-consume:web:test",
      "status-update:web:test:Thinking",
      "status-get:web:test",
      "context-set:web:test:42",
      "context-get:web:test",
      "broadcast:extension_ui_working:{\"chat_jid\":\"web:test\",\"message\":\"Compacting context…\"}",
      "broadcast:extension_ui_working_indicator:{\"chat_jid\":\"web:test\",\"frames\":[\"a\",\"b\"],\"interval_ms\":80}",
      "broadcast:agent_response:{\"chat_jid\":\"web:test\"}",
      "replace:web:test:22:updated:1,2:6:1",
      "thread-root:web:test:m-1",
      "resume:web:test:12",
      "skip:web:test",
      "retry:web:test",
      "recover",
      "resume-pending:web:test",
      "load",
      "save",
      "panel-set:turn-1:thought:true",
      "panel-get:turn-1:thought",
      "thought:turn-1:thought text:3",
      "draft:turn-1:draft text:4",
      "buffer:turn-1:thought",
      "broadcast:agent_status:{\"chat_jid\":\"web:test\",\"type\":\"thinking\"}",
      "store:web:test:stored:1:7:55",
      "process:web:test:default:undefined",
    ]);
  });

  test("reuses a pre-wired runtime public surface service when present", () => {
    const existing = { kind: "existing" } as unknown as ReturnType<typeof getWebChannelRuntimePublicSurfaceService>;
    const carrier = {
      runtimePublicSurfaceService: existing,
      runtimeFollowupFacade: {} as never,
      messageProcessingStorageService: {} as never,
      sessionBroadcast: {} as never,
    };

    expect(getWebChannelRuntimePublicSurfaceService(carrier as any)).toBe(existing);
  });
});
