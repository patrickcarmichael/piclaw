import { expect, test } from "bun:test";

import {
  classifyOpaqueAgentFailure,
  decideAutomaticRecovery as decideTypedAutomaticRecovery,
  DEFAULT_AUTOMATIC_RECOVERY_CONFIG,
  getAutomaticRecoveryConfig,
  isContextPressureFailure,
  isLengthStopFailure,
  isNonRecoverableFailure,
  isProviderAuthConfigFailure,
  isTransientFailure,
  type RecoveryDecisionInput,
} from "../../src/agent-pool/automatic-recovery.js";

type OpaqueRecoveryDecisionInput = Omit<RecoveryDecisionInput, "failureCategory"> & {
  errorText: string | null | undefined;
  failureCategory?: RecoveryDecisionInput["failureCategory"];
};

// Most policy tests start from an opaque provider/legacy error. Classify that
// error explicitly at this test boundary; the policy function itself accepts
// only authoritative typed state.
function decideAutomaticRecovery(input: OpaqueRecoveryDecisionInput) {
  const { errorText, failureCategory, ...policyInput } = input;
  return decideTypedAutomaticRecovery({
    ...policyInput,
    failureCategory: failureCategory ?? classifyOpaqueAgentFailure(errorText),
  });
}

test("keeps turn auto-recovery enabled while disabling transient tools by default", () => {
  const previousAutoRecovery = process.env.PICLAW_TURN_AUTO_RECOVERY_ENABLED;
  const previousTransientRecovery = process.env.PICLAW_TURN_TRANSIENT_RECOVERY_ENABLED;
  const previousTransientTools = process.env.PICLAW_TURN_TRANSIENT_RECOVERY_TOOLS_ENABLED;
  delete process.env.PICLAW_TURN_AUTO_RECOVERY_ENABLED;
  delete process.env.PICLAW_TURN_TRANSIENT_RECOVERY_ENABLED;
  delete process.env.PICLAW_TURN_TRANSIENT_RECOVERY_TOOLS_ENABLED;
  try {
    const config = getAutomaticRecoveryConfig({ enabled: false, maxRetries: 7, baseDelayMs: 1234, maxDelayMs: 5678 });
    expect(config.enabled).toBe(true);
    expect(config.transientRecoveryEnabled).toBe(true);
    expect(config.transientRecoveryToolsEnabled).toBe(false);
    expect(config.maxAttempts).toBe(7);
    expect(config.baseDelayMs).toBe(1234);
    expect(config.maxDelayMs).toBe(5678);
  } finally {
    if (previousAutoRecovery === undefined) delete process.env.PICLAW_TURN_AUTO_RECOVERY_ENABLED;
    else process.env.PICLAW_TURN_AUTO_RECOVERY_ENABLED = previousAutoRecovery;
    if (previousTransientRecovery === undefined) delete process.env.PICLAW_TURN_TRANSIENT_RECOVERY_ENABLED;
    else process.env.PICLAW_TURN_TRANSIENT_RECOVERY_ENABLED = previousTransientRecovery;
    if (previousTransientTools === undefined) delete process.env.PICLAW_TURN_TRANSIENT_RECOVERY_TOOLS_ENABLED;
    else process.env.PICLAW_TURN_TRANSIENT_RECOVERY_TOOLS_ENABLED = previousTransientTools;
  }
});

test("honors explicit turn auto-recovery env disable", () => {
  const previous = process.env.PICLAW_TURN_AUTO_RECOVERY_ENABLED;
  process.env.PICLAW_TURN_AUTO_RECOVERY_ENABLED = "0";
  try {
    const config = getAutomaticRecoveryConfig({ enabled: true, maxRetries: 7, baseDelayMs: 1234, maxDelayMs: 5678 });
    expect(config.enabled).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.PICLAW_TURN_AUTO_RECOVERY_ENABLED;
    else process.env.PICLAW_TURN_AUTO_RECOVERY_ENABLED = previous;
  }
});

test("automatic recovery default budget accommodates long compaction", () => {
  expect(DEFAULT_AUTOMATIC_RECOVERY_CONFIG.totalBudgetMs).toBe(360_000);
});

test("honors transient recovery and transient tool env controls", () => {
  const previousRecovery = process.env.PICLAW_TURN_TRANSIENT_RECOVERY_ENABLED;
  const previousTools = process.env.PICLAW_TURN_TRANSIENT_RECOVERY_TOOLS_ENABLED;
  process.env.PICLAW_TURN_TRANSIENT_RECOVERY_ENABLED = "0";
  process.env.PICLAW_TURN_TRANSIENT_RECOVERY_TOOLS_ENABLED = "true";
  try {
    const config = getAutomaticRecoveryConfig();
    expect(config.transientRecoveryEnabled).toBe(false);
    expect(config.transientRecoveryToolsEnabled).toBe(true);
  } finally {
    if (previousRecovery === undefined) delete process.env.PICLAW_TURN_TRANSIENT_RECOVERY_ENABLED;
    else process.env.PICLAW_TURN_TRANSIENT_RECOVERY_ENABLED = previousRecovery;
    if (previousTools === undefined) delete process.env.PICLAW_TURN_TRANSIENT_RECOVERY_TOOLS_ENABLED;
    else process.env.PICLAW_TURN_TRANSIENT_RECOVERY_TOOLS_ENABLED = previousTools;
  }
});

test("turn auto-recovery numeric env rejects malformed suffixes", () => {
  const previousAttempts = process.env.PICLAW_TURN_AUTO_RECOVERY_MAX_ATTEMPTS;
  const previousBudget = process.env.PICLAW_TURN_AUTO_RECOVERY_TOTAL_BUDGET_MS;
  process.env.PICLAW_TURN_AUTO_RECOVERY_MAX_ATTEMPTS = "12abc";
  process.env.PICLAW_TURN_AUTO_RECOVERY_TOTAL_BUDGET_MS = "4000oops";
  try {
    const config = getAutomaticRecoveryConfig({ enabled: true, maxRetries: 7, baseDelayMs: 1234, maxDelayMs: 5678 });
    expect(config.maxAttempts).toBe(7);
    expect(config.totalBudgetMs).toBe(DEFAULT_AUTOMATIC_RECOVERY_CONFIG.totalBudgetMs);
  } finally {
    if (previousAttempts === undefined) delete process.env.PICLAW_TURN_AUTO_RECOVERY_MAX_ATTEMPTS;
    else process.env.PICLAW_TURN_AUTO_RECOVERY_MAX_ATTEMPTS = previousAttempts;
    if (previousBudget === undefined) delete process.env.PICLAW_TURN_AUTO_RECOVERY_TOTAL_BUDGET_MS;
    else process.env.PICLAW_TURN_AUTO_RECOVERY_TOTAL_BUDGET_MS = previousBudget;
  }
});

test("classifies context-limit failures as compact-then-retry", () => {
  const decision = decideAutomaticRecovery({
    config: DEFAULT_AUTOMATIC_RECOVERY_CONFIG,
    errorText: "maximum context length exceeded for this model",
    recoveryAttemptsUsed: 0,
    elapsedMs: 1000,
    snapshot: {
      hadToolActivity: false,
      hadPartialOutput: true,
    },
  });

  expect(isContextPressureFailure("maximum context length exceeded")).toBe(true);
  expect(decision.recover).toBe(true);
  expect(decision.classifier).toBe("context_pressure");
  expect(decision.strategy).toBe("compact_then_retry");
});

test("classifies the SDK compaction lock as non-retrying compaction ownership", () => {
  const errorText = "Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.";
  const decision = decideAutomaticRecovery({
    config: DEFAULT_AUTOMATIC_RECOVERY_CONFIG,
    errorText,
    recoveryAttemptsUsed: 0,
    elapsedMs: 1000,
    snapshot: {
      hadToolActivity: false,
      hadPartialOutput: false,
    },
  });

  expect(classifyOpaqueAgentFailure(errorText)).toBe("compaction_in_progress");
  expect(decision).toMatchObject({
    recover: false,
    classifier: "compaction_in_progress",
    strategy: null,
  });
});

test("treats timeout-before-finalization during compaction intent as compact-then-retry", () => {
  const decision = decideAutomaticRecovery({
    config: DEFAULT_AUTOMATIC_RECOVERY_CONFIG,
    errorText: "Response timed out before finalization",
    recoveryAttemptsUsed: 0,
    elapsedMs: 1000,
    snapshot: {
      hadToolActivity: false,
      hadPartialOutput: true,
      sawCompactionIntent: true,
    },
  });

  expect(isTransientFailure("Response timed out before finalization")).toBe(true);
  expect(decision.recover).toBe(true);
  expect(decision.classifier).toBe("context_pressure");
  expect(decision.strategy).toBe("compact_then_retry");
});

test("classifies provider auth/config failures as terminal auth_config", () => {
  expect(isProviderAuthConfigFailure("No API key for provider: openai-codex")).toBe(true);
  expect(isProviderAuthConfigFailure("Token refresh failed: 401")).toBe(true);
  expect(isProviderAuthConfigFailure("provider.getApiKey is not a function")).toBe(true);

  const noKeyDecision = decideAutomaticRecovery({
    config: DEFAULT_AUTOMATIC_RECOVERY_CONFIG,
    errorText: "No API key for provider: openai-codex",
    recoveryAttemptsUsed: 0,
    elapsedMs: 1000,
    snapshot: {
      hadToolActivity: false,
      hadPartialOutput: false,
    },
  });

  expect(noKeyDecision.recover).toBe(false);
  expect(noKeyDecision.classifier).toBe("auth_config");
  expect(noKeyDecision.strategy).toBeNull();

  const refreshDecision = decideAutomaticRecovery({
    config: DEFAULT_AUTOMATIC_RECOVERY_CONFIG,
    errorText: "Token refresh failed: 401",
    recoveryAttemptsUsed: 0,
    elapsedMs: 1000,
    snapshot: {
      hadToolActivity: true,
      hadPartialOutput: true,
    },
  });

  expect(refreshDecision.recover).toBe(false);
  expect(refreshDecision.classifier).toBe("auth_config");
  expect(refreshDecision.strategy).toBeNull();

  const compactionAuthDecision = decideAutomaticRecovery({
    config: DEFAULT_AUTOMATIC_RECOVERY_CONFIG,
    errorText: "provider.getApiKey is not a function",
    recoveryAttemptsUsed: 0,
    elapsedMs: 1000,
    snapshot: {
      hadToolActivity: false,
      hadPartialOutput: false,
      compactionErrorMessage: "provider.getApiKey is not a function",
      sawCompactionIntent: true,
    },
  });

  expect(compactionAuthDecision.recover).toBe(false);
  expect(compactionAuthDecision.classifier).toBe("auth_config");
  expect(compactionAuthDecision.strategy).toBeNull();
});

test("classifies output-length stops as terminal length_stop without confusing context length", () => {
  expect(isLengthStopFailure("Provider stopped because it hit the maximum output length before finalization (finish reason: length).")).toBe(true);
  expect(isLengthStopFailure("maximum context length exceeded")).toBe(false);

  const decision = decideAutomaticRecovery({
    config: DEFAULT_AUTOMATIC_RECOVERY_CONFIG,
    errorText: "Provider stopped because it hit the maximum output length before finalization (finish reason: length). The partial answer was preserved.",
    recoveryAttemptsUsed: 0,
    elapsedMs: 1000,
    snapshot: {
      hadToolActivity: false,
      hadPartialOutput: true,
    },
  });

  expect(decision.recover).toBe(false);
  expect(decision.classifier).toBe("length_stop");
  expect(decision.strategy).toBeNull();
});

test("structured failure category overrides misleading diagnostic prose", () => {
  const authDecision = decideAutomaticRecovery({
    config: DEFAULT_AUTOMATIC_RECOVERY_CONFIG,
    errorText: "timed out after maximum context length; please retry",
    failureCategory: "auth_config",
    recoveryAttemptsUsed: 0,
    elapsedMs: 1000,
    snapshot: {
      hadToolActivity: false,
      hadPartialOutput: false,
      canDisableToolsForRecovery: true,
    },
  });
  expect(authDecision).toMatchObject({ recover: false, classifier: "auth_config", strategy: null });

  const providerDecision = decideAutomaticRecovery({
    config: DEFAULT_AUTOMATIC_RECOVERY_CONFIG,
    errorText: "maximum context length exceeded",
    failureCategory: "provider",
    recoveryAttemptsUsed: 0,
    elapsedMs: 1000,
    snapshot: {
      hadToolActivity: false,
      hadPartialOutput: false,
      canDisableToolsForRecovery: true,
    },
  });
  expect(providerDecision.strategy).toBe("retry");
  expect(providerDecision.classifier).toBe("unknown");
});

test("retries unknown failures without compaction when there is no context pressure", () => {
  const decision = decideAutomaticRecovery({
    config: DEFAULT_AUTOMATIC_RECOVERY_CONFIG,
    errorText: "unexpected provider disconnect state",
    recoveryAttemptsUsed: 0,
    elapsedMs: 1000,
    snapshot: {
      hadToolActivity: false,
      hadPartialOutput: false,
      sawCompactionIntent: false,
    },
  });

  expect(decision.recover).toBe(true);
  expect(decision.classifier).toBe("unknown");
  expect(decision.strategy).toBe("retry");
});

test("classifies invalid-request, orphan Responses output and aborted failures as non-recoverable", () => {
  expect(isNonRecoverableFailure("invalid_request_error: malformed schema")).toBe(true);
  expect(isNonRecoverableFailure("OpenAI API error (400): No tool call found for function call output with call_id call_orphan.")).toBe(true);
  expect(isNonRecoverableFailure("Request was aborted")).toBe(true);

  const abortedDecision = decideAutomaticRecovery({
    config: DEFAULT_AUTOMATIC_RECOVERY_CONFIG,
    errorText: "Request was aborted",
    recoveryAttemptsUsed: 0,
    elapsedMs: 1000,
    snapshot: {
      hadToolActivity: false,
      hadPartialOutput: false,
    },
  });

  expect(abortedDecision.recover).toBe(false);
  expect(abortedDecision.classifier).toBe("non_recoverable");
  expect(abortedDecision.strategy).toBeNull();

  const orphanOutputDecision = decideAutomaticRecovery({
    config: DEFAULT_AUTOMATIC_RECOVERY_CONFIG,
    errorText: "OpenAI API error (400): No tool call found for function call output with call_id call_orphan.",
    recoveryAttemptsUsed: 0,
    elapsedMs: 1000,
    snapshot: {
      hadToolActivity: false,
      hadPartialOutput: false,
    },
  });

  expect(orphanOutputDecision.recover).toBe(false);
  expect(orphanOutputDecision.classifier).toBe("session_corruption");
  expect(orphanOutputDecision.strategy).toBeNull();

  const orphanOutputDuringContextPressure = decideAutomaticRecovery({
    config: DEFAULT_AUTOMATIC_RECOVERY_CONFIG,
    errorText: "OpenAI API error (400): No tool call found for function call output with call_id call_orphan.",
    recoveryAttemptsUsed: 1,
    elapsedMs: 2000,
    snapshot: {
      hadToolActivity: true,
      hadPartialOutput: false,
      sawCompactionIntent: true,
      compactionErrorMessage: "prior recovery compaction",
    },
  });
  expect(orphanOutputDuringContextPressure.recover).toBe(false);
  expect(orphanOutputDuringContextPressure.classifier).toBe("session_corruption");
  expect(orphanOutputDuringContextPressure.strategy).toBeNull();
});

test("preserves a mixed terminal-side-effect and failed-tool outcome", () => {
  const decision = decideAutomaticRecovery({
    config: DEFAULT_AUTOMATIC_RECOVERY_CONFIG,
    errorText: "Prompt completed without emitting an assistant reply before finalization (tool activity seen).",
    recoveryAttemptsUsed: 0,
    elapsedMs: 1000,
    snapshot: {
      hadToolActivity: true,
      hadPartialOutput: false,
      hadTerminalTurnOutput: false,
      canDisableToolsForRecovery: true,
      hadToolFailure: true,
      sawTerminalSideEffectToolActivity: true,
    },
  });

  expect(decision.recover).toBe(false);
  expect(decision.classifier).toBe("tool_activity");
  expect(decision.strategy).toBeNull();
});

test("uses a continuation retry after resolved non-terminal tool activity times out", () => {
  const decision = decideAutomaticRecovery({
    config: DEFAULT_AUTOMATIC_RECOVERY_CONFIG,
    errorText: "Timed out after 30s",
    recoveryAttemptsUsed: 0,
    elapsedMs: 1000,
    snapshot: {
      hadToolActivity: true,
      hadPartialOutput: true,
      hadCompletedTurnOutput: true,
      hadTerminalTurnOutput: false,
      sawAssistantToolCall: true,
      canDisableToolsForRecovery: true,
      hasUnresolvedToolExecution: false,
    },
  });

  expect(isTransientFailure("Timed out after 30s")).toBe(true);
  expect(decision.recover).toBe(true);
  expect(decision.classifier).toBe("transient");
  expect(decision.strategy).toBe("retry");
});

test("allows protected handoff decisions without tool-suppression support", () => {
  for (const hadToolActivity of [false, true]) {
    const decision = decideAutomaticRecovery({
      config: DEFAULT_AUTOMATIC_RECOVERY_CONFIG,
      errorText: "503 temporarily unavailable",
      recoveryAttemptsUsed: 0,
      elapsedMs: 1000,
      snapshot: {
        hadToolActivity,
        hadPartialOutput: hadToolActivity,
        hadTerminalTurnOutput: false,
        sawAssistantToolCall: hadToolActivity,
        canDisableToolsForRecovery: false,
        hasUnresolvedToolExecution: hadToolActivity,
      },
    });

    expect(decision).toMatchObject({ recover: true, classifier: "transient", strategy: "retry" });
  }
});

test("suppresses all transient classifiers when transient recovery is disabled", () => {
  const decision = decideAutomaticRecovery({
    config: { ...DEFAULT_AUTOMATIC_RECOVERY_CONFIG, transientRecoveryEnabled: false },
    errorText: "429 Too Many Requests",
    recoveryAttemptsUsed: 0,
    elapsedMs: 1000,
    snapshot: {
      hadToolActivity: true,
      hadPartialOutput: false,
      hadTerminalTurnOutput: false,
      sawAssistantToolCall: true,
      hasUnresolvedToolExecution: false,
    },
  });

  expect(decision.recover).toBe(false);
  expect(decision.classifier).toBe("disabled");
  expect(decision.strategy).toBeNull();

  const noToolDecision = decideAutomaticRecovery({
    config: { ...DEFAULT_AUTOMATIC_RECOVERY_CONFIG, transientRecoveryEnabled: false },
    errorText: "503 temporarily unavailable",
    recoveryAttemptsUsed: 0,
    elapsedMs: 1000,
    snapshot: { hadToolActivity: false, hadPartialOutput: false },
  });
  expect(noToolDecision.recover).toBe(false);
  expect(noToolDecision.classifier).toBe("disabled");
});

test("keeps context-pressure recovery enabled regardless of transient controls", () => {
  const decision = decideAutomaticRecovery({
    config: {
      ...DEFAULT_AUTOMATIC_RECOVERY_CONFIG,
      enabled: false,
      transientRecoveryEnabled: false,
      transientRecoveryToolsEnabled: false,
    },
    errorText: "maximum context length exceeded",
    recoveryAttemptsUsed: 0,
    elapsedMs: 1000,
    snapshot: {
      hadToolActivity: true,
      hadPartialOutput: true,
      hadTerminalTurnOutput: false,
      hasUnresolvedToolExecution: true,
    },
  });

  expect(decision.recover).toBe(true);
  expect(decision.classifier).toBe("context_pressure");
  expect(decision.strategy).toBe("compact_then_retry");
});

test("keeps legacy completed-turn snapshots terminal when terminal detail is absent", () => {
  const decision = decideAutomaticRecovery({
    config: DEFAULT_AUTOMATIC_RECOVERY_CONFIG,
    errorText: "Timed out after 30s",
    recoveryAttemptsUsed: 0,
    elapsedMs: 1000,
    snapshot: {
      hadToolActivity: true,
      hadPartialOutput: true,
      hadCompletedTurnOutput: true,
    },
  });

  expect(decision.recover).toBe(false);
  expect(decision.classifier).toBe("completed_turn_output");
});

test("skips recovery when a terminal assistant reply already completed", () => {
  const decision = decideAutomaticRecovery({
    config: DEFAULT_AUTOMATIC_RECOVERY_CONFIG,
    errorText: "Timed out after 30s",
    recoveryAttemptsUsed: 0,
    elapsedMs: 1000,
    snapshot: {
      hadToolActivity: true,
      hadPartialOutput: true,
      hadCompletedTurnOutput: true,
      hadTerminalTurnOutput: true,
    },
  });

  expect(decision.recover).toBe(false);
  expect(decision.classifier).toBe("completed_turn_output");
});

test("does not continue non-recoverable tool failures", () => {
  const decision = decideAutomaticRecovery({
    config: DEFAULT_AUTOMATIC_RECOVERY_CONFIG,
    errorText: "permission denied by policy",
    recoveryAttemptsUsed: 0,
    elapsedMs: 1000,
    snapshot: {
      hadToolActivity: true,
      hadPartialOutput: true,
      hadCompletedTurnOutput: true,
      hadTerminalTurnOutput: false,
      sawAssistantToolCall: true,
      canDisableToolsForRecovery: true,
    },
  });

  expect(decision.recover).toBe(false);
  expect(decision.classifier).toBe("non_recoverable");
});

test("allows compaction recovery despite tool activity when compaction was in progress", () => {
  const decision = decideAutomaticRecovery({
    config: DEFAULT_AUTOMATIC_RECOVERY_CONFIG,
    errorText: "Timed out waiting for session idle after 30s (streaming=false, compacting=true, retrying=false)",
    recoveryAttemptsUsed: 0,
    elapsedMs: 1000,
    snapshot: {
      hadToolActivity: true,
      hadPartialOutput: true,
      sawCompactionIntent: true,
    },
  });

  expect(decision.recover).toBe(true);
  expect(decision.classifier).toBe("context_pressure");
  expect(decision.strategy).toBe("compact_then_retry");
});

test("allows compaction recovery despite tool activity when error is context-pressure", () => {
  const decision = decideAutomaticRecovery({
    config: DEFAULT_AUTOMATIC_RECOVERY_CONFIG,
    errorText: "maximum context length exceeded",
    recoveryAttemptsUsed: 0,
    elapsedMs: 1000,
    snapshot: {
      hadToolActivity: true,
      hadPartialOutput: true,
    },
  });

  expect(decision.recover).toBe(true);
  expect(decision.classifier).toBe("context_pressure");
  expect(decision.strategy).toBe("compact_then_retry");
});

test("treats tool-use budget exhaustion as terminal tool-history pressure without compaction", () => {
  const decision = decideAutomaticRecovery({
    config: DEFAULT_AUTOMATIC_RECOVERY_CONFIG,
    errorText: "Tool-use budget exceeded before finalization (65/64 tool steps).",
    recoveryAttemptsUsed: 0,
    elapsedMs: 1000,
    snapshot: {
      hadToolActivity: true,
      hadPartialOutput: false,
      toolUseBudgetExceeded: true,
      assistantToolUseMessageCount: 65,
      toolExecutionCount: 64,
    },
  });

  expect(isContextPressureFailure("Tool-use budget exceeded before finalization (65/64 tool steps).")).toBe(false);
  expect(decision.recover).toBe(false);
  expect(decision.classifier).toBe("tool_history_pressure");
  expect(decision.strategy).toBeNull();
});

test("compacts tool-budget exhaustion only when model-aware context pressure was independently observed", () => {
  const decision = decideAutomaticRecovery({
    config: DEFAULT_AUTOMATIC_RECOVERY_CONFIG,
    errorText: "Tool-use budget exceeded before finalization (48/48 tool steps).",
    recoveryAttemptsUsed: 0,
    elapsedMs: 1000,
    snapshot: {
      hadToolActivity: true,
      hadPartialOutput: false,
      toolUseBudgetExceeded: true,
      assistantToolUseMessageCount: 1,
      toolExecutionCount: 48,
      sawCompactionIntent: true,
    },
  });

  expect(decision.recover).toBe(true);
  expect(decision.classifier).toBe("context_pressure");
  expect(decision.strategy).toBe("compact_then_retry");
});

test("does not compact-and-retry again after compaction itself overflows context", () => {
  const decision = decideAutomaticRecovery({
    config: DEFAULT_AUTOMATIC_RECOVERY_CONFIG,
    errorText: "invalid_request_error: context_length_exceeded: Your input exceeds the context window of this model",
    recoveryAttemptsUsed: 1,
    elapsedMs: 2000,
    snapshot: {
      hadToolActivity: false,
      hadPartialOutput: false,
      compactionErrorMessage: "context_length_exceeded during compaction",
      sawCompactionIntent: true,
    },
  });

  expect(decision.recover).toBe(false);
  expect(decision.classifier).toBe("compaction_failure");
  expect(decision.strategy).toBeNull();
});

test("stops recovery after the configured attempt budget", () => {
  const decision = decideAutomaticRecovery({
    config: { ...DEFAULT_AUTOMATIC_RECOVERY_CONFIG, maxAttempts: 2, totalBudgetMs: 30_000, enabled: true },
    errorText: "Response ended with an error before finalization",
    recoveryAttemptsUsed: 2,
    elapsedMs: 5000,
    snapshot: {
      hadToolActivity: false,
      hadPartialOutput: true,
    },
  });

  expect(decision.recover).toBe(false);
  expect(decision.classifier).toBe("budget_exhausted");
});

test("treats partial-output interruptions as transient retry candidates", () => {
  const decision = decideAutomaticRecovery({
    config: DEFAULT_AUTOMATIC_RECOVERY_CONFIG,
    errorText: "Response ended with an error before finalization",
    recoveryAttemptsUsed: 0,
    elapsedMs: 1000,
    snapshot: {
      hadToolActivity: false,
      hadPartialOutput: true,
      canDisableToolsForRecovery: true,
    },
  });

  expect(isTransientFailure("Response ended with an error before finalization")).toBe(true);
  expect(decision.recover).toBe(true);
  expect(decision.classifier).toBe("transient");
  expect(decision.strategy).toBe("retry");
});

test("treats WebSocket 1006 provider disconnects as transient retry candidates", () => {
  const decision = decideAutomaticRecovery({
    config: DEFAULT_AUTOMATIC_RECOVERY_CONFIG,
    errorText: "WebSocket closed 1006 Connection ended",
    recoveryAttemptsUsed: 0,
    elapsedMs: 1000,
    snapshot: {
      hadToolActivity: false,
      hadPartialOutput: false,
      canDisableToolsForRecovery: true,
    },
  });

  expect(isTransientFailure("WebSocket closed 1006 Connection ended")).toBe(true);
  expect(decision.recover).toBe(true);
  expect(decision.classifier).toBe("transient");
  expect(decision.strategy).toBe("retry");
});

test("treats transient DNS lookup failures as retry candidates", () => {
  for (const message of [
    "getaddrinfo EAI_AGAIN api.openai.com",
    "DNS lookup failed for api.githubcopilot.com",
    "fetch failed: getaddrinfo ENOTFOUND api.example.invalid",
  ]) {
    const decision = decideAutomaticRecovery({
      config: DEFAULT_AUTOMATIC_RECOVERY_CONFIG,
      errorText: message,
      recoveryAttemptsUsed: 0,
      elapsedMs: 1000,
      snapshot: {
        hadToolActivity: false,
        hadPartialOutput: false,
        canDisableToolsForRecovery: true,
      },
    });

    expect(isTransientFailure(message)).toBe(true);
    expect(decision.recover).toBe(true);
    expect(decision.classifier).toBe("transient");
    expect(decision.strategy).toBe("retry");
  }
});

test("retries a thinking-only stop once before escalating", () => {
  const first = decideAutomaticRecovery({
    config: DEFAULT_AUTOMATIC_RECOVERY_CONFIG,
    errorText: "Prompt completed without emitting an assistant reply before finalization (provider stopped after emitting thinking without a final assistant reply, last stop reason: stop, session delta: 2 appended entries).",
    recoveryAttemptsUsed: 0,
    elapsedMs: 1000,
    snapshot: {
      hadToolActivity: false,
      hadPartialOutput: false,
      hadCompletedTurnOutput: false,
      sawThinkingOnlyStop: true,
    },
  });

  expect(first.recover).toBe(true);
  expect(first.classifier).toBe("thinking_only_stop");
  expect(first.strategy).toBe("retry");

  const second = decideAutomaticRecovery({
    config: DEFAULT_AUTOMATIC_RECOVERY_CONFIG,
    errorText: "Prompt completed without emitting an assistant reply before finalization (provider stopped after emitting thinking without a final assistant reply, last stop reason: stop, session delta: 2 appended entries).",
    recoveryAttemptsUsed: 1,
    elapsedMs: 3000,
    snapshot: {
      hadToolActivity: false,
      hadPartialOutput: false,
      hadCompletedTurnOutput: false,
      sawThinkingOnlyStop: true,
    },
  });

  expect(second.recover).toBe(false);
  expect(second.classifier).toBe("thinking_only_stop");
  expect(second.strategy).toBeNull();
});

test("escalates repeated thinking-only stop to compact-then-retry when context pressure is flagged", () => {
  const decision = decideAutomaticRecovery({
    config: DEFAULT_AUTOMATIC_RECOVERY_CONFIG,
    errorText: "Prompt completed without emitting an assistant reply before finalization (provider stopped after emitting thinking without a final assistant reply, last stop reason: stop, session delta: 2 appended entries).",
    recoveryAttemptsUsed: 1,
    elapsedMs: 3000,
    snapshot: {
      hadToolActivity: false,
      hadPartialOutput: false,
      hadCompletedTurnOutput: false,
      sawThinkingOnlyStop: true,
      sawCompactionIntent: true,
    },
  });

  expect(decision.recover).toBe(true);
  expect(decision.classifier).toBe("context_pressure");
  expect(decision.strategy).toBe("compact_then_retry");
});

test("repeated mutation failures use one bounded tools-disabled finalization", () => {
  const decision = decideTypedAutomaticRecovery({
    config: DEFAULT_AUTOMATIC_RECOVERY_CONFIG,
    failureCategory: "mutation_repetition",
    recoveryAttemptsUsed: 0,
    elapsedMs: 1000,
    snapshot: {
      hadToolActivity: true,
      hadPartialOutput: false,
      canDisableToolsForRecovery: true,
      hasUnresolvedToolExecution: false,
    },
  });

  expect(decision).toMatchObject({
    recover: true,
    classifier: "mutation_repetition",
    strategy: "finalize",
  });

  expect(decideTypedAutomaticRecovery({
    config: DEFAULT_AUTOMATIC_RECOVERY_CONFIG,
    failureCategory: "mutation_repetition",
    recoveryAttemptsUsed: 1,
    mutationContainmentRecoveryAttemptsUsed: 0,
    elapsedMs: 2000,
    snapshot: {
      hadToolActivity: true,
      hadPartialOutput: false,
      canDisableToolsForRecovery: true,
      hasUnresolvedToolExecution: false,
    },
  })).toMatchObject({ recover: true, classifier: "mutation_repetition", strategy: "finalize" });

  expect(decideTypedAutomaticRecovery({
    config: DEFAULT_AUTOMATIC_RECOVERY_CONFIG,
    failureCategory: "mutation_repetition",
    recoveryAttemptsUsed: 1,
    mutationContainmentRecoveryAttemptsUsed: 1,
    elapsedMs: 2000,
    snapshot: {
      hadToolActivity: true,
      hadPartialOutput: false,
      canDisableToolsForRecovery: true,
      hasUnresolvedToolExecution: false,
    },
  })).toMatchObject({ recover: false, classifier: "mutation_repetition", strategy: null });
});
