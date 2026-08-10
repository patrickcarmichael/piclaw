/** Owner-authorized, transactional secure erasure of message/thread content. */
import { createHash } from "node:crypto";

import { createUuid } from "../utils/ids.js";
import {
  getAcceptedChatSource,
  getGoalContinuationLineage,
  getProtectedContinuationRootSource,
  getRestartContinuationRootSource,
  type AcceptedChatSource,
} from "./chat-operations.js";
import { getDb } from "./connection.js";
import { deleteUnreferencedMedia, getMediaIdsForMessages, rebuildMessagesFtsWithMedia } from "./media.js";

export interface SecureEraseMessageRoot {
  chatJid: string;
  rowId: number;
}

export interface SecureEraseOperationEvidence {
  source_seq: number;
  operation_id: string;
  frontier_message_row_id: number | null;
  terminal_message_row_id: number | null;
  policy: "retained_tombstone" | "retained_disposition";
}

export interface SecureEraseMessagePlan {
  eraseRowIds: number[];
  alreadyErasedRowIds: number[];
  missingRootRowIds: number[];
  operationEvidence: SecureEraseOperationEvidence[];
  blockedOperationSourceSeqs: number[];
  blockedOperationIds: string[];
  affectedMediaIds: number[];
  affectedThinkingRowIds: number[];
  affectedLinkPreviewCacheMediaIds: number[];
  confirmationToken: string;
}

export interface SecureEraseMessageResult extends SecureEraseMessagePlan {
  applied: boolean;
  erasureId: string | null;
  erasedMediaIds: number[];
  detachedMediaIds: number[];
  clearedThinkingRowIds: number[];
  clearedLinkPreviewCacheMediaIds: number[];
  clearedFtsRowIds: number[];
  rejectionReason: "confirmation_required" | "plan_changed" | "unsettled_operation" | null;
}

interface SecureEraseStoredRow {
  rowid: number;
  id: string;
  chat_jid: string;
  link_previews: string | null;
  content_erased: number;
  content_erasure_id: string | null;
}

interface SecureEraseConfirmationScope {
  requestedRoots: Array<{ chat_jid: string; rowid: number }>;
  rowIdentities: Array<{ rowid: number; chat_jid: string; id: string }>;
  missingRootRowIds: number[];
  operationEvidence: SecureEraseOperationEvidence[];
  blockedOperationSourceSeqs: number[];
  blockedOperationIds: string[];
}

function hashSecureEraseValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function createSecureEraseScopeToken(scope: SecureEraseConfirmationScope): string {
  return hashSecureEraseValue({
    version: 1,
    requested_roots: scope.requestedRoots,
    row_identities: scope.rowIdentities,
    missing_root_row_ids: scope.missingRootRowIds,
    operation_evidence: scope.operationEvidence,
    blocked_operation_source_seqs: scope.blockedOperationSourceSeqs,
    blocked_operation_ids: scope.blockedOperationIds,
  });
}

function createSecureEraseConfirmationToken(input: SecureEraseConfirmationScope & {
  affectedMediaIds: number[];
  affectedThinkingRowIds: number[];
  affectedLinkPreviewCacheMediaIds: number[];
}): string {
  return hashSecureEraseValue({
    version: 1,
    scope_token: createSecureEraseScopeToken(input),
    affected_media_ids: input.affectedMediaIds,
    affected_thinking_row_ids: input.affectedThinkingRowIds,
    affected_link_preview_cache_media_ids: input.affectedLinkPreviewCacheMediaIds,
  });
}

function parsePreviewMediaIds(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const found = new Set<number>();
    const visit = (value: unknown): void => {
      if (typeof value === "string") {
        for (const match of value.matchAll(/(?:^|\/)media\/(\d+)(?:$|[/?#])/g)) {
          const id = Number(match[1]);
          if (Number.isInteger(id) && id > 0) found.add(id);
        }
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      if (value && typeof value === "object") {
        for (const item of Object.values(value as Record<string, unknown>)) visit(item);
      }
    };
    visit(JSON.parse(raw));
    return Array.from(found).sort((a, b) => a - b);
  } catch {
    return [];
  }
}

function resolveContinuationRoot(source: AcceptedChatSource): AcceptedChatSource | null {
  if (source.sourceKind === "protected_continuation") return getProtectedContinuationRootSource(source);
  if (source.sourceKind === "restart_continuation") return getRestartContinuationRootSource(source);
  if (source.sourceKind === "goal_continuation") {
    const lineage = getGoalContinuationLineage(source);
    return lineage ? getAcceptedChatSource(lineage.rootSourceSeq) : null;
  }
  return null;
}

function collectSecureErasePlan(roots: SecureEraseMessageRoot[]): SecureEraseMessagePlan & {
  rows: SecureEraseStoredRow[];
  scopeToken: string;
} {
  const db = getDb();
  const selected = new Map<number, SecureEraseStoredRow>();
  const missingRootRowIds: number[] = [];
  const uniqueRoots = new Map<string, SecureEraseMessageRoot>();
  for (const root of roots) {
    if (!root.chatJid.trim() || !Number.isInteger(root.rowId) || root.rowId <= 0) continue;
    uniqueRoots.set(`${root.chatJid}\u0000${root.rowId}`, root);
  }

  const requestedRoots = Array.from(uniqueRoots.values())
    .map((root) => ({ chat_jid: root.chatJid, rowid: root.rowId }))
    .sort((a, b) => a.chat_jid.localeCompare(b.chat_jid) || a.rowid - b.rowid);

  for (const root of uniqueRoots.values()) {
    const rows = db.prepare(`SELECT rowid, id, chat_jid, link_previews, content_erased, content_erasure_id
      FROM messages WHERE chat_jid = ? AND (rowid = ? OR thread_id = ?) ORDER BY rowid`)
      .all(root.chatJid, root.rowId, root.rowId) as SecureEraseStoredRow[];
    if (!rows.some((row) => row.rowid === root.rowId)) {
      missingRootRowIds.push(root.rowId);
      continue;
    }
    for (const row of rows) selected.set(row.rowid, row);
  }

  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const row of Array.from(selected.values())) {
      const terminalRows = db.prepare(`SELECT terminal.rowid, terminal.id, terminal.chat_jid,
          terminal.link_previews, terminal.content_erased, terminal.content_erasure_id
        FROM chat_accepted_sources source
        JOIN chat_operation_dispositions disposition ON disposition.source_seq = source.source_seq
        JOIN messages terminal ON terminal.chat_jid = disposition.terminal_message_chat_jid
          AND terminal.id = disposition.terminal_message_id
        WHERE source.chat_jid = ? AND source.frontier_message_id = ?`)
        .all(row.chat_jid, row.id) as SecureEraseStoredRow[];
      for (const terminal of terminalRows) {
        if (selected.has(terminal.rowid)) continue;
        selected.set(terminal.rowid, terminal);
        expanded = true;
      }
    }

    const selectedMessageKeys = new Set(Array.from(selected.values()).map((row) => `${row.chat_jid}\u0000${row.id}`));
    const continuationTerminals = db.prepare(`SELECT source.source_seq, terminal.rowid, terminal.id,
        terminal.chat_jid, terminal.link_previews, terminal.content_erased, terminal.content_erasure_id
      FROM chat_accepted_sources source
      JOIN chat_operation_dispositions disposition ON disposition.source_seq = source.source_seq
      JOIN messages terminal ON terminal.chat_jid = disposition.terminal_message_chat_jid
        AND terminal.id = disposition.terminal_message_id
      WHERE source.source_kind IN ('protected_continuation', 'restart_continuation', 'goal_continuation')
      ORDER BY source.source_seq`)
      .all() as Array<SecureEraseStoredRow & { source_seq: number }>;
    for (const terminal of continuationTerminals) {
      const source = getAcceptedChatSource(terminal.source_seq);
      const root = source ? resolveContinuationRoot(source) : null;
      if (!root?.frontierMessageId || !selectedMessageKeys.has(`${root.chatJid}\u0000${root.frontierMessageId}`)
        || selected.has(terminal.rowid)) continue;
      selected.set(terminal.rowid, terminal);
      expanded = true;
    }
  }

  const rows = Array.from(selected.values()).sort((a, b) => a.rowid - b.rowid);
  if (rows.length === 0) {
    const missing = Array.from(new Set(missingRootRowIds)).sort((a, b) => a - b);
    const scope: SecureEraseConfirmationScope = {
      requestedRoots,
      rowIdentities: [],
      missingRootRowIds: missing,
      operationEvidence: [],
      blockedOperationSourceSeqs: [],
      blockedOperationIds: [],
    };
    return {
      rows,
      scopeToken: createSecureEraseScopeToken(scope),
      eraseRowIds: [],
      alreadyErasedRowIds: [],
      missingRootRowIds: missing,
      operationEvidence: [],
      blockedOperationSourceSeqs: [],
      blockedOperationIds: [],
      affectedMediaIds: [],
      affectedThinkingRowIds: [],
      affectedLinkPreviewCacheMediaIds: [],
      confirmationToken: createSecureEraseConfirmationToken({
        ...scope,
        affectedMediaIds: [],
        affectedThinkingRowIds: [],
        affectedLinkPreviewCacheMediaIds: [],
      }),
    };
  }

  const placeholders = rows.map(() => "?").join(",");
  const rowIds = rows.map((row) => row.rowid);
  const eraseRowIds = rows.filter((row) => row.content_erased !== 1).map((row) => row.rowid);
  const affectedPreviewMediaIds = Array.from(new Set(
    rows.filter((row) => row.content_erased !== 1).flatMap((row) => parsePreviewMediaIds(row.link_previews)),
  )).sort((a, b) => a - b);
  const affectedMediaIds = Array.from(new Set([
    ...getMediaIdsForMessages(eraseRowIds),
    ...affectedPreviewMediaIds,
  ])).sort((a, b) => a - b);
  const affectedLinkPreviewCacheMediaIds = affectedPreviewMediaIds.length === 0
    ? []
    : (db.prepare(`SELECT media_id FROM link_preview_image_cache
        WHERE media_id IN (${affectedPreviewMediaIds.map(() => "?").join(",")}) ORDER BY media_id`)
        .all(...affectedPreviewMediaIds) as Array<{ media_id: number }>)
        .map((row) => row.media_id);
  const affectedThinkingRowIds = eraseRowIds.length === 0
    ? []
    : Array.from(new Set((db.prepare(`SELECT message_id FROM thinking_content
        WHERE CAST(message_id AS INTEGER) IN (${eraseRowIds.map(() => "?").join(",")})`)
        .all(...eraseRowIds) as Array<{ message_id: string }>)
        .map((row) => Number(row.message_id))
        .filter((rowId) => Number.isInteger(rowId) && rowId > 0)))
        .sort((a, b) => a - b);
  const operationEvidence = db.prepare(`SELECT DISTINCT disposition.source_seq, disposition.operation_id,
      frontier.rowid AS frontier_message_row_id, terminal.rowid AS terminal_message_row_id
    FROM chat_operation_dispositions disposition
    LEFT JOIN chat_accepted_sources source ON source.source_seq = disposition.source_seq
    LEFT JOIN messages frontier ON frontier.chat_jid = source.chat_jid AND frontier.id = source.frontier_message_id
    LEFT JOIN messages terminal ON terminal.chat_jid = disposition.terminal_message_chat_jid
      AND terminal.id = disposition.terminal_message_id
    WHERE frontier.rowid IN (${placeholders}) OR terminal.rowid IN (${placeholders})
    ORDER BY disposition.source_seq`)
    .all(...rowIds, ...rowIds) as Array<{
      source_seq: number;
      operation_id: string;
      frontier_message_row_id: number | null;
      terminal_message_row_id: number | null;
    }>;
  const blocked = db.prepare(`SELECT DISTINCT source.source_seq, source.operation_id
    FROM chat_accepted_sources source
    JOIN messages frontier ON frontier.chat_jid = source.chat_jid AND frontier.id = source.frontier_message_id
    LEFT JOIN chat_operation_dispositions disposition ON disposition.source_seq = source.source_seq
    WHERE frontier.rowid IN (${placeholders}) AND disposition.source_seq IS NULL
    ORDER BY source.source_seq`)
    .all(...rowIds) as Array<{ source_seq: number; operation_id: string | null }>;
  const selectedMessageKeys = new Set(rows.map((row) => `${row.chat_jid}\u0000${row.id}`));
  const pendingContinuations = db.prepare(`SELECT source.source_seq FROM chat_accepted_sources source
    LEFT JOIN chat_operation_dispositions disposition ON disposition.source_seq = source.source_seq
    WHERE source.source_kind IN ('protected_continuation', 'restart_continuation', 'goal_continuation')
      AND disposition.source_seq IS NULL ORDER BY source.source_seq`)
    .all() as Array<{ source_seq: number }>;
  for (const pending of pendingContinuations) {
    const source = getAcceptedChatSource(pending.source_seq);
    if (!source) continue;
    const root = resolveContinuationRoot(source);
    if (!root?.frontierMessageId || !selectedMessageKeys.has(`${root.chatJid}\u0000${root.frontierMessageId}`)) continue;
    blocked.push({ source_seq: source.sourceSeq, operation_id: source.operationId });
  }

  const missing = Array.from(new Set(missingRootRowIds)).sort((a, b) => a - b);
  const evidence: SecureEraseOperationEvidence[] = operationEvidence.map((item) => ({
    ...item,
    policy: item.terminal_message_row_id === null ? "retained_disposition" : "retained_tombstone",
  }));
  const blockedBySource = new Map(blocked.map((item) => [item.source_seq, item]));
  const blockedRows = Array.from(blockedBySource.values()).sort((a, b) => a.source_seq - b.source_seq);
  const blockedSourceSeqs = blockedRows.map((item) => item.source_seq);
  const blockedOperationIds = Array.from(new Set(blockedRows.map((item) => item.operation_id).filter((id): id is string => Boolean(id)))).sort();
  const scope: SecureEraseConfirmationScope = {
    requestedRoots,
    rowIdentities: rows.map((row) => ({ rowid: row.rowid, chat_jid: row.chat_jid, id: row.id })),
    missingRootRowIds: missing,
    operationEvidence: evidence,
    blockedOperationSourceSeqs: blockedSourceSeqs,
    blockedOperationIds,
  };
  return {
    rows,
    scopeToken: createSecureEraseScopeToken(scope),
    eraseRowIds,
    alreadyErasedRowIds: rows.filter((row) => row.content_erased === 1).map((row) => row.rowid),
    missingRootRowIds: missing,
    operationEvidence: evidence,
    blockedOperationSourceSeqs: blockedSourceSeqs,
    blockedOperationIds,
    affectedMediaIds,
    affectedThinkingRowIds,
    affectedLinkPreviewCacheMediaIds,
    confirmationToken: createSecureEraseConfirmationToken({
      ...scope,
      affectedMediaIds,
      affectedThinkingRowIds,
      affectedLinkPreviewCacheMediaIds,
    }),
  };
}

/** Inspect the exact thread/evidence scope without mutating canonical state. */
export function inspectSecureEraseMessageThreads(roots: SecureEraseMessageRoot[]): SecureEraseMessagePlan {
  const { rows: _rows, scopeToken: _scopeToken, ...plan } = collectSecureErasePlan(roots);
  return plan;
}

/**
 * Atomically replace sensitive message fields with content-free tombstones.
 * Durable operation identities and terminal evidence references stay intact.
 */
export function secureEraseMessageThreads(
  roots: SecureEraseMessageRoot[],
  options: { confirmationToken: string; erasedAt?: string },
): SecureEraseMessageResult {
  const db = getDb();
  const secureDeleteRow = db.prepare("PRAGMA secure_delete").get() as Record<string, number> | undefined;
  const previousSecureDelete = Number(Object.values(secureDeleteRow ?? { secure_delete: 0 })[0] ?? 0);
  db.exec("PRAGMA secure_delete = ON");
  try {
    return db.transaction((): SecureEraseMessageResult => {
      const plan = collectSecureErasePlan(roots);
      const { rows, scopeToken, ...publicPlan } = plan;
      const suppliedToken = options.confirmationToken?.trim() || "";
      const emptyCleanup = {
        erasedMediaIds: [],
        detachedMediaIds: [],
        clearedThinkingRowIds: [],
        clearedLinkPreviewCacheMediaIds: [],
        clearedFtsRowIds: [],
      };
      if (!suppliedToken) {
        return { ...publicPlan, applied: false, erasureId: null, ...emptyCleanup, rejectionReason: "confirmation_required" };
      }
      let replayErasureId: string | null = null;
      if (suppliedToken !== plan.confirmationToken) {
        const priorAudit = db.prepare(`SELECT erasure_id, scope_token FROM message_secure_erasure_audit
          WHERE confirmation_token = ?`).get(suppliedToken) as { erasure_id: string; scope_token: string } | undefined;
        if (!priorAudit || priorAudit.scope_token !== scopeToken || plan.eraseRowIds.length !== 0 || rows.length === 0
          || !rows.every((row) => row.content_erasure_id === priorAudit.erasure_id)) {
          return { ...publicPlan, applied: false, erasureId: null, ...emptyCleanup, rejectionReason: "plan_changed" };
        }
        replayErasureId = priorAudit.erasure_id;
      }
      if (plan.blockedOperationSourceSeqs.length > 0) {
        return { ...publicPlan, applied: false, erasureId: null, ...emptyCleanup, rejectionReason: "unsettled_operation" };
      }
      if (plan.eraseRowIds.length === 0) {
        const existingIds = Array.from(new Set(rows.map((row) => row.content_erasure_id).filter((id): id is string => Boolean(id))));
        return {
          ...publicPlan,
          applied: true,
          erasureId: replayErasureId ?? (existingIds.length === 1 ? existingIds[0] : null),
          ...emptyCleanup,
          rejectionReason: null,
        };
      }

      const erasureId = createUuid("erase");
      const erasedAt = options.erasedAt?.trim() || new Date().toISOString();
      const targetPlaceholders = plan.eraseRowIds.map(() => "?").join(",");
      const attachmentMediaIds = getMediaIdsForMessages(plan.eraseRowIds);
      const thinkingRows = db.prepare(`SELECT message_id FROM thinking_content
        WHERE CAST(message_id AS INTEGER) IN (${targetPlaceholders})`)
        .all(...plan.eraseRowIds) as Array<{ message_id: string }>;
      const clearedThinkingRowIds = Array.from(new Set(thinkingRows
        .map((row) => Number(row.message_id))
        .filter((rowId) => Number.isInteger(rowId) && rowId > 0)))
        .sort((a, b) => a - b);
      const previewMediaIds = Array.from(new Set(
        rows.filter((row) => plan.eraseRowIds.includes(row.rowid)).flatMap((row) => parsePreviewMediaIds(row.link_previews)),
      )).sort((a, b) => a - b);
      const mediaCandidates = Array.from(new Set([...attachmentMediaIds, ...previewMediaIds])).sort((a, b) => a - b);

      db.prepare(`DELETE FROM message_media WHERE message_rowid IN (${targetPlaceholders})`).run(...plan.eraseRowIds);
      db.prepare(`DELETE FROM thinking_content WHERE CAST(message_id AS INTEGER) IN (${targetPlaceholders})`)
        .run(...plan.eraseRowIds);
      db.prepare(`UPDATE messages SET sender = '[erased]', sender_name = '[erased]', content = '',
          screen_hint = NULL, content_blocks = NULL, link_previews = NULL, annotations = NULL,
          content_erased = 1, content_erased_at = ?, content_erasure_id = ?
        WHERE rowid IN (${targetPlaceholders}) AND content_erased = 0`)
        .run(erasedAt, erasureId, ...plan.eraseRowIds);

      const remainingPreviewMediaIds = new Set<number>();
      const remainingPreviews = db.prepare("SELECT link_previews FROM messages WHERE content_erased = 0 AND link_previews IS NOT NULL")
        .all() as Array<{ link_previews: string | null }>;
      for (const row of remainingPreviews) {
        for (const mediaId of parsePreviewMediaIds(row.link_previews)) remainingPreviewMediaIds.add(mediaId);
      }
      const cacheDelete = db.prepare("DELETE FROM link_preview_image_cache WHERE media_id = ?");
      const clearedLinkPreviewCacheMediaIds: number[] = [];
      for (const mediaId of previewMediaIds) {
        if (remainingPreviewMediaIds.has(mediaId)) continue;
        if (cacheDelete.run(mediaId).changes > 0) clearedLinkPreviewCacheMediaIds.push(mediaId);
      }

      const deletableMediaCandidates = mediaCandidates.filter((mediaId) => !remainingPreviewMediaIds.has(mediaId));
      deleteUnreferencedMedia(deletableMediaCandidates);
      const remainingMediaIds = new Set<number>();
      if (mediaCandidates.length > 0) {
        const mediaPlaceholders = mediaCandidates.map(() => "?").join(",");
        const remaining = db.prepare(`SELECT id FROM media WHERE id IN (${mediaPlaceholders})`).all(...mediaCandidates) as Array<{ id: number }>;
        for (const row of remaining) remainingMediaIds.add(row.id);
      }
      const erasedMediaIds = mediaCandidates.filter((id) => !remainingMediaIds.has(id));

      rebuildMessagesFtsWithMedia();
      const affectedEvidence = plan.operationEvidence.filter((item) =>
        (item.frontier_message_row_id !== null && plan.eraseRowIds.includes(item.frontier_message_row_id))
        || (item.terminal_message_row_id !== null && plan.eraseRowIds.includes(item.terminal_message_row_id)));
      db.prepare(`INSERT INTO message_secure_erasure_audit
        (erasure_id, created_at, actor, policy, confirmation_token, scope_token,
         erased_row_ids_json, operation_source_seqs_json, operation_ids_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          erasureId,
          erasedAt,
          "workspace_owner",
          "retained_tombstone_v1",
          suppliedToken,
          scopeToken,
          JSON.stringify(plan.eraseRowIds),
          JSON.stringify(affectedEvidence.map((item) => item.source_seq)),
          JSON.stringify(Array.from(new Set(affectedEvidence.map((item) => item.operation_id))).sort()),
        );

      return {
        ...publicPlan,
        applied: true,
        erasureId,
        erasedMediaIds,
        detachedMediaIds: attachmentMediaIds,
        clearedThinkingRowIds,
        clearedLinkPreviewCacheMediaIds,
        clearedFtsRowIds: plan.eraseRowIds,
        rejectionReason: null,
      };
    }).immediate();
  } finally {
    db.exec(`PRAGMA secure_delete = ${previousSecureDelete}`);
  }
}
