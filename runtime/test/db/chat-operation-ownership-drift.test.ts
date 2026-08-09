import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const sourceRoot = resolve(import.meta.dir, "../../src");

function sqlStatements(source: string): string[] {
  const statements: string[] = [];
  for (const match of source.matchAll(/`([^`]*\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+chat_cursors\b[^`]*)`/gi)) {
    statements.push(match[1].replace(/\s+/g, " ").trim());
  }
  for (const match of source.matchAll(/["']([^"'\n]*\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+chat_cursors\b[^"'\n]*)["']/gi)) {
    statements.push(match[1].replace(/\s+/g, " ").trim());
  }
  return statements;
}

function sourceSqlInventory(): Array<{ file: string; sql: string }> {
  const inventory: Array<{ file: string; sql: string }> = [];
  for (const path of new Bun.Glob("**/*.ts").scanSync({ cwd: sourceRoot, absolute: true })) {
    const file = relative(sourceRoot, path).replaceAll("\\", "/");
    for (const sql of sqlStatements(readFileSync(path, "utf8"))) inventory.push({ file, sql });
  }
  return inventory;
}

describe("chat operation ownership drift", () => {
  test("keeps operation-column DML inside the shared CAS module", () => {
    const directOperationWrites = sourceSqlInventory()
      .filter(({ sql }) => /\boperation_(?:id|source_|phase|generation|cancel_)/i.test(sql))
      .map(({ file }) => file);

    expect(new Set(directOperationWrites)).toEqual(new Set(["db/chat-operations.ts", "db/chat-operation-lifecycle.ts"]));
  });

  test("inventories every cursor update, delete and rename path", () => {
    const counts = new Map<string, number>();
    for (const { file, sql } of sourceSqlInventory()) {
      if (!/^(?:UPDATE|DELETE\s+FROM)\s+chat_cursors\b/i.test(sql)) continue;
      counts.set(file, (counts.get(file) ?? 0) + 1);
    }
    expect(Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)))).toEqual({
      "db/chat-branches.ts": 5,
      "db/chat-cursors.ts": 15,
      "db/chat-operation-lifecycle.ts": 1,
      "db/chat-operations.ts": 5,
      "dream.ts": 3,
    });
  });

  test("snapshots legacy cursor and owner clearing SQL until each bridge is deleted", () => {
    const counts = new Map<string, number>();
    for (const { file, sql } of sourceSqlInventory()) {
      if (!/^(?:UPDATE|DELETE\s+FROM)\s+chat_cursors\b/i.test(sql)) continue;
      if (!/\b(?:cursor_ts|preflight_|inflight_|failed_)/i.test(sql)) continue;
      if (!/(?:=\s*NULL|cursor_ts\s*=|DELETE\s+FROM\s+chat_cursors)/i.test(sql)) continue;
      counts.set(file, (counts.get(file) ?? 0) + 1);
    }

    expect(Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)))).toEqual({
      "db/chat-cursors.ts": 13,
      "db/chat-operations.ts": 1,
    });
  });

  test("names the legacy ownership bridge scheduled for deletion", () => {
    const source = readFileSync(resolve(sourceRoot, "db/chat-cursors.ts"), "utf8");
    const legacyMutators = [
      "beginChatPreflight", "clearChatPreflight", "blockChatPreflightOwned", "promoteChatPreflightToInflight", "beginChatRun",
      "endChatRun", "endChatRunWithError", "clearFailedRun", "rollbackChatRunWithError",
      "rollbackInflightRun", "rollbackInflightRunForCompactionConflict", "clearInflightMarker",
      "markChatCompactionActive", "clearChatCompactionActive", "setChatCursor",
    ];
    for (const name of legacyMutators) expect(source).toContain(`function ${name}`);
  });

  test("keeps accepted-source and disposition writes in the operation module or explicit chat lifecycle", () => {
    const offenders: string[] = [];
    for (const path of new Bun.Glob("**/*.ts").scanSync({ cwd: sourceRoot, absolute: true })) {
      const file = relative(sourceRoot, path).replaceAll("\\", "/");
      const source = readFileSync(path, "utf8");
      if (!/(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+chat_(?:accepted_sources|operation_dispositions)/i.test(source)) continue;
      if (!["db/chat-operations.ts", "db/chat-operation-lifecycle.ts", "db/chat-branches.ts", "db/connection.ts"].includes(file)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
