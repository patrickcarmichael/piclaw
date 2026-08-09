import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { setEnv } from "../helpers.js";

import {
  buildRecoveryDiagnosticEntry,
  MUTATION_CONTAINMENT_CONTINUATION_PROMPT,
  resetRecoveryLoopGuardForTests,
  runAgentRecoveryPhase,
  shouldSuppressRecoveryLoop,
  type PromptAttemptResult,
  type SessionWithToolControl,
} from "../../src/agent-pool/run-agent-recovery-phase.js";
import { RECOVERY_CONTINUATION_PROMPT } from "../../src/agent-pool/context-pressure-retry.js";
import type { AgentOutput } from "../../src/agent-pool/contracts.js";
import { initDatabase } from "../../src/db.js";
import { endTrackedPhase } from "../../src/runtime/progress-watchdog.js";

const TEST_CHAT_JIDS = [
  "web:test-recovery-phase",
  "web:test-recovery-compact",
  "web:test-recovery-compact:insufficient",
];

beforeEach(() => {
  initDatabase();
});

afterEach(() => {
  resetRecoveryLoopGuardForTests();
  for (const chatJid of TEST_CHAT_JIDS) endTrackedPhase(chatJid);
});

function output(status: AgentOutput["status"], error?: string, result: string | null = null): AgentOutput {
  return status === "error"
    ? { status, result: null, error: error ?? "failed" }
    : { status, result, ...(error ? { error } : {}) };
}

function attempt(partial: Partial<PromptAttemptResult> = {}): PromptAttemptResult {
  return {
    output: output("error", "Timed out after 1s"),
    snapshot: {
      hadToolActivity: false,
      hadPartialOutput: false,
      hadCompletedTurnOutput: false,
      hadTerminalTurnOutput: false,
      sawCompactionIntent: false,
    },
    promptWasPersisted: false,
    timedOut: false,
    toolExecutionCount: 0,
    ...partial,
  };
}

function recoveryConfig(overrides: Partial<Parameters<typeof runAgentRecoveryPhase>[0]["recoveryConfig"]> = {}) {
  return {
    enabled: true,
    transientRecoveryEnabled: true,
    transientRecoveryToolsEnabled: true,
    maxAttempts: 3,
    totalBudgetMs: 1_000,
    baseDelayMs: 0,
    maxDelayMs: 0,
    ...overrides,
  };
}

test("recovery loop guard grants one recorded runtime context compaction per stable turn", () => {
  const restoreEnv = setEnv({
    PICLAW_RECOVERY_LOOP_GUARD_ENABLED: "1",
    PICLAW_RECOVERY_LOOP_GUARD_MAX_FAILURES: "2",
    PICLAW_RECOVERY_LOOP_GUARD_WINDOW_MS: "600000",
  });
  const common = {
    chatJid: "web:test-context-pressure-loop-guard",
    modelLabel: "test/model",
    failureCategory: "context_pressure" as const,
    classifier: "context_pressure" as const,
    strategy: "compact_then_retry" as const,
    sawCompactionIntent: true,
    now: 1_000,
  };

  try {
    expect(shouldSuppressRecoveryLoop({
      ...common,
      turnId: "turn-previous-protected-handoff",
      recoveryAttemptsUsed: 0,
    })).toMatchObject({ suppress: false, attemptsInWindow: 1 });
    expect(shouldSuppressRecoveryLoop({
      ...common,
      turnId: "turn-previous-protected-handoff",
      recoveryAttemptsUsed: 1,
      now: 1_001,
    })).toMatchObject({ suppress: true, attemptsInWindow: 2 });

    expect(shouldSuppressRecoveryLoop({
      ...common,
      turnId: "turn-new-mid-turn-pressure",
      recoveryAttemptsUsed: 0,
      now: 1_002,
    })).toMatchObject({ suppress: false, attemptsInWindow: 3 });
    expect(shouldSuppressRecoveryLoop({
      ...common,
      turnId: "turn-new-mid-turn-pressure",
      recoveryAttemptsUsed: 0,
      now: 1_003,
    })).toMatchObject({ suppress: true, attemptsInWindow: 4 });
    expect(shouldSuppressRecoveryLoop({
      ...common,
      turnId: "turn-provider-context-error",
      recoveryAttemptsUsed: 0,
      sawCompactionIntent: false,
      now: 1_004,
    })).toMatchObject({ suppress: true, attemptsInWindow: 5 });
  } finally {
    restoreEnv();
  }
});

describe("runAgentRecoveryPhase", () => {
  test("uses a fresh budget and explicit tools-disabled prompt for mutation recovery", async () => {
    const prompts: string[] = [];
    let activeTools = ["keychain"];
    const session = {
      getActiveToolNames: () => [...activeTools],
      setActiveToolsByName: (names: string[]) => { activeTools = [...names]; },
    } as any;

    const result = await runAgentRecoveryPhase({
      prompt: "store a credential",
      chatJid: "web:test-recovery-phase",
      session,
      sessionCtrl: session,
      timeoutMs: 10_000,
      startTime: Date.now() - 5_000,
      modelLabel: "test/model",
      recoveryConfig: recoveryConfig({ totalBudgetMs: 1_000 }),
      runOptions: {},
      logsDir: "/tmp/nonexistent-piclaw-test-logs",
      clearAttachments: () => {},
      runPromptAttempt: async (prompt) => {
        prompts.push(prompt);
        if (prompts.length === 1) {
          return attempt({
            output: {
              status: "error",
              result: null,
              error: "Repeated mutation contained.",
              failureCategory: "mutation_repetition",
            },
            promptWasPersisted: true,
            snapshot: {
              hadToolActivity: true,
              hadPartialOutput: false,
              hadCompletedTurnOutput: false,
              hadTerminalTurnOutput: false,
              sawCompactionIntent: false,
              canDisableToolsForRecovery: true,
              hasUnresolvedToolExecution: false,
            },
          });
        }
        expect(activeTools).toEqual([]);
        return attempt({ output: output("success", undefined, "Mutation containment reported.") });
      },
    });

    expect(prompts).toEqual(["store a credential", MUTATION_CONTAINMENT_CONTINUATION_PROMPT]);
    expect(result).toMatchObject({ status: "success", result: "Mutation containment reported." });
    expect(activeTools).toEqual([]);
  });

  test("resets stale recovery timer state when containment follows an unrelated retry", async () => {
    const prompts: string[] = [];
    const timeouts: number[] = [];
    let activeTools = ["keychain"];
    const session = {
      getActiveToolNames: () => [...activeTools],
      setActiveToolsByName: (names: string[]) => { activeTools = [...names]; },
    } as any;

    const result = await runAgentRecoveryPhase({
      prompt: "complete work",
      chatJid: "web:test-recovery-phase",
      session,
      sessionCtrl: session,
      timeoutMs: 10_000,
      startTime: Date.now(),
      modelLabel: "test/model",
      recoveryConfig: recoveryConfig({ totalBudgetMs: 100, transientRecoveryToolsEnabled: true }),
      runOptions: {},
      logsDir: "/tmp/nonexistent-piclaw-test-logs",
      clearAttachments: () => {},
      runPromptAttempt: async (prompt, timeoutMs) => {
        prompts.push(prompt);
        timeouts.push(timeoutMs);
        if (prompts.length === 1) {
          return attempt({
            output: { status: "error", result: null, error: "network unavailable", failureCategory: "network" },
            promptWasPersisted: true,
          });
        }
        if (prompts.length === 2) {
          await Bun.sleep(40);
          return attempt({
            output: { status: "error", result: null, error: "Repeated mutation contained.", failureCategory: "mutation_repetition" },
            promptWasPersisted: true,
            snapshot: {
              hadToolActivity: true,
              hadPartialOutput: false,
              hadCompletedTurnOutput: false,
              hadTerminalTurnOutput: false,
              sawCompactionIntent: false,
              canDisableToolsForRecovery: true,
              hasUnresolvedToolExecution: false,
            },
          });
        }
        expect(activeTools).toEqual([]);
        return attempt({ output: output("success", undefined, "Mutation containment reported.") });
      },
    });

    expect(prompts).toEqual([
      "complete work",
      RECOVERY_CONTINUATION_PROMPT,
      MUTATION_CONTAINMENT_CONTINUATION_PROMPT,
    ]);
    expect(timeouts[2]).toBeGreaterThanOrEqual(80);
    expect(result).toMatchObject({
      status: "success",
      recovery: { attemptsUsed: 2, strategyHistory: ["retry", "finalize"] },
    });
    expect(activeTools).toEqual([]);
  });

  test("bounds a quarantined transient retry before phantom accounting or backoff", async () => {
    const prompts: string[] = [];
    const events: any[] = [];
    let activeTools: string[] = [];
    const session = {
      getActiveToolNames: () => [...activeTools],
      setActiveToolsByName: (names: string[]) => { activeTools = [...names]; },
    } as any;

    const result = await runAgentRecoveryPhase({
      prompt: "continue quarantined recovery",
      chatJid: "web:test-recovery-phase",
      session,
      sessionCtrl: session,
      timeoutMs: 10_000,
      startTime: Date.now(),
      modelLabel: "test/model",
      recoveryConfig: recoveryConfig({
        transientRecoveryToolsEnabled: false,
        totalBudgetMs: 20,
        baseDelayMs: 40,
        maxDelayMs: 40,
      }),
      runOptions: { onEvent: (event) => events.push(event) },
      mutationContainmentActive: true,
      logsDir: "/tmp/nonexistent-piclaw-test-logs",
      clearAttachments: () => {},
      runPromptAttempt: async (prompt) => {
        prompts.push(prompt);
        expect(activeTools).toEqual([]);
        session.setActiveToolsByName(["keychain"]);
        expect(activeTools).toEqual([]);
        if (prompts.length === 1) {
          return attempt({
            output: {
              status: "error",
              result: null,
              error: "503 temporarily unavailable",
              failureCategory: "network",
            },
            promptWasPersisted: true,
          });
        }
        return attempt({
          output: {
            status: "error",
            result: null,
            error: "network still unavailable",
            failureCategory: "network",
          },
          promptWasPersisted: true,
        });
      },
    });

    expect(MUTATION_CONTAINMENT_CONTINUATION_PROMPT).toContain("without claiming new side effects or exposing tool arguments");
    expect(prompts).toEqual(["continue quarantined recovery", MUTATION_CONTAINMENT_CONTINUATION_PROMPT]);
    expect(events.filter((event) => event.type === "recovery_start")).toHaveLength(1);
    expect(result).toMatchObject({
      status: "error",
      error: "network still unavailable",
      failureCategory: "mutation_repetition",
      recovery: { attemptsUsed: 1, strategyHistory: ["retry"] },
    });
    expect(activeTools).toEqual([]);
  });

  test("does not begin or retry an attempt after operation cancellation", async () => {
    let attempts = 0;
    const result = await runAgentRecoveryPhase({
      prompt: "cancelled prompt",
      chatJid: "web:test-recovery-phase",
      session: {} as any,
      sessionCtrl: null,
      timeoutMs: 10_000,
      startTime: Date.now(),
      modelLabel: "test/model",
      recoveryConfig: recoveryConfig(),
      runOptions: {},
      logsDir: "/tmp/nonexistent-piclaw-test-logs",
      clearAttachments: () => {},
      isCancelled: () => true,
      runPromptAttempt: async () => {
        attempts += 1;
        return attempt();
      },
    });

    expect(attempts).toBe(0);
    expect(result).toMatchObject({
      status: "error",
      failureCategory: "aborted",
      error: "Operation cancelled.",
    });
  });

  test("continues after resolved tool work with tools available and execution budget carried", async () => {
    let activeTools = ["read", "bash"];
    const activeToolSets: string[][] = [];
    const sessionCtrl: SessionWithToolControl = {
      getActiveToolNames: () => [...activeTools],
      setActiveToolsByName: (names) => {
        activeTools = [...names];
        activeToolSets.push([...names]);
      },
    };
    const calls: Array<{ prompt: string; timeoutMs: number; toolExecutionCountAtStart: number }> = [];
    const events: unknown[] = [];

    const result = await runAgentRecoveryPhase({
      prompt: "original prompt",
      chatJid: "web:test-recovery-phase",
      session: {} as any,
      sessionCtrl,
      timeoutMs: 10_000,
      startTime: Date.now(),
      modelLabel: "test/model",
      recoveryConfig: recoveryConfig(),
      runOptions: { onEvent: (event) => events.push(event) },
      logsDir: "/tmp/nonexistent-piclaw-test-logs",
      clearAttachments: () => {},
      runPromptAttempt: async (prompt, timeoutMs, toolExecutionCountAtStart) => {
        calls.push({ prompt, timeoutMs, toolExecutionCountAtStart });
        if (calls.length === 1) {
          return attempt({
            output: output("error", "429 Too Many Requests"),
            snapshot: {
              hadToolActivity: true,
              hadPartialOutput: false,
              hadCompletedTurnOutput: false,
              hadTerminalTurnOutput: false,
              sawCompactionIntent: false,
              canDisableToolsForRecovery: true,
              hasUnresolvedToolExecution: false,
              toolExecutionCount: 3,
            },
            promptWasPersisted: true,
            toolExecutionCount: 3,
          });
        }
        expect(activeTools).toEqual(["read", "bash"]);
        return attempt({
          output: output("success", undefined, "done"),
          snapshot: {
            hadToolActivity: false,
            hadPartialOutput: false,
            hadCompletedTurnOutput: true,
            hadTerminalTurnOutput: true,
            sawCompactionIntent: false,
          },
          promptWasPersisted: true,
          toolExecutionCount: toolExecutionCountAtStart,
        });
      },
    });

    expect(result.status).toBe("success");
    expect(result.result).toBe("done");
    expect(result.recovery?.attemptsUsed).toBe(1);
    expect(calls[0]).toEqual({ prompt: "original prompt", timeoutMs: 10_000, toolExecutionCountAtStart: 0 });
    expect(calls[1]?.prompt).toBe(RECOVERY_CONTINUATION_PROMPT);
    expect(calls[1]?.toolExecutionCountAtStart).toBe(3);
    expect(calls[1]?.timeoutMs).toBeGreaterThanOrEqual(950);
    expect(calls[1]?.timeoutMs).toBeLessThanOrEqual(1_000);
    expect(activeToolSets).toEqual([]);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "recovery_start", attempt: 1, strategy: "retry" }),
      expect.objectContaining({ type: "recovery_end", outcome: "recovered", attemptsUsed: 1 }),
    ]));
  });

  test("hands off a generic tools-disabled recovery without making a disposable provider call", async () => {
    let activeTools = ["read", "bash"];
    const sessionCtrl: SessionWithToolControl = {
      getActiveToolNames: () => [...activeTools],
      setActiveToolsByName: (names) => { activeTools = [...names]; },
    };
    let calls = 0;

    const result = await runAgentRecoveryPhase({
      prompt: "continue goal",
      chatJid: "web:test-recovery-phase:skip-provider",
      session: {} as any,
      sessionCtrl,
      timeoutMs: 0,
      startTime: Date.now(),
      modelLabel: "test/model",
      recoveryConfig: recoveryConfig({ transientRecoveryToolsEnabled: false }),
      runOptions: {},
      logsDir: "/tmp/nonexistent-piclaw-test-logs",
      clearAttachments: () => {},
      runPromptAttempt: async () => {
        calls += 1;
        if (calls > 1) throw new Error("generic tools-disabled recovery must not invoke the provider");
        return attempt({
          output: output("error", "503 temporarily unavailable"),
          snapshot: {
            hadToolActivity: true,
            hadPartialOutput: false,
            hadCompletedTurnOutput: false,
            hadTerminalTurnOutput: false,
            sawCompactionIntent: false,
            canDisableToolsForRecovery: true,
            hasUnresolvedToolExecution: false,
          },
          promptWasPersisted: true,
        });
      },
    });

    expect(result).toMatchObject({
      status: "error",
      requiresToolEnabledContinuation: true,
      recovery: { recovered: false, exhausted: true, lastClassifier: "tool_activity" },
    });
    expect(result.nextAction).toContain("ordinary turn");
    expect(calls).toBe(1);
    expect(activeTools).toEqual(["read", "bash"]);
  });

  test("skips a tools-disabled transient provider attempt and preserves tools", async () => {
    let activeTools = ["read", "bash"];
    const activeToolSets: string[][] = [];
    const sessionCtrl: SessionWithToolControl = {
      getActiveToolNames: () => [...activeTools],
      setActiveToolsByName: (names) => {
        activeTools = [...names];
        activeToolSets.push([...names]);
      },
    };
    let calls = 0;

    const result = await runAgentRecoveryPhase({
      prompt: "original prompt",
      chatJid: "web:test-recovery-phase",
      session: {} as any,
      sessionCtrl,
      timeoutMs: 0,
      startTime: Date.now(),
      modelLabel: "test/model",
      recoveryConfig: recoveryConfig({ transientRecoveryToolsEnabled: false }),
      runOptions: {},
      logsDir: "/tmp/nonexistent-piclaw-test-logs",
      clearAttachments: () => {},
      runPromptAttempt: async () => {
        calls += 1;
        if (calls === 1) {
          return attempt({
            output: output("error", "503 temporarily unavailable"),
            snapshot: {
              hadToolActivity: true,
              hadPartialOutput: false,
              hadCompletedTurnOutput: false,
              hadTerminalTurnOutput: false,
              sawCompactionIntent: false,
              canDisableToolsForRecovery: true,
              hasUnresolvedToolExecution: false,
            },
            promptWasPersisted: true,
          });
        }
        throw new Error("generic tools-disabled recovery must not invoke the provider");
      },
    });

    expect(result).toMatchObject({
      status: "error",
      requiresToolEnabledContinuation: true,
      recovery: { recovered: false, exhausted: true, lastClassifier: "tool_activity" },
    });
    expect(calls).toBe(1);
    expect(activeToolSets).toEqual([]);
    expect(activeTools).toEqual(["read", "bash"]);
  });

  test("skips a tools-disabled retry after unresolved tool execution and preserves tools",  async () => {
    let activeTools = ["read", "bash"];
    const activeToolSets: string[][] = [];
    const sessionCtrl: SessionWithToolControl = {
      getActiveToolNames: () => [...activeTools],
      setActiveToolsByName: (names) => {
        activeTools = [...names];
        activeToolSets.push([...names]);
      },
    };
    let calls = 0;

    const result = await runAgentRecoveryPhase({
      prompt: "original prompt",
      chatJid: "web:test-recovery-phase",
      session: {} as any,
      sessionCtrl,
      timeoutMs: 0,
      startTime: Date.now(),
      modelLabel: "test/model",
      recoveryConfig: recoveryConfig(),
      runOptions: {},
      logsDir: "/tmp/nonexistent-piclaw-test-logs",
      clearAttachments: () => {},
      runPromptAttempt: async () => {
        calls += 1;
        if (calls === 1) {
          return attempt({
            output: output("error", "WebSocket closed 1006 Connection ended"),
            snapshot: {
              hadToolActivity: true,
              hadPartialOutput: false,
              hadCompletedTurnOutput: false,
              hadTerminalTurnOutput: false,
              sawCompactionIntent: false,
              canDisableToolsForRecovery: true,
              hasUnresolvedToolExecution: true,
            },
            promptWasPersisted: true,
          });
        }
        throw new Error("generic tools-disabled recovery must not invoke the provider");
      },
    });

    expect(result).toMatchObject({
      status: "error",
      requiresToolEnabledContinuation: true,
      recovery: { recovered: false, exhausted: true, lastClassifier: "tool_activity" },
    });
    expect(calls).toBe(1);
    expect(activeToolSets).toEqual([]);
    expect(activeTools).toEqual(["read", "bash"]);
  });

  test("runs recovery compaction before handing off without a disposable provider call",  async () => {
    let compactCalls = 0;
    const calls: Array<{ prompt: string; timeoutMs: number; toolExecutionCountAtStart: number }> = [];
    const events: unknown[] = [];
    let activeTools = ["read", "bash"];
    const activeToolSets: string[][] = [];
    const sessionCtrl: SessionWithToolControl = {
      getActiveToolNames: () => [...activeTools],
      setActiveToolsByName: (names) => {
        activeTools = [...names];
        activeToolSets.push([...names]);
      },
    };
    const session = {
      compact: async () => {
        compactCalls += 1;
        throw new Error("Nothing to compact (session too small)");
      },
    } as any;

    const result = await runAgentRecoveryPhase({
      prompt: "original prompt",
      chatJid: "web:test-recovery-compact",
      session,
      sessionCtrl,
      timeoutMs: 0,
      startTime: Date.now() - 60_000,
      modelLabel: "test/model",
      recoveryConfig: recoveryConfig({
        enabled: false,
        transientRecoveryEnabled: false,
        transientRecoveryToolsEnabled: false,
        totalBudgetMs: 25,
      }),
      runOptions: { onEvent: (event) => events.push(event) },
      logsDir: "/tmp/nonexistent-piclaw-test-logs",
      clearAttachments: () => {},
      runPromptAttempt: async (prompt, timeoutMs, toolExecutionCountAtStart) => {
        calls.push({ prompt, timeoutMs, toolExecutionCountAtStart });
        if (calls.length === 1) {
          return attempt({
            output: output("error", "context length exceeded"),
            snapshot: {
              hadToolActivity: true,
              hadPartialOutput: false,
              hadCompletedTurnOutput: false,
              hadTerminalTurnOutput: false,
              sawCompactionIntent: true,
              canDisableToolsForRecovery: true,
              hasUnresolvedToolExecution: true,
              toolExecutionCount: 2,
            },
            promptWasPersisted: true,
            toolExecutionCount: 2,
          });
        }
        throw new Error("post-compaction tools-disabled recovery must not invoke the provider");
      },
    });

    expect(result).toMatchObject({
      status: "error",
      requiresToolEnabledContinuation: true,
      recovery: { recovered: false, exhausted: true, lastClassifier: "tool_activity" },
    });
    expect(compactCalls).toBe(1);
    expect(calls).toEqual([{ prompt: "original prompt", timeoutMs: 0, toolExecutionCountAtStart: 0 }]);
    expect(activeToolSets).toEqual([]);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "compaction_start", trigger: "recovery" }),
      expect.objectContaining({ type: "compaction_end", trigger: "recovery", willRetry: true }),
      expect.objectContaining({ type: "recovery_end", outcome: "handoff" }),
    ]));
  });

  test("hands off context-pressure recovery without requiring tool suppression support", async () => {
    let calls = 0;
    const result = await runAgentRecoveryPhase({
      prompt: "original prompt",
      chatJid: "web:test-recovery-phase",
      session: { compact: async () => ({}) } as any,
      sessionCtrl: null,
      timeoutMs: 0,
      startTime: Date.now(),
      modelLabel: "test/model",
      recoveryConfig: recoveryConfig(),
      runOptions: {},
      logsDir: "/tmp/nonexistent-piclaw-test-logs",
      clearAttachments: () => {},
      runPromptAttempt: async () => {
        calls += 1;
        return attempt({
          output: output("error", "context length exceeded"),
          snapshot: {
            hadToolActivity: true,
            hadPartialOutput: false,
            hadCompletedTurnOutput: false,
            hadTerminalTurnOutput: false,
            sawCompactionIntent: true,
            toolExecutionCount: 1,
          },
          promptWasPersisted: true,
          toolExecutionCount: 1,
        });
      },
    });
    expect(calls).toBe(1);
    expect(result).toMatchObject({
      status: "error",
      requiresToolEnabledContinuation: true,
      recovery: { attemptsUsed: 1, lastClassifier: "tool_activity" },
    });
    expect(result.toolBudgetExceeded).toBeUndefined();
  });

  test("emergency-rotates and continues when recovery compaction fails", async () => {
    let calls = 0;
    let rotations = 0;
    const oldSession = { compact: async () => { throw new Error("Progressive compaction output invalid (stop_reason): completion stop reason was length; expected stop"); } } as any;
    const newSession = {} as any;
    let activeTools = ["read"];
    const sessionCtrl: SessionWithToolControl = {
      getActiveToolNames: () => [...activeTools],
      setActiveToolsByName: (names) => { activeTools = [...names]; },
    };
    const result = await runAgentRecoveryPhase({
      prompt: "original prompt",
      chatJid: "web:test-recovery-compact",
      session: oldSession,
      sessionCtrl,
      timeoutMs: 0,
      startTime: Date.now(),
      modelLabel: "test/model",
      recoveryConfig: recoveryConfig(),
      runOptions: {},
      logsDir: "/tmp/nonexistent-piclaw-test-logs",
      clearAttachments: () => {},
      rotateAfterCompactionFailure: async () => {
        rotations += 1;
        return { ok: true, session: newSession, sessionCtrl };
      },
      runPromptAttempt: async () => {
        calls += 1;
        if (calls === 1) {
          return attempt({
            output: output("error", "context length exceeded"),
            snapshot: {
              hadToolActivity: true,
              hadPartialOutput: false,
              hadCompletedTurnOutput: false,
              hadTerminalTurnOutput: false,
              sawCompactionIntent: true,
              toolExecutionCount: 1,
            },
            promptWasPersisted: true,
            toolExecutionCount: 1,
          });
        }
        expect(activeTools).toEqual([]);
        return attempt({ output: output("success", undefined, "rotated after compaction failure") });
      },
    });

    expect(result).toMatchObject({
      status: "error",
      requiresToolEnabledContinuation: true,
      recovery: { recovered: false, exhausted: true, lastClassifier: "tool_activity" },
    });
    expect(rotations).toBe(1);
    expect(calls).toBe(1);
  });

  test("rotates when recovery compaction remains over threshold", async () => {
    let calls = 0;
    let rotations = 0;
    const oldSession = {
      compact: async () => ({ tokensBefore: 300_000, estimatedTokensAfter: 300_000 }),
      model: { contextWindow: 128_000 },
      getContextUsage: () => ({ tokens: 300_000 }),
      sessionManager: { getLeafId: () => "leaf", getEntries: () => [], buildSessionContext: () => ({ messages: [] }) },
    } as any;
    const newSession = {} as any;
    let activeTools = ["read"];
    const sessionCtrl: SessionWithToolControl = {
      getActiveToolNames: () => [...activeTools],
      setActiveToolsByName: (names) => { activeTools = [...names]; },
    };
    const result = await runAgentRecoveryPhase({
      prompt: "original prompt",
      chatJid: "web:test-recovery-compact:insufficient",
      session: oldSession,
      sessionCtrl,
      timeoutMs: 0,
      startTime: Date.now(),
      modelLabel: "test/model",
      recoveryConfig: recoveryConfig(),
      runOptions: {},
      logsDir: "/tmp/nonexistent-piclaw-test-logs",
      clearAttachments: () => {},
      rotateAfterInsufficientCompaction: async () => {
        rotations += 1;
        return { ok: true, session: newSession, sessionCtrl };
      },
      runPromptAttempt: async () => {
        calls += 1;
        if (calls === 1) {
          return attempt({
            output: output("error", "context length exceeded"),
            snapshot: {
              hadToolActivity: true,
              hadPartialOutput: false,
              hadCompletedTurnOutput: false,
              hadTerminalTurnOutput: false,
              sawCompactionIntent: true,
              toolExecutionCount: 1,
            },
            promptWasPersisted: true,
            toolExecutionCount: 1,
          });
        }
        expect(activeTools).toEqual([]);
        return attempt({ output: output("success", undefined, "rotated") });
      },
    });
    expect(result).toMatchObject({
      status: "error",
      requiresToolEnabledContinuation: true,
      recovery: { recovered: false, exhausted: true, lastClassifier: "tool_activity" },
    });
    expect(rotations).toBe(1);
    expect(calls).toBe(1);
  });

  test("buildRecoveryDiagnosticEntry preserves serializable budget fields", () => {
    expect(buildRecoveryDiagnosticEntry(
      "attempt_failure",
      2,
      "tool_history_pressure",
      null,
      "budget reached",
      "Tool-use budget exceeded",
      123,
      {
        hadToolActivity: true,
        hadPartialOutput: true,
        hadCompletedTurnOutput: false,
        hadTerminalTurnOutput: false,
        hasUnresolvedToolExecution: true,
        sawCompactionIntent: false,
        compactionErrorMessage: null,
        toolUseBudgetExceeded: true,
        assistantToolUseMessageCount: 4,
        toolExecutionCount: 7,
      },
    )).toEqual({
      phase: "attempt_failure",
      attempt: 2,
      classifier: "tool_history_pressure",
      strategy: null,
      reason: "budget reached",
      error: "Tool-use budget exceeded",
      elapsedMs: 123,
      hadToolActivity: true,
      hadPartialOutput: true,
      hadCompletedTurnOutput: false,
      hadTerminalTurnOutput: false,
      hasUnresolvedToolExecution: true,
      sawCompactionIntent: false,
      compactionErrorMessage: null,
      toolUseBudgetExceeded: true,
      assistantToolUseMessageCount: 4,
      toolExecutionCount: 7,
    });
  });
});
