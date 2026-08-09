/**
 * web/queued-followup-lifecycle-service.ts – queued follow-up lifecycle state.
 *
 * Owns the web channel's deferred queued follow-up persistence, placeholder
 * queue bookkeeping, queue-state payload shaping, and queue action removal
 * behavior. Extracted from `channels/web.ts` to keep WebChannel focused on
 * transport/orchestration while preserving the existing public API.
 */

import {
  deleteMessageByRowId,
  getDeferredQueuedFollowups,
  getMessageByRowId,
  setDeferredQueuedFollowups,
} from "../../../db.js";
import type { DeferredQueuedFollowupRecord } from "../../../db.js";
import {
  cloneQueuedFollowupItem,
  projectPersistedQueuedFollowupItem,
  projectQueuedFollowupItem,
  type QueuedFollowupItem,
} from "../../../queued-followups.js";
import { FollowupPlaceholderStore } from "./followup-placeholders.js";

export interface QueuedFollowupStateItem {
  row_id: number;
  content: string;
  timestamp: string;
  thread_id: number | null;
  source?: string;
  queued_by?: Record<string, string>;
}

export interface RemoveQueuedFollowupForActionOptions {
  removeQueuedFollowupMessage?: (chatJid: string, queuedContent?: string) => Promise<boolean> | boolean;
}

export interface RemoveQueuedFollowupForActionResult {
  removed: QueuedFollowupItem | null;
  source: "deferred" | "placeholder" | null;
}

function toDeferredQueuedFollowupRecord(item: QueuedFollowupItem): DeferredQueuedFollowupRecord {
  return projectPersistedQueuedFollowupItem(item) as DeferredQueuedFollowupRecord;
}

export class QueuedFollowupLifecycleService {
  private readonly placeholderStore: FollowupPlaceholderStore;
  private readonly nextDeferredRowIdByChat = new Map<string, number>();

  constructor(placeholderStore = new FollowupPlaceholderStore()) {
    this.placeholderStore = placeholderStore;
  }

  enqueuePlaceholder(
    chatJid: string,
    rowId: number,
    queuedContent: string,
    threadId?: number | null,
    queuedAt?: string,
    extras?: Pick<QueuedFollowupItem, "mediaIds" | "contentBlocks" | "linkPreviews" | "screenHint" | "source" | "queuedBy" | "durable">
  ): void {
    this.placeholderStore.enqueue(chatJid, rowId, queuedContent, threadId, queuedAt, extras);
  }

  peekQueuedFollowupPlaceholder(chatJid: string): number | null {
    return this.placeholderStore.peek(chatJid)[0]?.rowId ?? null;
  }

  consumeQueuedFollowupPlaceholder(chatJid: string, expectedRowId?: number): number | null {
    if (expectedRowId !== undefined && this.peekQueuedFollowupPlaceholder(chatJid) !== expectedRowId) return null;
    return this.placeholderStore.consume(chatJid);
  }

  enqueueQueuedFollowupItem(
    chatJid: string,
    rowId: number,
    queuedContent: string,
    threadId?: number | null,
    queuedAt?: string,
    extras?: { mediaIds?: number[]; contentBlocks?: unknown[]; linkPreviews?: unknown[]; screenHint?: string; source?: string; queuedBy?: QueuedFollowupItem["queuedBy"]; durable?: boolean }
  ): number {
    const resolvedRowId = Number.isFinite(rowId) && rowId !== 0 ? rowId : this.allocateDeferredQueuedRowId(chatJid);
    const queued = this.getDeferredQueuedFollowupItems(chatJid);
    const item = projectQueuedFollowupItem({
      rowId: resolvedRowId,
      queuedContent,
      threadId,
      queuedAt: queuedAt ?? new Date().toISOString(),
      ...extras,
    });
    // Protected recovery is unfinished work from the active source turn. It
    // must run before follow-ups queued later while that source was inflight;
    // otherwise “continue the source request” would execute against newer
    // conversational state. Preserve FIFO ordering among protected intents.
    if (item.source === "auto-protected-recovery-continuation") {
      let protectedTail = -1;
      for (let index = 0; index < queued.length; index += 1) {
        if (queued[index]?.source === item.source) protectedTail = index;
      }
      queued.splice(protectedTail + 1, 0, item);
    } else {
      queued.push(item);
    }
    this.setDeferredQueuedFollowupItems(chatJid, queued);
    return resolvedRowId;
  }

  peekQueuedFollowupItem(chatJid: string): QueuedFollowupItem | null {
    const next = this.getDeferredQueuedFollowupItems(chatJid)[0] ?? null;
    return next ? cloneQueuedFollowupItem(next) : null;
  }

  consumeQueuedFollowupItem(chatJid: string): QueuedFollowupItem | null {
    const queued = this.getDeferredQueuedFollowupItems(chatJid);
    const next = queued.shift() ?? null;
    this.setDeferredQueuedFollowupItems(chatJid, queued);
    return next ? cloneQueuedFollowupItem(next) : null;
  }

  prependQueuedFollowupItem(chatJid: string, item: QueuedFollowupItem): void {
    const queued = this.getDeferredQueuedFollowupItems(chatJid);
    queued.unshift(cloneQueuedFollowupItem(item));
    this.setDeferredQueuedFollowupItems(chatJid, queued);
  }

  replaceQueuedFollowupItem(chatJid: string, item: QueuedFollowupItem): boolean {
    const queued = this.getDeferredQueuedFollowupItems(chatJid);
    const index = queued.findIndex((entry) => entry.rowId === item.rowId);
    if (index < 0) return false;
    queued[index] = cloneQueuedFollowupItem(item);
    this.setDeferredQueuedFollowupItems(chatJid, queued);
    return true;
  }

  getQueuedFollowupCount(chatJid: string): number {
    return this.getDeferredQueuedFollowupItems(chatJid).length + this.placeholderStore.count(chatJid);
  }

  getQueuedFollowupItems(chatJid: string): QueuedFollowupItem[] {
    const rows = [
      ...this.getDeferredQueuedFollowupItems(chatJid),
      ...this.placeholderStore.peek(chatJid).map((item) => cloneQueuedFollowupItem(item)),
    ];
    const seen = new Set<number>();
    return rows
      .filter((row) => {
        if (seen.has(row.rowId)) return false;
        seen.add(row.rowId);
        return true;
      });
  }

  removeQueuedFollowupItem(chatJid: string, rowId: number): QueuedFollowupItem | null {
    const queued = this.getDeferredQueuedFollowupItems(chatJid);
    const queuedIndex = queued.findIndex((item) => item.rowId === rowId);
    if (queuedIndex >= 0) {
      const [removed] = queued.splice(queuedIndex, 1);
      this.setDeferredQueuedFollowupItems(chatJid, queued);
      return removed ? cloneQueuedFollowupItem(removed) : null;
    }
    const removed = this.placeholderStore.remove(chatJid, rowId);
    return removed ? cloneQueuedFollowupItem(removed) : null;
  }

  listQueuedStateItems(chatJid: string): QueuedFollowupStateItem[] {
    return this.getQueuedFollowupItems(chatJid)
      .map((queued) => {
        const interaction = getMessageByRowId(chatJid, queued.rowId);
        const queuedBy = queued.queuedBy
          ? Object.fromEntries(Object.entries(queued.queuedBy).filter(([, value]) => typeof value === "string" && value.trim())) as Record<string, string>
          : undefined;
        return {
          row_id: queued.rowId,
          content: queued.queuedContent,
          timestamp: interaction?.timestamp ?? queued.queuedAt,
          thread_id: interaction?.data?.thread_id ?? queued.threadId ?? null,
          ...(queued.source ? { source: queued.source } : {}),
          ...(queuedBy && Object.keys(queuedBy).length > 0 ? { queued_by: queuedBy } : {}),
        };
      })
      .filter((item) => typeof item.content === "string" && item.content.trim().length > 0);
  }

  async removeQueuedFollowupForAction(
    chatJid: string,
    rowId: number,
    options: RemoveQueuedFollowupForActionOptions = {}
  ): Promise<RemoveQueuedFollowupForActionResult> {
    const queued = this.getDeferredQueuedFollowupItems(chatJid);
    const queuedIndex = queued.findIndex((item) => item.rowId === rowId);
    const removedQueued = queuedIndex >= 0 ? (queued.splice(queuedIndex, 1)[0] ?? null) : null;
    if (queuedIndex >= 0) {
      this.setDeferredQueuedFollowupItems(chatJid, queued);
    }

    const removedPlaceholder = removedQueued ? null : this.placeholderStore.remove(chatJid, rowId);
    const removed = removedQueued ?? removedPlaceholder;
    const source = removedQueued ? "deferred" : removedPlaceholder ? "placeholder" : null;
    if (!removed || !source) return { removed: null, source: null };

    if (removed.rowId > 0) {
      deleteMessageByRowId(chatJid, removed.rowId);
    }

    if (source === "placeholder" && typeof options.removeQueuedFollowupMessage === "function") {
      await options.removeQueuedFollowupMessage(chatJid, removed.queuedContent);
    }

    return { removed: cloneQueuedFollowupItem(removed), source };
  }

  private getDeferredQueuedFollowupItems(chatJid: string): QueuedFollowupItem[] {
    return getDeferredQueuedFollowups(chatJid).map((item) => projectPersistedQueuedFollowupItem(item));
  }

  private setDeferredQueuedFollowupItems(chatJid: string, items: QueuedFollowupItem[]): void {
    const protectedItems = items.filter((item) => item.source === "auto-protected-recovery-continuation");
    const ordinaryItems = items.filter((item) => item.source !== "auto-protected-recovery-continuation");
    setDeferredQueuedFollowups(chatJid, [...protectedItems, ...ordinaryItems].map((item) => toDeferredQueuedFollowupRecord(item)));
  }

  reorderQueuedFollowupItems(chatJid: string, fromIndex: number, toIndex: number): boolean {
    const queued = this.getDeferredQueuedFollowupItems(chatJid);
    if (fromIndex < 0 || toIndex < 0 || fromIndex >= queued.length || toIndex >= queued.length || fromIndex === toIndex) return false;
    const [moved] = queued.splice(fromIndex, 1);
    queued.splice(toIndex, 0, moved);
    const protectedCount = queued.filter((item) => item.source === "auto-protected-recovery-continuation").length;
    const normalized = [
      ...queued.filter((item) => item.source === "auto-protected-recovery-continuation"),
      ...queued.filter((item) => item.source !== "auto-protected-recovery-continuation"),
    ];
    if (normalized.some((item, index) => item.rowId !== queued[index]?.rowId)) return false;
    if (moved?.source === "auto-protected-recovery-continuation" && toIndex >= protectedCount) return false;
    if (moved?.source !== "auto-protected-recovery-continuation" && toIndex < protectedCount) return false;
    this.setDeferredQueuedFollowupItems(chatJid, queued);
    return true;
  }

  private allocateDeferredQueuedRowId(chatJid: string): number {
    const queued = this.getDeferredQueuedFollowupItems(chatJid);
    const minQueuedRowId = queued.reduce((min, item) => (item.rowId < min ? item.rowId : min), 0);
    const previousSeed = this.nextDeferredRowIdByChat.get(chatJid) ?? 0;
    const nextRowId = Math.min(minQueuedRowId - 1, previousSeed - 1, -1);
    this.nextDeferredRowIdByChat.set(chatJid, nextRowId);
    return nextRowId;
  }
}
