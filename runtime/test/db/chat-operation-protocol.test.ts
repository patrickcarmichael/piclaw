import { describe, expect, test } from "bun:test";
import { CHAT_OPERATION_PHASES, compareChatOperationOwner, isLegalChatOperationTransition,
  transitionChatOperationState, type ChatOperationState } from "../../src/db/chat-operations.js";

const operation = (): ChatOperationState => ({ chatJid: "web:protocol", operationId: "op-1", sourceSeq: 7,
  phase: "pending", generation: 0, cancellation: null });
const owner = (state: ChatOperationState) => ({ operationId: state.operationId, sourceSeq: state.sourceSeq,
  phase: state.phase, generation: state.generation });

describe("chat operation protocol", () => {
  test("has no parked terminal phase and accepts only legal transitions", () => {
    expect([...CHAT_OPERATION_PHASES]).toEqual(["pending", "preflight", "running", "waiting", "blocked"]);
    const legal = new Set(["pending:preflight", "pending:blocked", "preflight:running", "preflight:waiting",
      "preflight:blocked", "running:waiting", "running:blocked", "waiting:running", "waiting:blocked", "blocked:pending"]);
    for (const from of CHAT_OPERATION_PHASES) for (const to of CHAT_OPERATION_PHASES) {
      expect(isLegalChatOperationTransition(from, to)).toBe(legal.has(`${from}:${to}`));
    }
  });

  test("compares operation, source, phase and one generation", () => {
    const current = operation(); const expected = owner(current);
    expect(compareChatOperationOwner(null, expected)).toEqual({ ok: false, reason: "no_operation" });
    expect(compareChatOperationOwner(current, { ...expected, operationId: "stale" })).toEqual({ ok: false, reason: "operation_id_mismatch" });
    expect(compareChatOperationOwner(current, { ...expected, sourceSeq: 8 })).toEqual({ ok: false, reason: "source_mismatch" });
    expect(compareChatOperationOwner(current, { ...expected, phase: "preflight" })).toEqual({ ok: false, reason: "phase_mismatch" });
    expect(compareChatOperationOwner(current, { ...expected, generation: 1 })).toEqual({ ok: false, reason: "generation_mismatch" });
    expect(compareChatOperationOwner(current, expected)).toEqual({ ok: true });
  });

  test("accepted transitions increment the generation and invalid transitions do not mutate", () => {
    const pending = operation();
    expect(transitionChatOperationState(pending, owner(pending), "running")).toEqual({
      status: "rejected", reason: "invalid_transition", operation: pending,
    });
    const preflight = transitionChatOperationState(pending, owner(pending), "preflight");
    expect(preflight.status).toBe("applied");
    if (preflight.status !== "applied") return;
    expect(preflight.operation).toMatchObject({ phase: "preflight", generation: 1 });
    const running = transitionChatOperationState(preflight.operation, owner(preflight.operation), "running");
    expect(running.status).toBe("applied");
    if (running.status === "applied") expect(running.operation).toMatchObject({ phase: "running", generation: 2 });
  });

  test("all phase effects are prohibited after cancellation", () => {
    const cancelled = { ...operation(), cancellation: { cause: "abort", requestedAt: "now" }, generation: 1 };
    expect(transitionChatOperationState(cancelled, owner(cancelled), "preflight")).toEqual({
      status: "rejected", reason: "operation_cancelled", operation: cancelled,
    });
  });
});
