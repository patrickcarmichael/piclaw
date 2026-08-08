/**
 * Per-chat ownership and serialization boundary for persistent AgentSession mutations.
 *
 * Durable work must present the exact active operation owner. Legacy work is
 * admitted only while no durable operation owns the chat. Abort is the sole
 * out-of-band exception: it compares the same ownership immediately before the
 * effect, but does not wait behind the mutation it is intended to interrupt.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import {
  compareChatOperationOwner,
  getChatOperation,
  type ChatOperationMismatch,
  type ChatOperationOwner,
  type ChatOperationState,
} from "../db/chat-operations.js";

export const SESSION_MUTATION_CLASSES = [
  "prompt",
  "compaction",
  "rotation",
  "control",
  "model",
  "thinking",
  "session",
  "session_tree",
  "recovery",
  "queue",
  "lifecycle",
  "abort",
] as const;

export type SessionMutationClass = (typeof SESSION_MUTATION_CLASSES)[number];

export type SessionMutationAccess =
  | { scope: "operation"; owner: ChatOperationOwner }
  | { scope: "legacy" };

export interface SessionMutationRequest {
  operationOwner?: ChatOperationOwner;
}

export type SessionMutationRejectionReason = ChatOperationMismatch
  | "legacy_conflict"
  | "operation_mutation_forbidden"
  | "active_mutation_mismatch";

export class SessionMutationRejectedError extends Error {
  readonly name = "SessionMutationRejectedError";

  constructor(
    readonly chatJid: string,
    readonly mutation: SessionMutationClass,
    readonly reason: SessionMutationRejectionReason,
  ) {
    super(`Session mutation ${mutation} rejected for ${chatJid}: ${reason}`);
  }
}

interface SessionMutationContext {
  chatJid: string;
  access: SessionMutationAccess;
}

export interface SessionMutationGatewayOptions {
  getOperation?: (chatJid: string) => ChatOperationState | null;
}

export function sessionMutationAccess(request: SessionMutationRequest = {}): SessionMutationAccess {
  return request.operationOwner
    ? { scope: "operation", owner: request.operationOwner }
    : { scope: "legacy" };
}

const OPERATION_MUTATION_CLASSES = new Set<SessionMutationClass>([
  "prompt",
  "compaction",
  "rotation",
  "recovery",
  "abort",
]);

function sameOwner(left: ChatOperationOwner, right: ChatOperationOwner): boolean {
  return left.operationId === right.operationId
    && left.sourceSeq === right.sourceSeq
    && left.phase === right.phase
    && left.generation === right.generation;
}

/** One serialized persistent-session mutation lane per chat. */
export class SessionMutationGateway {
  private readonly context = new AsyncLocalStorage<SessionMutationContext>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly activeAccessByChat = new Map<string, SessionMutationAccess>();
  private readonly getOperation: (chatJid: string) => ChatOperationState | null;

  constructor(options: SessionMutationGatewayOptions = {}) {
    this.getOperation = options.getOperation ?? getChatOperation;
  }

  currentAccess(chatJid: string): SessionMutationAccess | null {
    const current = this.context.getStore();
    return current?.chatJid === chatJid ? current.access : null;
  }

  async run<T>(
    chatJid: string,
    mutation: Exclude<SessionMutationClass, "abort">,
    access: SessionMutationAccess,
    action: () => Promise<T> | T,
  ): Promise<T> {
    const inherited = this.context.getStore();
    if (inherited?.chatJid === chatJid) {
      if (access.scope !== inherited.access.scope
        || (access.scope === "operation"
          && inherited.access.scope === "operation"
          && !sameOwner(access.owner, inherited.access.owner))) {
        throw new SessionMutationRejectedError(chatJid, mutation, "generation_mismatch");
      }
      this.assertAccess(chatJid, mutation, access);
      return await action();
    }

    // Fail fast instead of waiting behind an operation the caller cannot own.
    this.assertAccess(chatJid, mutation, access);

    const previous = this.tails.get(chatJid) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.tails.set(chatJid, tail);

    await previous.catch(() => undefined);
    try {
      // Ownership can change while this mutation waits behind the prior one.
      this.assertAccess(chatJid, mutation, access);
      this.activeAccessByChat.set(chatJid, access);
      return await this.context.run({ chatJid, access }, action);
    } finally {
      if (this.activeAccessByChat.get(chatJid) === access) this.activeAccessByChat.delete(chatJid);
      release();
      if (this.tails.get(chatJid) === tail) {
        void tail.finally(() => {
          if (this.tails.get(chatJid) === tail) this.tails.delete(chatJid);
        });
      }
    }
  }

  async runInheritedOrLegacy<T>(
    chatJid: string,
    mutation: Exclude<SessionMutationClass, "abort">,
    action: () => Promise<T> | T,
  ): Promise<T> {
    return this.run(chatJid, mutation, this.currentAccess(chatJid) ?? { scope: "legacy" }, action);
  }

  async compareAndActAbort<T>(
    chatJid: string,
    access: SessionMutationAccess,
    action: () => Promise<T> | T,
  ): Promise<T> {
    this.assertAccess(chatJid, "abort", access);
    const activeAccess = this.activeAccessByChat.get(chatJid);
    if (!activeAccess || !this.isSameAccess(activeAccess, access)) {
      throw new SessionMutationRejectedError(chatJid, "abort", "active_mutation_mismatch");
    }
    return await this.context.run({ chatJid, access }, action);
  }

  /**
   * Validate the durable owner, persist cancellation synchronously, then abort
   * only the lane occupant that still has that exact pre-cancellation owner.
   * The callback boundary prevents post-cancellation generation drift from
   * becoming a reusable ownership-check bypass.
   */
  async cancelAndActAbort<T, C>(
    chatJid: string,
    access: SessionMutationAccess,
    cancel: () => C,
    cancellationApplied: (result: C) => boolean,
    action: () => Promise<T> | T,
  ): Promise<{ cancellation: C; acted: boolean; result?: T }> {
    this.assertAccess(chatJid, "abort", access);
    const cancellation = cancel();
    if (!cancellationApplied(cancellation)) return { cancellation, acted: false };

    const activeAccess = this.activeAccessByChat.get(chatJid);
    if (!activeAccess || !this.isSameAccess(activeAccess, access)) {
      return { cancellation, acted: false };
    }
    const result = await this.context.run({ chatJid, access }, action);
    return { cancellation, acted: true, result };
  }

  private isSameAccess(left: SessionMutationAccess, right: SessionMutationAccess): boolean {
    if (left.scope !== right.scope) return false;
    return left.scope === "legacy" || (right.scope === "operation" && sameOwner(left.owner, right.owner));
  }

  private assertAccess(
    chatJid: string,
    mutation: SessionMutationClass,
    access: SessionMutationAccess,
  ): void {
    const active = this.getOperation(chatJid);
    if (access.scope === "legacy") {
      if (active) throw new SessionMutationRejectedError(chatJid, mutation, "legacy_conflict");
      return;
    }
    if (!OPERATION_MUTATION_CLASSES.has(mutation)) {
      throw new SessionMutationRejectedError(chatJid, mutation, "operation_mutation_forbidden");
    }
    const comparison = compareChatOperationOwner(active, access.owner);
    if (!comparison.ok) throw new SessionMutationRejectedError(chatJid, mutation, comparison.reason);
  }
}
