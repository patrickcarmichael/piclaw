import type { InteractionRow } from "../db.js";
import {
  extensionKvDelete,
  extensionKvGet,
  extensionKvList,
  extensionKvSet,
  getDb,
} from "../db.js";
import { createUuid } from "../utils/ids.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("runtime.restart-handoff");

export const EXIT_PROCESS_HANDOFF_EXTENSION_ID = "exit-process";
export const EXIT_PROCESS_HANDOFF_KEY_PREFIX = "restart-handoff:";
export const RESTART_COMPLETION_MESSAGE = "Restart completed.";
export const RESTART_CONTINUATION_SCREEN_HINT = "self-resume";

export type RestartHandoffMessagePhase = "notice" | "completion" | "resume";

export type RestartHandoffState =
  | "preparing"
  | "ready"
  | "completion_posted"
  | "resume_posted";

export interface RestartHandoff {
  version: 1;
  restartId: string;
  state: RestartHandoffState;
  chatJid: string;
  reason: string;
  resumeMessage: string | null;
  requestedAt: string;
  restartMessageRowId: number | null;
  completionMessageRowId: number | null;
  resumeMessageRowId: number | null;
}

export interface RestartHandoffRecoveryWebChannel {
  storeMessage(
    chatJid: string,
    content: string,
    isBot: boolean,
    mediaIds: number[],
    options?: {
      contentBlocks?: unknown[];
      screenHint?: string | null;
    },
  ): InteractionRow | null;
  broadcastEvent(eventType: string, data: unknown): void;
  resumeChat(chatJid: string, threadRootId?: number | null): void;
}

export interface RestartHandoffRecoverySummary {
  discovered: number;
  recovered: number;
  discarded: number;
  failed: number;
  completionMessagesCreated: number;
  resumeMessagesCreated: number;
  turnsResumed: number;
}

const VALID_STATES = new Set<RestartHandoffState>([
  "preparing",
  "ready",
  "completion_posted",
  "resume_posted",
]);

function handoffKey(restartId: string): string {
  return `${EXIT_PROCESS_HANDOFF_KEY_PREFIX}${restartId}`;
}

function isPositiveIntegerOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value) && value > 0);
}

function isRestartHandoff(value: unknown): value is RestartHandoff {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return false;
  if (typeof record.restartId !== "string" || !record.restartId.trim()) return false;
  if (typeof record.state !== "string" || !VALID_STATES.has(record.state as RestartHandoffState)) return false;
  if (typeof record.chatJid !== "string" || !record.chatJid.trim()) return false;
  if (typeof record.reason !== "string" || !record.reason.trim()) return false;
  if (record.resumeMessage !== null && (typeof record.resumeMessage !== "string" || !record.resumeMessage.trim())) return false;
  if (typeof record.requestedAt !== "string" || !Number.isFinite(Date.parse(record.requestedAt))) return false;
  return isPositiveIntegerOrNull(record.restartMessageRowId)
    && isPositiveIntegerOrNull(record.completionMessageRowId)
    && isPositiveIntegerOrNull(record.resumeMessageRowId);
}

function persistRestartHandoff(handoff: RestartHandoff): RestartHandoff {
  if (!isRestartHandoff(handoff)) {
    throw new Error("Restart handoff is invalid and was not persisted.");
  }
  const key = handoffKey(handoff.restartId);
  extensionKvSet(EXIT_PROCESS_HANDOFF_EXTENSION_ID, key, handoff, "global");
  const stored = extensionKvGet<unknown>(EXIT_PROCESS_HANDOFF_EXTENSION_ID, key, "global");
  if (!isRestartHandoff(stored) || stored.restartId !== handoff.restartId || stored.state !== handoff.state) {
    throw new Error(`Failed to verify persisted restart handoff ${handoff.restartId}.`);
  }
  return stored;
}

export function prepareRestartHandoff(input: {
  chatJid: string;
  reason: string;
  resumeMessage?: string | null;
}): RestartHandoff {
  const chatJid = typeof input.chatJid === "string" ? input.chatJid.trim() : "";
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  const hasResumeMessage = input.resumeMessage !== undefined && input.resumeMessage !== null;
  const resumeMessage = typeof input.resumeMessage === "string" ? input.resumeMessage.trim() : "";
  if (!chatJid) throw new Error("Restart handoff requires a chat JID.");
  if (!reason) throw new Error("Restart handoff requires a reason.");
  if (hasResumeMessage && !resumeMessage) {
    throw new Error("Restart handoff resume message must be non-empty when supplied.");
  }

  const handoff: RestartHandoff = {
    version: 1,
    restartId: createUuid("restart"),
    state: "preparing",
    chatJid,
    reason,
    resumeMessage: resumeMessage || null,
    requestedAt: new Date().toISOString(),
    restartMessageRowId: null,
    completionMessageRowId: null,
    resumeMessageRowId: null,
  };
  return persistRestartHandoff(handoff);
}

export function markRestartHandoffReady(
  handoff: RestartHandoff,
  restartMessageRowId: number,
): RestartHandoff {
  if (!Number.isInteger(restartMessageRowId) || restartMessageRowId <= 0) {
    throw new Error("A persisted restart notice row id is required before the handoff can be marked ready.");
  }
  if (handoff.state !== "preparing") {
    throw new Error(`Restart handoff ${handoff.restartId} is already ${handoff.state}.`);
  }
  return persistRestartHandoff({
    ...handoff,
    state: "ready",
    restartMessageRowId,
  });
}

export function deleteRestartHandoff(restartId: string): boolean {
  return extensionKvDelete(
    EXIT_PROCESS_HANDOFF_EXTENSION_ID,
    handoffKey(restartId),
    "global",
  );
}

export function listRestartHandoffs(): RestartHandoff[] {
  const keys = extensionKvList(
    EXIT_PROCESS_HANDOFF_EXTENSION_ID,
    EXIT_PROCESS_HANDOFF_KEY_PREFIX,
    "global",
  );
  const handoffs: RestartHandoff[] = [];
  for (const key of keys) {
    const value = extensionKvGet<unknown>(EXIT_PROCESS_HANDOFF_EXTENSION_ID, key, "global");
    if (!isRestartHandoff(value) || key !== handoffKey(value.restartId)) continue;
    handoffs.push(value);
  }
  return handoffs.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
}

export function buildRestartHandoffMarker(
  restartId: string,
  phase: RestartHandoffMessagePhase,
  options: { reason?: string } = {},
): Record<string, unknown> {
  const reason = typeof options.reason === "string" ? options.reason.trim() : "";
  return {
    type: "restart_handoff",
    source: "exit_process",
    restart_id: restartId,
    phase,
    ...(phase === "notice" && reason ? { reason } : {}),
  };
}

function findRestartMessageRowId(
  chatJid: string,
  restartId: string,
  phase: "completion" | "resume",
  isBot: boolean,
): number | null {
  const row = getDb().prepare(`
    SELECT m.rowid
    FROM messages m
    WHERE m.chat_jid = ?
      AND m.is_bot_message = ?
      AND EXISTS (
        SELECT 1
        FROM json_each(
          CASE
            WHEN json_valid(m.content_blocks) THEN m.content_blocks
            ELSE '[]'
          END
        ) AS block
        WHERE json_extract(block.value, '$.type') = 'restart_handoff'
          AND json_extract(block.value, '$.source') = 'exit_process'
          AND json_extract(block.value, '$.restart_id') = ?
          AND json_extract(block.value, '$.phase') = ?
      )
    ORDER BY m.rowid ASC
    LIMIT 1
  `).get(chatJid, isBot ? 1 : 0, restartId, phase) as { rowid: number } | undefined;
  return row?.rowid ?? null;
}

function updateHandoffStage(
  handoff: RestartHandoff,
  update: Partial<Pick<RestartHandoff, "state" | "completionMessageRowId" | "resumeMessageRowId">>,
): RestartHandoff {
  return persistRestartHandoff({ ...handoff, ...update });
}

function storeCompletionMessage(
  web: RestartHandoffRecoveryWebChannel,
  handoff: RestartHandoff,
): { rowId: number; created: boolean } {
  const existingRowId = findRestartMessageRowId(handoff.chatJid, handoff.restartId, "completion", true);
  if (existingRowId) return { rowId: existingRowId, created: false };

  const interaction = web.storeMessage(
    handoff.chatJid,
    RESTART_COMPLETION_MESSAGE,
    true,
    [],
    { contentBlocks: [buildRestartHandoffMarker(handoff.restartId, "completion")] },
  );
  if (!interaction?.id) throw new Error("Failed to store the restart completion message.");
  web.broadcastEvent("agent_response", interaction);
  return { rowId: interaction.id, created: true };
}

function storeResumeMessage(
  web: RestartHandoffRecoveryWebChannel,
  handoff: RestartHandoff,
): { rowId: number; created: boolean } {
  const existingRowId = findRestartMessageRowId(handoff.chatJid, handoff.restartId, "resume", false);
  if (existingRowId) return { rowId: existingRowId, created: false };

  const interaction = web.storeMessage(
    handoff.chatJid,
    handoff.resumeMessage || "",
    false,
    [],
    {
      contentBlocks: [
        buildRestartHandoffMarker(handoff.restartId, "resume"),
        {
          type: "self_continuation",
          source: "exit_process",
          restart_id: handoff.restartId,
        },
      ],
      screenHint: RESTART_CONTINUATION_SCREEN_HINT,
    },
  );
  if (!interaction?.id) throw new Error("Failed to store the restart continuation message.");
  web.broadcastEvent("new_post", interaction);
  return { rowId: interaction.id, created: true };
}

export function recoverPendingRestartHandoffs(
  web: RestartHandoffRecoveryWebChannel,
  options: { resumeTurns?: boolean } = {},
): RestartHandoffRecoverySummary {
  const summary: RestartHandoffRecoverySummary = {
    discovered: 0,
    recovered: 0,
    discarded: 0,
    failed: 0,
    completionMessagesCreated: 0,
    resumeMessagesCreated: 0,
    turnsResumed: 0,
  };

  let keys: string[];
  try {
    keys = extensionKvList(
      EXIT_PROCESS_HANDOFF_EXTENSION_ID,
      EXIT_PROCESS_HANDOFF_KEY_PREFIX,
      "global",
    );
  } catch (error) {
    log.error("Failed to enumerate restart handoffs", {
      operation: "restart_handoff.enumerate",
      err: error,
    });
    summary.failed += 1;
    return summary;
  }

  summary.discovered = keys.length;
  const entries: Array<{ key: string; value: unknown }> = [];
  for (const key of keys) {
    try {
      entries.push({
        key,
        value: extensionKvGet<unknown>(EXIT_PROCESS_HANDOFF_EXTENSION_ID, key, "global"),
      });
    } catch (error) {
      log.error("Failed to read restart handoff; it will be retried on startup", {
        operation: "restart_handoff.read",
        key,
        err: error,
      });
      summary.failed += 1;
    }
  }
  entries.sort((a, b) => {
    const aTime = isRestartHandoff(a.value) ? a.value.requestedAt : "";
    const bTime = isRestartHandoff(b.value) ? b.value.requestedAt : "";
    return aTime.localeCompare(bTime) || a.key.localeCompare(b.key);
  });

  for (const entry of entries) {
    const handoff = entry.value;
    if (!isRestartHandoff(handoff) || entry.key !== handoffKey(handoff.restartId)) {
      log.warn("Discarding malformed restart handoff", {
        operation: "restart_handoff.discard_malformed",
        key: entry.key,
      });
      try {
        extensionKvDelete(EXIT_PROCESS_HANDOFF_EXTENSION_ID, entry.key, "global");
        summary.discarded += 1;
      } catch (error) {
        log.error("Failed to discard malformed restart handoff", {
          operation: "restart_handoff.discard_malformed",
          key: entry.key,
          err: error,
        });
        summary.failed += 1;
      }
      continue;
    }

    if (handoff.state === "preparing") {
      try {
        deleteRestartHandoff(handoff.restartId);
        summary.discarded += 1;
      } catch (error) {
        log.error("Failed to discard incomplete restart handoff", {
          operation: "restart_handoff.discard_preparing",
          restartId: handoff.restartId,
          chatJid: handoff.chatJid,
          err: error,
        });
        summary.failed += 1;
      }
      continue;
    }

    try {
      const completion = storeCompletionMessage(web, handoff);
      if (completion.created) summary.completionMessagesCreated += 1;
      let current = updateHandoffStage(handoff, {
        state: "completion_posted",
        completionMessageRowId: completion.rowId,
      });

      if (current.resumeMessage) {
        const resume = storeResumeMessage(web, current);
        if (resume.created) summary.resumeMessagesCreated += 1;
        current = updateHandoffStage(current, {
          state: "resume_posted",
          resumeMessageRowId: resume.rowId,
        });
        if (options.resumeTurns !== false) {
          web.resumeChat(current.chatJid, resume.rowId);
          summary.turnsResumed += 1;
        }
      }

      deleteRestartHandoff(current.restartId);
      summary.recovered += 1;
      log.info("Recovered restart handoff", {
        operation: "restart_handoff.recovered",
        restartId: current.restartId,
        chatJid: current.chatJid,
        completionMessageRowId: current.completionMessageRowId,
        resumeMessageRowId: current.resumeMessageRowId,
      });
    } catch (error) {
      summary.failed += 1;
      log.error("Failed to recover restart handoff; it will be retried on startup", {
        operation: "restart_handoff.recover",
        restartId: handoff.restartId,
        chatJid: handoff.chatJid,
        state: handoff.state,
        err: error,
      });
    }
  }

  return summary;
}
