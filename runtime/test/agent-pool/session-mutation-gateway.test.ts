import { describe, expect, test } from "bun:test";

import type { ChatOperationOwner, ChatOperationState } from "../../src/db.js";
import {
  SessionMutationGateway,
  SessionMutationRejectedError,
} from "../../src/agent-pool/session-mutation-gateway.js";

function operation(generation = 0, phase: ChatOperationState["phase"] = "running"): ChatOperationState {
  return {
    chatJid: "web:test",
    operationId: "op-1",
    sourceSeq: 7,
    phase,
    generation,
    cancellation: null,
  };
}

function owner(state: ChatOperationState): ChatOperationOwner {
  return {
    operationId: state.operationId,
    sourceSeq: state.sourceSeq,
    phase: state.phase,
    generation: state.generation,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("SessionMutationGateway", () => {
  test("admits legacy mutations only when no durable operation owns the chat", async () => {
    let active: ChatOperationState | null = null;
    let effects = 0;
    const gateway = new SessionMutationGateway({ getOperation: () => active });

    await gateway.run("web:test", "control", { scope: "legacy" }, () => { effects += 1; });
    active = operation();

    await expect(gateway.run("web:test", "control", { scope: "legacy" }, () => { effects += 1; }))
      .rejects.toMatchObject({
        name: "SessionMutationRejectedError",
        reason: "legacy_conflict",
      });
    expect(effects).toBe(1);
  });

  test("requires the exact operation owner including phase and generation", async () => {
    const active = operation(3, "running");
    const gateway = new SessionMutationGateway({ getOperation: () => active });
    let effects = 0;

    await gateway.run("web:test", "prompt", { scope: "operation", owner: owner(active) }, () => { effects += 1; });
    await expect(gateway.run("web:test", "prompt", {
      scope: "operation",
      owner: { ...owner(active), generation: 2 },
    }, () => { effects += 1; })).rejects.toMatchObject({ reason: "generation_mismatch" });
    await expect(gateway.run("web:test", "prompt", {
      scope: "operation",
      owner: { ...owner(active), phase: "waiting" },
    }, () => { effects += 1; })).rejects.toMatchObject({ reason: "phase_mismatch" });
    expect(effects).toBe(1);
  });

  test("rechecks ownership after waiting in the per-chat lane", async () => {
    let active = operation();
    const gateway = new SessionMutationGateway({ getOperation: () => active });
    const entered = deferred();
    const release = deferred();
    const first = gateway.run("web:test", "prompt", { scope: "operation", owner: owner(active) }, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;

    let staleEffect = false;
    const queued = gateway.run("web:test", "compaction", { scope: "operation", owner: owner(active) }, () => {
      staleEffect = true;
    });
    active = operation(1);
    release.resolve();

    await first;
    await expect(queued).rejects.toMatchObject({ reason: "generation_mismatch" });
    expect(staleEffect).toBe(false);
  });

  test("inherits the exact owner for nested extension and recovery mutations", async () => {
    const active = operation();
    const gateway = new SessionMutationGateway({ getOperation: () => active });
    const effects: string[] = [];

    await gateway.run("web:test", "prompt", { scope: "operation", owner: owner(active) }, async () => {
      effects.push("prompt");
      await gateway.runInheritedOrLegacy("web:test", "session_tree", () => { effects.push("nested"); });
    });

    expect(effects).toEqual(["prompt", "nested"]);
  });

  test("does not let a newly claimed operation abort an earlier legacy lane occupant", async () => {
    let active: ChatOperationState | null = null;
    const gateway = new SessionMutationGateway({ getOperation: () => active });
    const entered = deferred();
    const release = deferred();
    const legacy = gateway.run("web:test", "control", { scope: "legacy" }, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;

    active = operation();
    await expect(gateway.compareAndActAbort("web:test", {
      scope: "operation",
      owner: owner(active),
    }, () => {})).rejects.toMatchObject({ reason: "active_mutation_mismatch" });

    release.resolve();
    await legacy;
  });

  test("allows only exact compare-and-act abort to bypass an occupied lane", async () => {
    let active: ChatOperationState | null = operation();
    const gateway = new SessionMutationGateway({ getOperation: () => active });
    const entered = deferred();
    const release = deferred();
    const running = gateway.run("web:test", "prompt", { scope: "operation", owner: owner(active) }, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;

    let aborted = false;
    await gateway.compareAndActAbort("web:test", { scope: "operation", owner: owner(active) }, () => {
      aborted = true;
    });
    expect(aborted).toBe(true);

    active = operation(1);
    await expect(gateway.compareAndActAbort("web:test", {
      scope: "operation",
      owner: owner(operation()),
    }, () => {})).rejects.toBeInstanceOf(SessionMutationRejectedError);
    await expect(gateway.compareAndActAbort("web:test", { scope: "legacy" }, () => {}))
      .rejects.toMatchObject({ reason: "legacy_conflict" });

    release.resolve();
    await running;
  });
});
