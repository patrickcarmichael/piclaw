import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createTempWorkspace, importFresh, setEnv } from "../helpers.js";

let restoreEnv: (() => void) | null = null;

describe("messages secure_delete", () => {
  let ws: ReturnType<typeof createTempWorkspace>;
  let db: typeof import("../../src/db.js");
  let messages: typeof import("../../src/extensions/messages-crud.js");
  let chatJid: string;

  beforeEach(async () => {
    ws = createTempWorkspace("piclaw-messages-secure-delete-");
    chatJid = `web:secure-delete-${Math.random().toString(36).slice(2, 10)}`;
    restoreEnv = setEnv({
      PICLAW_WORKSPACE: ws.workspace,
      PICLAW_STORE: ws.store,
      PICLAW_DATA: ws.data,
      PICLAW_DB_IN_MEMORY: "1",
      PICLAW_SEARCH_MATCH_MODE: "and",
    });
    db = await importFresh<typeof import("../src/db.js")>("../src/db.js");
    messages = await importFresh<typeof import("../src/extensions/messages-crud.js")>("../src/extensions/messages-crud.js");
    db.initDatabase();
    db.storeChatMetadata(chatJid, "2026-08-10T02:00:00.000Z", "Secure delete test");
  });

  afterEach(() => {
    restoreEnv?.();
    restoreEnv = null;
    ws.cleanup();
  });

  function runTool(params: Record<string, unknown>, activeChat = chatJid, ownerAuthorized = activeChat.startsWith("web:")) {
    return messages.runMessagesTool(params as any, activeChat, undefined, {
      ownerAuthorizedWebSession: ownerAuthorized,
    });
  }

  function acceptedUserMessage(id: string, content: string, extra: Record<string, unknown> = {}) {
    const timestamp = "2026-08-10T02:00:01.000Z";
    let rowId = 0;
    let source: ReturnType<typeof db.registerAcceptedChatSource>["source"] | null = null;
    db.getDb().transaction(() => {
      rowId = db.storeMessage({
        id,
        chat_jid: chatJid,
        sender: "sensitive-user@example.invalid",
        sender_name: "Sensitive User",
        content,
        timestamp,
        is_from_me: false,
        is_bot_message: false,
        ...extra,
      });
      source = db.registerAcceptedChatSource({
        chatJid,
        sourceClass: "prompt",
        sourceKind: "message",
        sourceId: id,
        acceptedAt: timestamp,
        payloadRef: `message:${id}`,
        frontier: { messageId: id, cursorTs: timestamp },
      }).source;
    })();
    if (!source) throw new Error("expected accepted source");
    return { rowId, source };
  }

  function completeWithTerminalReply(source: ReturnType<typeof acceptedUserMessage>["source"], rootRowId: number, secret: string) {
    const claimed = db.claimNextChatOperation(chatJid).operation;
    if (!claimed) throw new Error("expected claimed operation");
    const completion = db.completeChatOperation(chatJid, {
      owner: {
        operationId: claimed.operationId,
        sourceSeq: claimed.sourceSeq,
        phase: claimed.phase,
        generation: claimed.generation,
      },
      outcome: "succeeded",
      cause: "normal",
      provenance: "secure_delete_test",
      createdAt: "2026-08-10T02:00:03.000Z",
      artifact: {
        message: {
          id: `reply-${source.sourceSeq}`,
          chat_jid: chatJid,
          sender: "bot",
          sender_name: "Pi",
          content: secret,
          thread_id: rootRowId,
          timestamp: "2026-08-10T02:00:02.000Z",
          is_from_me: true,
          is_bot_message: true,
          is_terminal_agent_reply: true,
        },
      },
    });
    expect(completion.status).toBe("completed");
    const reply = db.getDb().prepare("SELECT rowid, id FROM messages WHERE operation_id = ?")
      .get(claimed.operationId) as { rowid: number; id: string };
    return { claimed, reply };
  }

  test("rejects secure erase outside an owner-authorized web session", () => {
    const { rowId } = acceptedUserMessage("non-owner-root", "non-owner-secret-946");
    const rejected = runTool({
      action: "secure_delete",
      chat_jid: chatJid,
      row_ids: [rowId],
      dry_run: true,
    } as any, "whatsapp:untrusted-caller");
    expect(rejected.details).toMatchObject({
      applied: false,
      error: "owner_authorization_required",
      requires_confirmation: true,
    });
    expect((db.getDb().prepare("SELECT content FROM messages WHERE rowid = ?").get(rowId) as any).content)
      .toBe("non-owner-secret-946");
  });

  test("requires an explicit plan confirmation and securely tombstones a protected thread without content copies", () => {
    const rootSecret = "credential-root-946";
    const replySecret = "credential-reply-946";
    const attachmentSecret = "credential-attachment-946";
    const previewSecretUrl = "https://secret.example.invalid/private-token-946.png";
    expect(db.getDb().prepare("SELECT v FROM messages_fts_config WHERE k = 'secure-delete'").get()).toEqual({ v: 1 });
    const { rowId: rootRowId, source } = acceptedUserMessage("secure-root", rootSecret, {
      screen_hint: "private-screen",
      content_blocks: [{ type: "TextBlock", text: rootSecret }],
      link_previews: [{ url: "https://secret.example.invalid/private-946", title: rootSecret }],
    });
    db.getDb().prepare("UPDATE messages SET annotations = ? WHERE chat_jid = ? AND rowid = ?")
      .run(JSON.stringify([{ text: rootSecret }]), chatJid, rootRowId);
    db.getDb().prepare(`INSERT INTO thinking_content (message_id, text, lines, duration_ms, model, truncated)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(String(rootRowId), rootSecret, 1, 1, null, 0);

    const attachmentId = db.createMedia(
      "credential-946.txt",
      "text/plain",
      new TextEncoder().encode(attachmentSecret),
      null,
      { source: rootSecret },
    );
    db.attachMediaToMessage(rootRowId, [attachmentId]);

    const previewMediaId = db.createMedia(
      "private-token-946.webp",
      "image/webp",
      new Uint8Array([1, 2, 3]),
      null,
      { source_url: previewSecretUrl },
    );
    db.getDb().prepare(`INSERT INTO link_preview_image_cache
      (source_url, media_id, fetched_at, expires_at, last_used_at) VALUES (?, ?, ?, ?, ?)`)
      .run(previewSecretUrl, previewMediaId, "now", "later", "now");
    db.getDb().prepare("UPDATE messages SET link_previews = ? WHERE chat_jid = ? AND rowid = ?")
      .run(JSON.stringify([{
        url: "https://secret.example.invalid/private-946",
        title: rootSecret,
        image: `/media/${previewMediaId}`,
      }]), chatJid, rootRowId);

    const { claimed, reply } = completeWithTerminalReply(source, rootRowId, replySecret);
    const nonCanonicalThinkingId = `000${reply.rowid}`;
    db.getDb().prepare(`INSERT INTO thinking_content (message_id, text, lines, duration_ms)
      VALUES (?, ?, 1, 1)`).run(nonCanonicalThinkingId, replySecret);
    expect(() => db.deleteThreadByRowId(chatJid, rootRowId)).toThrow("Terminal operation evidence");
    expect(() => runTool({
      action: "delete",
      chat_jid: chatJid,
      row_ids: [rootRowId],
      force: true,
    } as any, chatJid)).toThrow("Terminal operation evidence");

    const plan = runTool({
      action: "secure_delete",
      chat_jid: chatJid,
      row_ids: [rootRowId],
      dry_run: true,
    } as any, chatJid);
    expect(plan.details).toMatchObject({
      action: "secure_delete",
      dry_run: true,
      requires_confirmation: true,
      erase_row_ids: expect.arrayContaining([rootRowId, reply.rowid]),
      operation_evidence: [expect.objectContaining({
        source_seq: source.sourceSeq,
        operation_id: claimed.operationId,
        terminal_message_row_id: reply.rowid,
        policy: "retained_tombstone",
      })],
      affected_media_ids: expect.arrayContaining([attachmentId, previewMediaId]),
      affected_thinking_row_ids: [rootRowId, reply.rowid].sort((a, b) => a - b),
      affected_link_preview_cache_media_ids: [previewMediaId],
    });
    expect(plan.details.confirmation_token).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(plan.details)).not.toContain(rootSecret);
    expect(JSON.stringify(plan.details)).not.toContain(replySecret);

    const unauthorizedWithToken = runTool({
      action: "secure_delete",
      chat_jid: chatJid,
      row_ids: [rootRowId],
      dry_run: false,
      confirmation: "ERASE",
      confirmation_token: plan.details.confirmation_token,
    }, chatJid, false);
    expect(unauthorizedWithToken.details).toMatchObject({
      applied: false,
      error: "owner_authorization_required",
    });

    const unconfirmed = runTool({
      action: "secure_delete",
      chat_jid: chatJid,
      row_ids: [rootRowId],
      dry_run: false,
      confirmation: "ERASE",
    } as any, chatJid);
    expect(unconfirmed.details).toMatchObject({
      applied: false,
      requires_confirmation: true,
      rejection_reason: "confirmation_required",
    });
    expect((db.getDb().prepare("SELECT content FROM messages WHERE rowid = ?").get(rootRowId) as any).content).toBe(rootSecret);

    const erased = runTool({
      action: "secure_delete",
      chat_jid: chatJid,
      row_ids: [rootRowId],
      dry_run: false,
      confirmation: "ERASE",
      confirmation_token: plan.details.confirmation_token,
    } as any, chatJid);
    expect(erased.details).toMatchObject({
      action: "secure_delete",
      applied: true,
      erased_row_ids: expect.arrayContaining([rootRowId, reply.rowid]),
      erased_media_ids: expect.arrayContaining([attachmentId, previewMediaId]),
      detached_media_ids: [attachmentId],
      cleared_thinking_row_ids: [rootRowId, reply.rowid].sort((a, b) => a - b),
      cleared_link_preview_cache_media_ids: [previewMediaId],
      cleared_fts_row_ids: expect.arrayContaining([rootRowId, reply.rowid]),
    });

    const rows = db.getDb().prepare(`SELECT rowid, sender, sender_name, content, screen_hint, content_blocks,
      link_previews, annotations, content_erased, content_erased_at, content_erasure_id
      FROM messages WHERE rowid IN (?, ?) ORDER BY rowid`).all(rootRowId, reply.rowid) as any[];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({
        sender: "[erased]",
        sender_name: "[erased]",
        content: "",
        screen_hint: null,
        content_blocks: null,
        link_previews: null,
        annotations: null,
        content_erased: 1,
      });
      expect(row.content_erased_at).toBeTruthy();
      expect(row.content_erasure_id).toBe(erased.details.erasure_id);
    }

    expect(db.getDb().prepare("SELECT 1 FROM thinking_content WHERE CAST(message_id AS INTEGER) IN (?, ?)")
      .all(rootRowId, reply.rowid)).toEqual([]);
    expect(db.getMediaById(attachmentId)).toBeUndefined();
    expect(db.getMediaById(previewMediaId)).toBeUndefined();
    expect(db.getDb().prepare("SELECT 1 FROM link_preview_image_cache WHERE media_id = ?").get(previewMediaId)).toBeNull();
    for (const secret of [rootSecret, replySecret, attachmentSecret]) {
      expect(db.getDb().prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").all(JSON.stringify(secret))).toEqual([]);
    }

    expect(db.getChatOperationDisposition(source.sourceSeq)).toMatchObject({
      terminalMessageId: reply.id,
      operationId: claimed.operationId,
    });
    expect(db.getTimeline(chatJid, 20).every((item: any) => item.data.content_erased === true && item.data.content === "")).toBe(true);
    const persisted = JSON.stringify({
      messages: db.getDb().prepare("SELECT * FROM messages WHERE chat_jid = ?").all(chatJid),
      dispositions: db.getDb().prepare("SELECT * FROM chat_operation_dispositions WHERE chat_jid = ?").all(chatJid),
      audit: db.getDb().prepare("SELECT * FROM message_secure_erasure_audit").all(),
    });
    for (const secret of [rootSecret, replySecret, attachmentSecret, previewSecretUrl]) {
      expect(persisted).not.toContain(secret);
    }
    expect(() => db.getDb().prepare("UPDATE message_secure_erasure_audit SET actor = 'changed'").run())
      .toThrow("secure erasure audit is immutable");
    expect(() => db.getDb().prepare("DELETE FROM message_secure_erasure_audit").run())
      .toThrow("secure erasure audit is immutable");
    expect(() => db.deleteMessageByRowId(chatJid, rootRowId)).toThrow("securely erased message tombstone");
    expect(() => db.getDb().prepare("UPDATE messages SET id = 'moved-erased-root' WHERE rowid = ?").run(rootRowId))
      .toThrow("securely erased message content is immutable");
    const postEraseMediaId = db.createMedia(
      "post-erase.txt",
      "text/plain",
      new TextEncoder().encode("posteraseattachmentsecret946"),
      null,
      null,
    );
    expect(() => db.attachMediaToMessage(rootRowId, [postEraseMediaId]))
      .toThrow("securely erased message tombstone cannot receive media");
    expect(db.getMediaIdsForMessage(rootRowId)).toEqual([]);
    expect(db.getDb().prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?")
      .all("posteraseattachmentsecret946")).toEqual([]);
    expect(() => db.getDb().prepare(`INSERT INTO thinking_content
      (message_id, text, lines, duration_ms) VALUES (?, ?, 1, 1)`)
      .run(`000${rootRowId}`, "post-erase-thinking-secret-946"))
      .toThrow("securely erased message tombstone cannot receive thinking content");
    expect(db.getDb().prepare("SELECT message_id FROM thinking_content WHERE CAST(message_id AS INTEGER) = ?")
      .get(rootRowId)).toBeNull();
    db.deleteUnreferencedMedia([postEraseMediaId]);
    expect(() => db.storeMessage({
      id: "secure-root",
      chat_jid: chatJid,
      sender: "sensitive-user@example.invalid",
      sender_name: "Sensitive User",
      content: rootSecret,
      timestamp: "2026-08-10T02:00:04.000Z",
      is_from_me: false,
      is_bot_message: false,
    })).toThrow("securely erased");
    expect(() => db.storeMessage({
      id: reply.id,
      chat_jid: chatJid,
      sender: "bot",
      sender_name: "Pi",
      content: replySecret,
      thread_id: rootRowId,
      timestamp: "2026-08-10T02:00:04.000Z",
      is_from_me: true,
      is_bot_message: true,
      is_terminal_agent_reply: true,
      operation_id: claimed.operationId,
    })).toThrow("securely erased");
  });

  test("rolls back every erasure write on failure and is idempotent after success", () => {
    const rootSecret = "rollback-root-946";
    const replySecret = "rollback-reply-946";
    const { rowId: rootRowId, source } = acceptedUserMessage("rollback-root", rootSecret);
    const { reply } = completeWithTerminalReply(source, rootRowId, replySecret);
    db.getDb().exec(`CREATE TRIGGER reject_secure_erasure_audit BEFORE INSERT ON message_secure_erasure_audit
      BEGIN SELECT RAISE(ABORT, 'test secure erase rollback'); END`);
    const plan = runTool({
      action: "secure_delete",
      chat_jid: chatJid,
      row_ids: [rootRowId],
      dry_run: true,
    } as any, chatJid);

    expect(() => runTool({
      action: "secure_delete",
      chat_jid: chatJid,
      row_ids: [rootRowId],
      dry_run: false,
      confirmation: "ERASE",
      confirmation_token: plan.details.confirmation_token,
    } as any, chatJid)).toThrow("test secure erase rollback");
    expect((db.getDb().prepare("SELECT content, content_erased FROM messages WHERE rowid = ?").get(rootRowId) as any))
      .toEqual({ content: rootSecret, content_erased: 0 });
    expect((db.getDb().prepare("SELECT content, content_erased FROM messages WHERE rowid = ?").get(reply.rowid) as any))
      .toEqual({ content: replySecret, content_erased: 0 });
    expect(db.getDb().prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").all(JSON.stringify(rootSecret))).toHaveLength(1);

    db.getDb().exec("DROP TRIGGER reject_secure_erasure_audit");
    const first = runTool({
      action: "secure_delete",
      chat_jid: chatJid,
      row_ids: [rootRowId],
      dry_run: false,
      confirmation: "ERASE",
      confirmation_token: plan.details.confirmation_token,
    } as any, chatJid);
    const subsetReplay = runTool({
      action: "secure_delete",
      chat_jid: chatJid,
      row_ids: [reply.rowid],
      dry_run: false,
      confirmation: "ERASE",
      confirmation_token: plan.details.confirmation_token,
    } as any, chatJid);
    expect(subsetReplay.details).toMatchObject({ applied: false, rejection_reason: "plan_changed" });
    const second = runTool({
      action: "secure_delete",
      chat_jid: chatJid,
      row_ids: [rootRowId],
      dry_run: false,
      confirmation: "ERASE",
      confirmation_token: plan.details.confirmation_token,
    } as any, chatJid);
    expect(first.details.erased_row_ids).toEqual([rootRowId, reply.rowid]);
    expect(second.details).toMatchObject({
      applied: true,
      erased_row_ids: [],
      already_erased_row_ids: [rootRowId, reply.rowid],
      erasure_id: first.details.erasure_id,
    });
    expect(db.getDb().prepare("SELECT COUNT(*) AS count FROM message_secure_erasure_audit").get()).toEqual({ count: 1 });
  });

  test("preserves a shared preview cache entry referenced by a surviving message", () => {
    const { rowId: rootRowId, source } = acceptedUserMessage("shared-preview-root", "shared-preview-secret-946");
    completeWithTerminalReply(source, rootRowId, "shared-preview-reply-946");
    const survivorRowId = db.storeMessage({
      id: "shared-preview-survivor",
      chat_jid: chatJid,
      sender: "user",
      sender_name: "Alice",
      content: "surviving message",
      timestamp: "2026-08-10T02:00:06.000Z",
      is_from_me: false,
      is_bot_message: false,
    });
    const mediaId = db.createMedia("shared.webp", "image/webp", new Uint8Array([9, 4, 6]), null, null);
    const sourceUrl = "https://shared.example.invalid/preview.webp";
    db.getDb().prepare(`INSERT INTO link_preview_image_cache
      (source_url, media_id, fetched_at, expires_at, last_used_at) VALUES (?, ?, ?, ?, ?)`)
      .run(sourceUrl, mediaId, "now", "later", "now");
    const previews = JSON.stringify([{ url: sourceUrl, image: `/media/${mediaId}` }]);
    db.getDb().prepare("UPDATE messages SET link_previews = ? WHERE rowid IN (?, ?)")
      .run(previews, rootRowId, survivorRowId);

    const plan = runTool({
      action: "secure_delete",
      chat_jid: chatJid,
      row_ids: [rootRowId],
      dry_run: true,
    }, chatJid);
    const erased = runTool({
      action: "secure_delete",
      chat_jid: chatJid,
      row_ids: [rootRowId],
      dry_run: false,
      confirmation: "ERASE",
      confirmation_token: plan.details.confirmation_token,
    }, chatJid);
    expect(erased.details).toMatchObject({
      applied: true,
      cleared_link_preview_cache_media_ids: [],
    });
    expect(db.getMediaById(mediaId)).toBeDefined();
    expect(db.getDb().prepare("SELECT media_id FROM link_preview_image_cache WHERE media_id = ?").get(mediaId))
      .toEqual({ media_id: mediaId });
  });

  test("invalidates a confirmed plan when cleanup scope changes", () => {
    const { rowId: rootRowId, source } = acceptedUserMessage("scope-root", "scope-root-secret-946");
    completeWithTerminalReply(source, rootRowId, "scope-reply-secret-946");
    const stalePlan = runTool({
      action: "secure_delete",
      chat_jid: chatJid,
      row_ids: [rootRowId],
      dry_run: true,
    } as any, chatJid);

    const lateMediaId = db.createMedia(
      "late-secret.txt",
      "text/plain",
      new TextEncoder().encode("late-media-secret-946"),
    );
    db.attachMediaToMessage(rootRowId, [lateMediaId]);
    db.getDb().prepare(`INSERT INTO thinking_content (message_id, text, lines, duration_ms, model, truncated)
      VALUES (?, ?, ?, ?, ?, ?)`).run(String(rootRowId), "late-thinking-secret-946", 1, 1, null, 0);

    const stale = runTool({
      action: "secure_delete",
      chat_jid: chatJid,
      row_ids: [rootRowId],
      dry_run: false,
      confirmation: "ERASE",
      confirmation_token: stalePlan.details.confirmation_token,
    } as any, chatJid);
    expect(stale.details).toMatchObject({ applied: false, rejection_reason: "plan_changed" });
    expect(db.getMediaById(lateMediaId)).toBeDefined();
    expect(db.getDb().prepare("SELECT 1 FROM thinking_content WHERE message_id = ?").get(String(rootRowId))).not.toBeNull();

    const currentPlan = runTool({
      action: "secure_delete",
      chat_jid: chatJid,
      row_ids: [rootRowId],
      dry_run: true,
    } as any, chatJid);
    expect(currentPlan.details).toMatchObject({
      affected_media_ids: [lateMediaId],
      affected_thinking_row_ids: [rootRowId],
    });
    const erased = runTool({
      action: "secure_delete",
      chat_jid: chatJid,
      row_ids: [rootRowId],
      dry_run: false,
      confirmation: "ERASE",
      confirmation_token: currentPlan.details.confirmation_token,
    } as any, chatJid);
    expect(erased.details.applied).toBe(true);
    expect(db.getMediaById(lateMediaId)).toBeUndefined();
    expect(db.getDb().prepare("SELECT 1 FROM thinking_content WHERE message_id = ?").get(String(rootRowId))).toBeNull();
  });

  for (const continuationKind of ["restart_continuation", "goal_continuation"] as const) {
    test(`blocks a pending ${continuationKind} rooted at the selected message`, () => {
      const { rowId: rootRowId, source } = acceptedUserMessage(`${continuationKind}-root`, `${continuationKind}-secret-946`);
      completeWithTerminalReply(source, rootRowId, `${continuationKind}-reply-secret-946`);
      const lineage = {
        rootSourceSeq: source.sourceSeq,
        parentSourceSeq: source.sourceSeq,
        parentGeneration: 0,
        generation: 1,
        goalId: "goal-secure-delete",
        checkpointId: "checkpoint-secure-delete",
        oldTurnId: "turn-secure-delete",
      };
      const sourceId = continuationKind === "restart_continuation"
        ? `source:${source.sourceSeq}`
        : `goal:${source.sourceSeq}:1`;
      const payloadRef = continuationKind === "restart_continuation"
        ? `accepted-source:${source.sourceSeq}`
        : `goal-continuation:${JSON.stringify(lineage)}`;
      const inserted = db.getDb().prepare(`INSERT INTO chat_accepted_sources
        (chat_jid, source_class, source_kind, source_id, accepted_at, selectable, payload_ref,
         frontier_message_id, frontier_cursor_ts, operation_id)
        VALUES (?, 'prompt', ?, ?, ?, 1, ?, NULL, NULL, NULL)`)
        .run(chatJid, continuationKind, sourceId, "2026-08-10T02:00:04.000Z", payloadRef);
      const continuationSourceSeq = Number(inserted.lastInsertRowid);

      const plan = runTool({
        action: "secure_delete",
        chat_jid: chatJid,
        row_ids: [rootRowId],
        dry_run: true,
      } as any, chatJid);
      expect(plan.details.blocked_operation_source_seqs).toContain(continuationSourceSeq);
      const blocked = runTool({
        action: "secure_delete",
        chat_jid: chatJid,
        row_ids: [rootRowId],
        dry_run: false,
        confirmation: "ERASE",
        confirmation_token: plan.details.confirmation_token,
      } as any, chatJid);
      expect(blocked.details).toMatchObject({ applied: false, rejection_reason: "unsettled_operation" });
    });
  }

  test("audits settled internal operation evidence that has no terminal message", () => {
    const { rowId: rootRowId, source } = acceptedUserMessage("internal-root", "internal-root-secret-946");
    const claimed = db.claimNextChatOperation(chatJid).operation;
    if (!claimed) throw new Error("expected claimed operation");
    expect(db.completeChatOperation(chatJid, {
      owner: {
        operationId: claimed.operationId,
        sourceSeq: claimed.sourceSeq,
        phase: claimed.phase,
        generation: claimed.generation,
      },
      outcome: "interrupted",
      cause: "protected_recovery_continuation_registered",
      provenance: "secure_delete_internal_test",
      createdAt: "2026-08-10T02:00:03.000Z",
      artifact: { internal: { kind: "protected_recovery_scheduled" } },
      successor: { sourceKind: "protected_continuation", rootSourceSeq: source.sourceSeq },
    }).status).toBe("completed");
    const pendingSuccessor = db.peekNextAcceptedChatSource(chatJid);
    if (!pendingSuccessor) throw new Error("expected pending successor source");
    const blockedPlan = runTool({
      action: "secure_delete",
      chat_jid: chatJid,
      row_ids: [rootRowId],
      dry_run: true,
    } as any, chatJid);
    expect(blockedPlan.details.blocked_operation_source_seqs).toContain(pendingSuccessor.sourceSeq);
    const blocked = runTool({
      action: "secure_delete",
      chat_jid: chatJid,
      row_ids: [rootRowId],
      dry_run: false,
      confirmation: "ERASE",
      confirmation_token: blockedPlan.details.confirmation_token,
    } as any, chatJid);
    expect(blocked.details).toMatchObject({ applied: false, rejection_reason: "unsettled_operation" });

    const successor = db.claimNextChatOperation(chatJid).operation;
    if (!successor) throw new Error("expected successor operation");
    expect(db.completeChatOperation(chatJid, {
      owner: {
        operationId: successor.operationId,
        sourceSeq: successor.sourceSeq,
        phase: successor.phase,
        generation: successor.generation,
      },
      outcome: "succeeded",
      cause: "normal",
      provenance: "secure_delete_internal_successor_test",
      createdAt: "2026-08-10T02:00:04.000Z",
      artifact: {
        message: {
          id: "internal-successor-reply",
          chat_jid: chatJid,
          sender: "bot",
          sender_name: "Pi",
          content: "internal successor secret",
          thread_id: null,
          timestamp: "2026-08-10T02:00:04.000Z",
          is_from_me: true,
          is_bot_message: true,
          is_terminal_agent_reply: true,
        },
      },
    }).status).toBe("completed");
    const successorReply = db.getDb().prepare("SELECT rowid FROM messages WHERE operation_id = ?")
      .get(successor.operationId) as { rowid: number };

    const plan = runTool({
      action: "secure_delete",
      chat_jid: chatJid,
      row_ids: [rootRowId],
      dry_run: true,
    } as any, chatJid);
    expect(plan.details.erase_row_ids).toContain(successorReply.rowid);
    expect(plan.details.operation_evidence).toEqual(expect.arrayContaining([expect.objectContaining({
      source_seq: source.sourceSeq,
      operation_id: claimed.operationId,
      frontier_message_row_id: rootRowId,
      terminal_message_row_id: null,
      policy: "retained_disposition",
    })]));

    const erased = runTool({
      action: "secure_delete",
      chat_jid: chatJid,
      row_ids: [rootRowId],
      dry_run: false,
      confirmation: "ERASE",
      confirmation_token: plan.details.confirmation_token,
    } as any, chatJid);
    expect(erased.details.applied).toBe(true);
    expect((db.getDb().prepare("SELECT content_erased, content FROM messages WHERE rowid = ?")
      .get(successorReply.rowid) as any)).toEqual({ content_erased: 1, content: "" });
    const audit = db.getDb().prepare(`SELECT operation_source_seqs_json, operation_ids_json
      FROM message_secure_erasure_audit WHERE erasure_id = ?`).get(erased.details.erasure_id) as any;
    expect(JSON.parse(audit.operation_source_seqs_json)).toContain(source.sourceSeq);
    expect(JSON.parse(audit.operation_ids_json)).toContain(claimed.operationId);
    expect(db.getChatOperationDisposition(source.sourceSeq)).toMatchObject({
      operationId: claimed.operationId,
      internalArtifactKind: "protected_recovery_scheduled",
      terminalMessageId: null,
    });
  });

  test("rejects a frontier with unsettled work, then succeeds after atomic operation settlement", () => {
    const secret = "active-operation-secret-946";
    const { rowId: rootRowId, source } = acceptedUserMessage("active-root", secret);
    const claimed = db.claimNextChatOperation(chatJid).operation;
    if (!claimed) throw new Error("expected claimed operation");

    const blockedPlan = runTool({
      action: "secure_delete",
      chat_jid: chatJid,
      row_ids: [rootRowId],
      dry_run: true,
    } as any, chatJid);
    const blocked = runTool({
      action: "secure_delete",
      chat_jid: chatJid,
      row_ids: [rootRowId],
      dry_run: false,
      confirmation: "ERASE",
      confirmation_token: blockedPlan.details.confirmation_token,
    } as any, chatJid);
    expect(blocked.details).toMatchObject({
      applied: false,
      blocked_operation_source_seqs: [source.sourceSeq],
      blocked_operation_ids: [claimed.operationId],
    });
    expect((db.getDb().prepare("SELECT content, content_erased FROM messages WHERE rowid = ?").get(rootRowId) as any))
      .toEqual({ content: secret, content_erased: 0 });

    expect(db.completeChatOperation(chatJid, {
      owner: {
        operationId: claimed.operationId,
        sourceSeq: claimed.sourceSeq,
        phase: claimed.phase,
        generation: claimed.generation,
      },
      outcome: "succeeded",
      cause: "normal",
      provenance: "secure_delete_settlement_test",
      createdAt: "2026-08-10T02:00:03.000Z",
      artifact: {
        message: {
          id: "active-reply",
          chat_jid: chatJid,
          sender: "bot",
          sender_name: "Pi",
          content: "settled reply secret",
          thread_id: rootRowId,
          timestamp: "2026-08-10T02:00:02.000Z",
          is_from_me: true,
          is_bot_message: true,
          is_terminal_agent_reply: true,
        },
      },
    }).status).toBe("completed");

    const stale = runTool({
      action: "secure_delete",
      chat_jid: chatJid,
      row_ids: [rootRowId],
      dry_run: false,
      confirmation: "ERASE",
      confirmation_token: blockedPlan.details.confirmation_token,
    } as any, chatJid);
    expect(stale.details).toMatchObject({ applied: false, rejection_reason: "plan_changed" });

    const settledPlan = runTool({
      action: "secure_delete",
      chat_jid: chatJid,
      row_ids: [rootRowId],
      dry_run: true,
    } as any, chatJid);
    const erased = runTool({
      action: "secure_delete",
      chat_jid: chatJid,
      row_ids: [rootRowId],
      dry_run: false,
      confirmation: "ERASE",
      confirmation_token: settledPlan.details.confirmation_token,
    } as any, chatJid);
    expect(erased.details.applied).toBe(true);
    expect(erased.details.erased_row_ids).toHaveLength(2);
  });
});
