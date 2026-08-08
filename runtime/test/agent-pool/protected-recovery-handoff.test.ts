import { expect, test } from "bun:test";

import { TOOL_ENABLED_RECOVERY_CONTINUATION_PROMPT } from "../../src/agent-pool/context-pressure-retry.js";
import { runWithProtectedRecoveryHandoff } from "../../src/agent-pool/protected-recovery-handoff.js";
import {
  buildProtectedRecoveryControlIntentBlock,
  isProtectedRecoveryControlMessage,
  resolveProtectedRecoveryPrompt,
} from "../../src/agent-pool/protected-recovery-control-intent.js";
import type { AgentOutput } from "../../src/agent-pool/contracts.js";

const protectedOutput = (): AgentOutput => ({
  status: "error",
  result: null,
  error: "Protected recovery needs an ordinary turn.",
  requiresToolEnabledContinuation: true,
});

test("protected recovery runs exactly one ordinary continuation at the AgentPool boundary", async () => {
  const prompts: string[] = [];
  const observed: AgentOutput[] = [];
  const final = await runWithProtectedRecoveryHandoff(
    "finish the task",
    {},
    async (prompt) => {
      prompts.push(prompt);
      return prompts.length === 1
        ? protectedOutput()
        : { status: "success", result: "finished with tools" };
    },
    (output) => observed.push(output),
  );

  expect(prompts).toEqual(["finish the task", TOOL_ENABLED_RECOVERY_CONTINUATION_PROMPT]);
  expect(observed).toHaveLength(2);
  expect(final).toMatchObject({ status: "success", result: "finished with tools" });
});

test("durable roots externalize without changing the legacy internal one-shot default", async () => {
  const prompts: string[] = [];
  const output = await runWithProtectedRecoveryHandoff(
    "finish the task",
    { protectedRecoveryHandoffMode: "durable_externalize" },
    async (prompt) => {
      prompts.push(prompt);
      return protectedOutput();
    },
  );

  expect(prompts).toEqual(["finish the task"]);
  expect(output.requiresToolEnabledContinuation).toBe(true);
});

test("durable child consumes one internal resume only with successful compaction evidence", async () => {
  const prompts: string[] = [];
  const optionsSeen: Array<{ internal?: boolean; turnId?: string; maxToolCalls?: number }> = [];
  const output = await runWithProtectedRecoveryHandoff(
    TOOL_ENABLED_RECOVERY_CONTINUATION_PROMPT,
    { protectedRecoveryHandoffMode: "durable_continuation", turnId: "stable-child-turn", maxToolCalls: 7 },
    async (prompt, options) => {
      prompts.push(prompt);
      optionsSeen.push({ internal: options.protectedRecoveryInternalResume, turnId: options.turnId, maxToolCalls: options.maxToolCalls });
      return prompts.length === 1
        ? { ...protectedOutput(), protectedRecoveryHandoff: { afterSuccessfulCompaction: true } }
        : { status: "success", result: "finished after compacted resume" };
    },
  );

  expect(prompts).toEqual([TOOL_ENABLED_RECOVERY_CONTINUATION_PROMPT, TOOL_ENABLED_RECOVERY_CONTINUATION_PROMPT]);
  expect(optionsSeen).toEqual([
    { internal: undefined, turnId: "stable-child-turn", maxToolCalls: 7 },
    { internal: true, turnId: "stable-child-turn", maxToolCalls: 7 },
  ]);
  expect(output).toMatchObject({ status: "success", result: "finished after compacted resume" });
});

test("durable child refuses non-compaction and recursive handoffs without another run", async () => {
  for (const initial of [
    protectedOutput(),
    { ...protectedOutput(), protectedRecoveryHandoff: { afterSuccessfulCompaction: true } },
  ]) {
    let calls = 0;
    const output = await runWithProtectedRecoveryHandoff(
      TOOL_ENABLED_RECOVERY_CONTINUATION_PROMPT,
      {
        protectedRecoveryHandoffMode: "durable_continuation",
        protectedRecoveryInternalResume: initial.protectedRecoveryHandoff?.afterSuccessfulCompaction === true,
      },
      async () => {
        calls += 1;
        return initial;
      },
    );
    expect(calls).toBe(1);
    expect(output.requiresToolEnabledContinuation).toBe(true);
  }
});

test("cancellation at the handoff boundary prevents the protected continuation", async () => {
  const prompts: string[] = [];
  let cancelled = false;
  const final = await runWithProtectedRecoveryHandoff(
    "finish the task",
    {},
    async (prompt) => {
      prompts.push(prompt);
      cancelled = true;
      return protectedOutput();
    },
    undefined,
    () => cancelled,
  );

  expect(prompts).toEqual(["finish the task"]);
  expect(final.requiresToolEnabledContinuation).toBeUndefined();
});

test("protected handoff preserves pre-tool progress but hides unauthoritative terminal prose", async () => {
  const delivered: string[] = [];
  const prompts: string[] = [];
  const final = await runWithProtectedRecoveryHandoff(
    "finish the task",
    { onTurnComplete: (turn) => delivered.push(turn.text) },
    async (prompt, options) => {
      prompts.push(prompt);
      if (prompts.length === 1) {
        options.onTurnComplete?.({ text: "committed tool progress", attachments: [], followedByToolUse: true });
        options.onTurnComplete?.({ text: "protected terminal prose", attachments: [] });
        return protectedOutput();
      }
      options.onTurnComplete?.({ text: "ordinary result", attachments: [] });
      return { status: "success", result: "ordinary result" };
    },
  );

  expect(prompts).toEqual(["finish the task", TOOL_ENABLED_RECOVERY_CONTINUATION_PROMPT]);
  expect(delivered).toEqual(["committed tool progress", "ordinary result"]);
  expect(final.result).toBe("ordinary result");
});

test("initial turns flush normally when no handoff is required", async () => {
  const delivered: string[] = [];
  await runWithProtectedRecoveryHandoff(
    "finish the task",
    { onTurnComplete: (turn) => delivered.push(turn.text) },
    async (_prompt, options) => {
      options.onTurnComplete?.({ text: "normal result", attachments: [] });
      return { status: "success", result: "normal result" };
    },
  );

  expect(delivered).toEqual(["normal result"]);
});

test("protected recovery cannot be deferred into a caller-owned follow-up", async () => {
  const prompts: string[] = [];
  const delivered: string[] = [];
  const final = await runWithProtectedRecoveryHandoff(
    "finish the task",
    { onTurnComplete: (turn) => delivered.push(turn.text) },
    async (prompt, options) => {
      prompts.push(prompt);
      if (prompts.length === 1) {
        options.onTurnComplete?.({ text: "committed tool progress", attachments: [], followedByToolUse: true });
        options.onTurnComplete?.({ text: "tools are unavailable in this recovered turn", attachments: [] });
        return protectedOutput();
      }
      options.onTurnComplete?.({ text: "finished internally with tools", attachments: [] });
      return { status: "success", result: "finished internally with tools" };
    },
  );

  expect(prompts).toEqual(["finish the task", TOOL_ENABLED_RECOVERY_CONTINUATION_PROMPT]);
  expect(delivered).toEqual(["committed tool progress", "finished internally with tools"]);
  expect(final).toMatchObject({ status: "success", result: "finished internally with tools" });
});

test("the generated ordinary continuation cannot chain another continuation", async () => {
  const prompts: string[] = [];
  const final = await runWithProtectedRecoveryHandoff(
    "finish the task",
    {},
    async (prompt) => {
      prompts.push(prompt);
      return protectedOutput();
    },
  );

  expect(prompts).toEqual(["finish the task", TOOL_ENABLED_RECOVERY_CONTINUATION_PROMPT]);
  expect(final.requiresToolEnabledContinuation).toBeUndefined();
});

test("a typed already-generated continuation is never handed off again", async () => {
  let calls = 0;
  const final = await runWithProtectedRecoveryHandoff(
    TOOL_ENABLED_RECOVERY_CONTINUATION_PROMPT,
    { protectedRecoveryContinuation: true },
    async () => {
      calls += 1;
      return protectedOutput();
    },
  );

  expect(calls).toBe(1);
  expect(final.requiresToolEnabledContinuation).toBe(true);
});

test("protected recovery control authority requires the complete typed block", () => {
  const block = buildProtectedRecoveryControlIntentBlock({
    sourceMessageId: "source-message",
    sourceRowId: 41,
    threadId: 41,
  });

  expect(isProtectedRecoveryControlMessage({ content_blocks: [block] })).toBe(true);
  expect(resolveProtectedRecoveryPrompt({ content_blocks: [block] })).toBe(TOOL_ENABLED_RECOVERY_CONTINUATION_PROMPT);
  expect(isProtectedRecoveryControlMessage({
    content_blocks: [{ ...block, label: "Presentation text may change" }],
  })).toBe(true);
  expect(isProtectedRecoveryControlMessage({
    content_blocks: [{ type: "control_intent", intent: "protected_recovery_continuation" }],
  })).toBe(false);
  expect(isProtectedRecoveryControlMessage({
    content_blocks: [{ ...block, schema_version: 2 }],
  })).toBe(false);
});

test("matching continuation prose does not acquire one-shot control authority", async () => {
  const prompts: string[] = [];
  await runWithProtectedRecoveryHandoff(
    TOOL_ENABLED_RECOVERY_CONTINUATION_PROMPT,
    {},
    async (prompt) => {
      prompts.push(prompt);
      return prompts.length === 1 ? protectedOutput() : { status: "success", result: "done" };
    },
  );

  expect(prompts).toEqual([
    TOOL_ENABLED_RECOVERY_CONTINUATION_PROMPT,
    TOOL_ENABLED_RECOVERY_CONTINUATION_PROMPT,
  ]);
});
