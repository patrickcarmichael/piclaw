import { beforeEach, describe, expect, test } from "bun:test";

import "../helpers.js";

import { rememberActiveToolSubset } from "../../src/agent-pool/active-tool-subset-memory.js";
import { createAttemptToolBudgetController } from "../../src/agent-pool/run-agent-attempt-budget.js";
import {
  clearMutationQuarantine,
  getMutationQuarantine,
} from "../../src/agent-pool/mutation-quarantine.js";
import {
  createMutationFingerprint,
  getToolSafetyPolicy,
  keychainToolSafetyPolicy,
  withToolSafetyPolicy,
} from "../../src/agent-pool/tool-safety-policy.js";
import { initDatabase } from "../../src/db.js";

const SENSITIVE_CANARY = "synthetic-sensitive-canary-935";

function createSession(chatJid: string, mutationRepetitionLimit = 2) {
  let activeTools = ["keychain"];
  const keychainDefinition = withToolSafetyPolicy({ name: "keychain" }, keychainToolSafetyPolicy);
  const repeatableMutationDefinition = withToolSafetyPolicy({ name: "repeatable_mutation" }, {
    effect: "mutation",
    repetition: "allow",
  });
  const session = {
    agent: {},
    getToolDefinition: (name: string) => {
      if (name === "keychain") return keychainDefinition;
      if (name === "repeatable_mutation") return repeatableMutationDefinition;
      return undefined;
    },
    getActiveToolNames: () => [...activeTools],
    setActiveToolsByName: (names: string[]) => { activeTools = [...names]; },
  } as any;
  const warnings: Array<{ message: string; details: Record<string, unknown> }> = [];
  const controller = createAttemptToolBudgetController({
    session,
    chatJid,
    initialToolExecutionCount: 0,
    toolUseMessageBudget: 64,
    toolUseWarningThreshold: 48,
    mutationRepetitionLimit,
    runOptions: { turnId: "turn-test" },
    onWarn: (message, details) => warnings.push({ message, details }),
    getRunObservabilityDetails: () => ({}),
  });
  return { session, controller, warnings, getActiveTools: () => [...activeTools] };
}

async function admit(session: any, id: string, args: Record<string, unknown>, name = "keychain") {
  return await session.agent.beforeToolCall({
    toolCall: { id, name },
    args,
  });
}

beforeEach(() => {
  initDatabase();
});

describe("typed tool safety policy", () => {
  test("creates stable opaque fingerprints without embedding arguments", () => {
    const first = createMutationFingerprint("keychain", { action: "set", name: "profile", secret: SENSITIVE_CANARY });
    const reordered = createMutationFingerprint("keychain", { secret: SENSITIVE_CANARY, name: "profile", action: "set" });
    const different = createMutationFingerprint("keychain", { action: "set", name: "other", secret: SENSITIVE_CANARY });

    expect(first).toBe(reordered);
    expect(first).not.toBe(different);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toContain(SENSITIVE_CANARY);
  });

  test("classifies validated keychain actions without tool-name inference", () => {
    const definition = withToolSafetyPolicy({ name: "keychain" }, keychainToolSafetyPolicy);

    expect(getToolSafetyPolicy(definition, { action: "list" })).toEqual({ effect: "read_only", redactResult: true });
    expect(getToolSafetyPolicy(definition, { action: "get", name: "profile" })).toEqual({ effect: "read_only", redactResult: true });
    expect(getToolSafetyPolicy(definition, { action: "set", name: "profile", secret: SENSITIVE_CANARY })).toEqual({
      effect: "mutation",
      repetition: "guard",
      redactArgs: true,
      redactResult: true,
    });
    expect(getToolSafetyPolicy(definition, { action: "delete", name: "profile" })).toEqual({
      effect: "mutation",
      repetition: "guard",
      redactArgs: true,
      redactResult: true,
    });
    expect(getToolSafetyPolicy({ name: "keychain" }, { action: "set", secret: SENSITIVE_CANARY })).toBeNull();
  });
});

describe("successful mutation repetition breaker", () => {
  test("blocks the next identical mutation before execution and stores only secret-safe metadata", async () => {
    const chatJid = "web:mutation-repeat-sequential";
    const { session, controller, warnings, getActiveTools } = createSession(chatJid);
    const args = { action: "set", name: "profile", secret: SENSITIVE_CANARY };
    rememberActiveToolSubset(session, ["keychain"]);
    session.setActiveToolsByName(["read"]);

    expect(await admit(session, "call-1", args)).toBeUndefined();
    controller.consumeToolExecutionEnd("call-1", false);
    expect(await admit(session, "call-2", args)).toBeUndefined();
    controller.consumeToolExecutionEnd("call-2", false);

    const blocked = await admit(session, "call-3", args);
    expect(blocked).toEqual({
      block: true,
      reason: "Tool keychain already completed the same mutation successfully 2 times. The next matching call was blocked and tools are disabled; return a terminal status.",
    });
    expect(getActiveTools()).toEqual([]);

    const quarantine = getMutationQuarantine(chatJid);
    expect(quarantine).toMatchObject({
      version: 1,
      trigger: "repetition_limit",
      toolName: "keychain",
      successfulRepetitions: 2,
      previousActiveToolNames: ["read"],
    });
    expect(quarantine?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify({ quarantine, warnings })).not.toContain(SENSITIVE_CANARY);
  });

  test("uses in-flight reservations so parallel duplicates cannot race past the limit", async () => {
    const chatJid = "web:mutation-repeat-parallel";
    const { session, controller } = createSession(chatJid);
    const args = { action: "set", name: "profile", secret: SENSITIVE_CANARY };

    const [first, second, third] = await Promise.all([
      admit(session, "parallel-1", args),
      admit(session, "parallel-2", args),
      admit(session, "parallel-3", args),
    ]);

    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    expect(third?.block).toBe(true);
    expect(getMutationQuarantine(chatJid)).toBeNull();

    controller.consumeToolExecutionEnd("parallel-1", false);
    controller.consumeToolExecutionEnd("parallel-2", false);
    expect(getMutationQuarantine(chatJid)).toMatchObject({ trigger: "repetition_limit" });
  });

  test("preserves failed retries, differing arguments, and repeated read-only actions", async () => {
    const chatJid = "web:mutation-repeat-preserve";
    const { session, controller } = createSession(chatJid);
    const first = { action: "set", name: "profile", secret: SENSITIVE_CANARY };
    const second = { action: "set", name: "profile", secret: `${SENSITIVE_CANARY}-changed` };

    expect(await admit(session, "failed-1", first)).toBeUndefined();
    controller.consumeToolExecutionEnd("failed-1", true);
    expect(await admit(session, "retry-1", first)).toBeUndefined();
    controller.consumeToolExecutionEnd("retry-1", false);
    expect(await admit(session, "different-1", second)).toBeUndefined();
    controller.consumeToolExecutionEnd("different-1", false);
    expect(await admit(session, "same-first-2", first)).toBeUndefined();
    controller.consumeToolExecutionEnd("same-first-2", false);

    for (let i = 0; i < 8; i += 1) {
      expect(await admit(session, `read-${i}`, { action: "list", limit: 10 })).toBeUndefined();
      controller.consumeToolExecutionEnd(`read-${i}`, false);
      expect(await admit(session, `repeatable-${i}`, { cursor: "same" }, "repeatable_mutation")).toBeUndefined();
      controller.consumeToolExecutionEnd(`repeatable-${i}`, false);
    }
    expect(getMutationQuarantine(chatJid)).toBeNull();
  });

  test("quarantines repeated successful mutations when they consume the tool budget", async () => {
    const chatJid = "web:mutation-repeat-budget";
    const { session, controller } = createSession(chatJid, 10);
    const args = { action: "set", name: "profile", secret: SENSITIVE_CANARY };

    expect(await admit(session, "budget-1", args)).toBeUndefined();
    controller.consumeToolExecutionEnd("budget-1", false);
    expect(await admit(session, "budget-2", args)).toBeUndefined();
    controller.consumeToolExecutionEnd("budget-2", false);
    controller.enforceCompletedExecutionBudget();

    expect(getMutationQuarantine(chatJid)).toMatchObject({
      trigger: "tool_budget",
      toolName: "keychain",
      successfulRepetitions: 2,
      previousActiveToolNames: ["keychain"],
    });
  });

  test("persists quarantine across a replacement session until explicit terminal recovery clearing", async () => {
    const chatJid = "web:mutation-repeat-rotation";
    const first = createSession(chatJid);
    const args = { action: "set", name: "profile", secret: SENSITIVE_CANARY };

    expect(await admit(first.session, "rotate-1", args)).toBeUndefined();
    first.controller.consumeToolExecutionEnd("rotate-1", false);
    expect(await admit(first.session, "rotate-2", args)).toBeUndefined();
    first.controller.consumeToolExecutionEnd("rotate-2", false);
    expect((await admit(first.session, "rotate-3", args))?.block).toBe(true);

    const replacement = createSession(chatJid);
    expect(replacement.getActiveTools()).toEqual([]);
    expect(getMutationQuarantine(chatJid)).not.toBeNull();

    expect(clearMutationQuarantine(chatJid)).toBe(true);
    expect(getMutationQuarantine(chatJid)).toBeNull();
    expect(replacement.getActiveTools()).toEqual([]);

    expect(clearMutationQuarantine(chatJid)).toBe(false);
  });
});
