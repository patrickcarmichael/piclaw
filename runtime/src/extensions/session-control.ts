/**
 * session-control – cross-session operational controls.
 *
 * Separate from the chat relay tool: chat sends messages, while this tool
 * inspects and mutates target session runtime state (compact, abort, model
 * switch, failed-run handling, wake).
 */
import { Type } from "typebox";
import type { AgentToolResult, ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { getChatJid } from "../core/chat-context.js";

export type SessionControlAction =
  | "inspect"
  | "assess_stuck"
  | "compact"
  | "abort"
  | "switch_model"
  | "retry_failed"
  | "skip_failed"
  | "wake"
  | "unblock";

export interface SessionControlRequest {
  source_chat_jid: string;
  action: SessionControlAction;
  target_chat_jid?: string;
  target_agent_name?: string;
  expected_operation_id?: string;
  model?: string;
  instructions?: string;
  force?: boolean;
}

export interface SessionControlResult {
  ok: boolean;
  action: SessionControlAction;
  source_chat_jid: string;
  target_chat_jid: string;
  target_agent_name?: string | null;
  target_session_tree?: Record<string, unknown> | null;
  status?: string;
  message?: string;
  assessment?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  error?: string;
  [key: string]: unknown;
}

export type SessionControlHandler = (request: SessionControlRequest) => Promise<SessionControlResult>;

let registeredSessionControlHandler: SessionControlHandler | undefined;

export function setSessionControlHandler(fn: SessionControlHandler | undefined): void {
  registeredSessionControlHandler = fn;
}

const SessionControlSchema = Type.Object({
  action: Type.Optional(Type.Union([
    Type.Literal("inspect"),
    Type.Literal("assess_stuck"),
    Type.Literal("compact"),
    Type.Literal("abort"),
    Type.Literal("switch_model"),
    Type.Literal("retry_failed"),
    Type.Literal("skip_failed"),
    Type.Literal("wake"),
    Type.Literal("unblock"),
  ], { description: "Session-control action. Defaults to inspect." })),
  target_chat_jid: Type.Optional(Type.String({ description: "Target chat JID to inspect or control. Fallback only; prefer target_agent_name/@alias so the runtime can resolve the internal session tree." })),
  target_agent_name: Type.Optional(Type.String({ description: "Preferred target agent handle/alias, e.g. research or @research. Resolves through the internal session tree mapping." })),
  expected_operation_id: Type.Optional(Type.String({ description: "Required for abort and unblock. Copy operation_id from a fresh inspect/assess result; stale or absent owners are no-ops." })),
  model: Type.Optional(Type.String({ description: "Model label for switch_model, e.g. github-copilot/gpt-5.4." })),
  instructions: Type.Optional(Type.String({ description: "Optional compaction instructions for compact." })),
  force: Type.Optional(Type.Boolean({ description: "Allow higher-risk control action variants where supported." })),
});

type SessionControlParams = {
  action?: SessionControlAction;
  target_chat_jid?: string;
  target_agent_name?: string;
  expected_operation_id?: string;
  model?: string;
  instructions?: string;
  force?: boolean;
};

const HINT = [
  "## Cross-session session control",
  "Use session_control for operational control of another session: inspect, assess_stuck, compact, abort, switch_model, retry_failed, skip_failed, wake, or unblock.",
  "This is intentionally separate from the chat tool. chat relays messages; session_control mutates session runtime state.",
  "Prefer target_agent_name with an @alias over raw target_chat_jid/session IDs; aliases resolve through the internal Pi session-tree registry.",
  "Inspect or assess_stuck returns the resolved target and active operation identity. Pass that operation_id as expected_operation_id to abort or unblock; stale decisions are no-ops.",
].join("\n");

function err(message: string, details: Record<string, unknown> = {}): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: "text", text: message }],
    details: { ok: false, error: message, ...details },
  };
}

function normalizeTargetAgentName(value: string | undefined): string {
  return String(value || "").trim().replace(/^@+/, "").trim();
}

function formatResult(result: SessionControlResult): string {
  if (!result.ok) return result.error || result.message || "Session control failed.";
  const target = result.target_agent_name
    ? `@${result.target_agent_name} (${result.target_chat_jid})`
    : result.target_chat_jid;
  if (result.action === "inspect") return `Inspected ${target}.`;
  if (result.action === "assess_stuck") return `Assessment for ${target}: ${result.assessment || "unknown"}.`;
  return result.message || `${result.action} completed for ${target}.`;
}

export const sessionControl: ExtensionFactory = (pi: ExtensionAPI) => {
  pi.on("before_agent_start", async (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${HINT}`,
  }));

  pi.registerTool({
    name: "session_control",
    label: "session_control",
    description: "Inspect or control another @alias/session: assess stuck state, compact, abort, switch model, handle failed runs, wake it, or unblock it.",
    promptSnippet: "session_control: inspect/assess/compact/abort/switch_model/retry_failed/skip_failed/wake/unblock another session. Prefer target_agent_name='@alias' over raw chat/session IDs. Separate from chat relay.",
    parameters: SessionControlSchema,
    async execute(_toolCallId, params: SessionControlParams) {
      const sourceChatJid = getChatJid("").trim();
      if (!sourceChatJid) return err("Cannot determine the source chat. session_control requires an active chat context.");

      const action = params.action || "inspect";
      const targetChatJid = params.target_chat_jid?.trim() || "";
      const targetAgentName = normalizeTargetAgentName(params.target_agent_name);
      if (!targetChatJid && !targetAgentName) return err("Provide target_agent_name (@alias preferred) or target_chat_jid.");
      if (targetChatJid && targetAgentName) return err("Provide only one target selector: target_chat_jid or target_agent_name.");
      const expectedOperationId = params.expected_operation_id?.trim() || "";
      if ((action === "abort" || action === "unblock") && !expectedOperationId) {
        return err(`${action} requires expected_operation_id from a fresh inspect or assess_stuck result.`);
      }
      if (action === "switch_model" && !params.model?.trim()) return err("switch_model requires model.");

      if (!registeredSessionControlHandler) {
        return err("Cross-session session control is unavailable in this runtime.");
      }

      try {
        const result = await registeredSessionControlHandler({
          source_chat_jid: sourceChatJid,
          action,
          ...(targetChatJid ? { target_chat_jid: targetChatJid } : {}),
          ...(targetAgentName ? { target_agent_name: targetAgentName } : {}),
          ...(expectedOperationId ? { expected_operation_id: expectedOperationId } : {}),
          ...(params.model?.trim() ? { model: params.model.trim() } : {}),
          ...(params.instructions?.trim() ? { instructions: params.instructions.trim() } : {}),
          ...(params.force !== undefined ? { force: Boolean(params.force) } : {}),
        });
        return {
          content: [{ type: "text", text: formatResult(result) }],
          details: { tool: "session_control", ...result },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error || "Session control failed.");
        return err(message || "Session control failed.", { action });
      }
    },
  });
};
