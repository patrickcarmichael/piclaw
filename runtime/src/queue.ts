/**
 * queue.ts – Lane-aware execution queue with retry for agent runs.
 *
 * Ensures only one task runs at a time per logical lane (for example one chat),
 * while allowing different lanes to make progress in parallel. Failed tasks are
 * retried with exponential back-off up to DEFAULT_MAX_RETRIES times.
 * Pending and retrying items can be deduplicated by an optional string `id`.
 * An executing item may enqueue one same-ID successor for lane continuation;
 * that successor supersedes an automatic retry if the current item then fails.
 *
 * Consumers:
 *   - runtime.ts creates a single AgentQueue and passes it to the router
 *     and task scheduler.
 *   - router.ts calls enqueue() for each inbound message that needs processing.
 *   - task-scheduler.ts calls enqueueTask() for due scheduled tasks.
 *   - channels/web.ts calls enqueue() for web channel interactions.
 */

import { DEFAULT_BASE_RETRY_MS, DEFAULT_MAX_RETRIES, getRetryDelay, shouldRetry } from "./queue/retry-policy.js";
import { createLogger } from "./utils/logger.js";

const log = createLogger("queue");
const DEFAULT_LANE_KEY = "__default__";

/** Internal representation of a queued work item. */
interface QueueItem {
  /** Optional deduplication key. */
  id?: string;
  /** The async function to execute. */
  fn: () => Promise<void>;
  /** Logical lane key; tasks in the same lane are serialized. */
  laneKey: string;
  /** Number of times this item has been retried after failure. */
  retries: number;
  /** Whether the queued function has started for its current attempt. */
  started: boolean;
}

interface LaneState {
  running: boolean;
  pending: QueueItem[];
  current: QueueItem | null;
  runningPromise: Promise<void> | null;
}

/** In-memory counters for queue behavior/health visibility. */
export interface QueueMetrics {
  enqueued: number;
  deduplicated: number;
  started: number;
  succeeded: number;
  failed: number;
  retriesScheduled: number;
}

/**
 * A lane-aware execution queue: items run FIFO within each lane, while
 * unrelated lanes may execute concurrently.
 */
export class AgentQueue {
  private lanes = new Map<string, LaneState>();
  private retryingIds = new Set<string>();
  private retryTimers = new Set<ReturnType<typeof setTimeout>>();
  private shuttingDown = false;
  private metrics: QueueMetrics = {
    enqueued: 0,
    deduplicated: 0,
    started: 0,
    succeeded: 0,
    failed: 0,
    retriesScheduled: 0,
  };

  private getLane(laneKey?: string): LaneState {
    const resolved = laneKey || DEFAULT_LANE_KEY;
    let lane = this.lanes.get(resolved);
    if (!lane) {
      lane = { running: false, pending: [], current: null, runningPromise: null };
      this.lanes.set(resolved, lane);
    }
    return lane;
  }

  private removeLaneIfIdle(laneKey: string): void {
    const lane = this.lanes.get(laneKey);
    if (!lane) return;
    if (lane.running) return;
    if (lane.current) return;
    if (lane.pending.length > 0) return;
    if (lane.runningPromise) return;
    this.lanes.delete(laneKey);
  }

  private hasPendingId(id: string): boolean {
    for (const lane of this.lanes.values()) {
      if (lane.pending.some((item) => item.id === id)) return true;
    }
    return false;
  }

  private hasQueuedId(id: string): boolean {
    if (this.retryingIds.has(id)) return true;
    for (const lane of this.lanes.values()) {
      if (lane.current?.id === id && !lane.current.started) return true;
    }
    return this.hasPendingId(id);
  }

  /**
   * Add a work item to the queue.
   * Items in the same lane run sequentially; items in different lanes may run
   * concurrently. Pending and retrying items with the same `id` are
   * deduplicated globally; an executing item may schedule one successor.
   */
  enqueue(fn: () => Promise<void>, id?: string, laneKey?: string): void {
    if (this.shuttingDown) return;

    if (id && this.hasQueuedId(id)) {
      this.metrics.deduplicated += 1;
      return;
    }

    const resolvedLaneKey = laneKey || DEFAULT_LANE_KEY;
    const lane = this.getLane(resolvedLaneKey);
    const item: QueueItem = { id, fn, laneKey: resolvedLaneKey, retries: 0, started: false };
    this.metrics.enqueued += 1;

    if (lane.running) {
      lane.pending.push(item);
      return;
    }

    this.runItem(lane, item);
  }

  /** Convenience wrapper that prefixes the id with "task:" for scheduled tasks. */
  enqueueTask(taskId: string, fn: () => Promise<void>, laneKey?: string): void {
    this.enqueue(fn, `task:${taskId}`, laneKey);
  }

  /** Start executing an item inside a lane. */
  private runItem(lane: LaneState, item: QueueItem): void {
    if (item.id) this.retryingIds.delete(item.id);
    item.started = false;
    lane.running = true;
    lane.current = item;
    this.metrics.started += 1;
    // Do not invoke the queued function synchronously from enqueue(). An async
    // function runs inline until its first await, and web submit handlers enqueue
    // processChat() before returning the POST response. If processChat performs
    // expensive synchronous setup before its first await, the user's message is
    // not displayed or acted upon until that setup completes. Starting work on
    // the next event-loop turn keeps enqueue() as a cheap scheduling operation.
    lane.runningPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        void this.executeItem(lane, item).finally(resolve);
      }, 0);
    });
  }

  /** Run the item's function, handle errors with retry, and advance within the lane. */
  private async executeItem(lane: LaneState, item: QueueItem): Promise<void> {
    item.started = true;
    try {
      await item.fn();
      this.metrics.succeeded += 1;
    } catch (error) {
      this.metrics.failed += 1;
      log.error("Queue item failed", {
        operation: "execute_item",
        laneKey: item.laneKey,
        itemId: item.id ?? null,
        err: error,
      });
      this.scheduleRetry(item);
    } finally {
      lane.running = false;
      lane.current = null;
      lane.runningPromise = null;
      if (lane.pending.length > 0 && !this.shuttingDown) {
        const next = lane.pending.shift()!;
        this.runItem(lane, next);
      } else {
        this.removeLaneIfIdle(item.laneKey);
      }
    }
  }

  /** Schedule an exponential-backoff retry for a failed item. */
  private scheduleRetry(item: QueueItem): void {
    if (item.id && this.hasPendingId(item.id)) return;
    if (!shouldRetry(item.retries, DEFAULT_MAX_RETRIES, this.shuttingDown)) return;
    item.retries++;
    this.metrics.retriesScheduled += 1;
    if (item.id) this.retryingIds.add(item.id);
    const delay = getRetryDelay(item.retries, DEFAULT_BASE_RETRY_MS);
    log.info("Scheduling queue retry", {
      operation: "schedule_retry",
      retries: item.retries,
      maxRetries: DEFAULT_MAX_RETRIES,
      delayMs: delay,
      itemId: item.id ?? null,
    });
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      if (item.id) this.retryingIds.delete(item.id);
      if (this.shuttingDown) return;
      const lane = this.getLane(item.laneKey);
      if (lane.running) {
        lane.pending.push(item);
      } else {
        this.runItem(lane, item);
      }
    }, delay);
    this.retryTimers.add(timer);
  }

  /**
   * Gracefully shut down the queue: clear pending items and wait up to `ms`
   * milliseconds for currently running lane tasks to finish.
   */
  async shutdown(ms = 5000): Promise<void> {
    this.shuttingDown = true;
    for (const timer of this.retryTimers) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
    this.retryingIds.clear();
    const runningPromises: Promise<void>[] = [];
    for (const lane of this.lanes.values()) {
      lane.pending = [];
      if (lane.runningPromise) runningPromises.push(lane.runningPromise);
    }
    if (runningPromises.length > 0) {
      await Promise.race([Promise.allSettled(runningPromises), Bun.sleep(ms)]);
    }
  }

  /** Snapshot queue counters for diagnostics and tests. */
  getMetrics(): QueueMetrics {
    return { ...this.metrics };
  }
}
