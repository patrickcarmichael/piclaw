/**
 * web/ui-bridge.ts – Bridges pi-agent's ExtensionUIContext to SSE events.
 *
 * Translates extension UI requests (confirmation dialogs, input prompts)
 * into SSE events for the web UI, and resolves them when the user responds
 * via the API. This allows agent extensions to interact with the user
 * through the web UI in real time.
 *
 * Consumers: channels/web.ts sets up the UI bridge during agent runs.
 */

import type { AgentSessionRuntime, ExtensionUIContext } from "@earendil-works/pi-coding-agent";

import type { BoundSessionMutationRunner } from "../../../agent-pool.js";
import { createLogger, debugSuppressedError } from "../../../utils/logger.js";
import { setServerUiThemeConfig } from "../ui-state.js";
import { createFallbackTheme } from "./theme.js";

const log = createLogger("web.ui-bridge");

const WEB_THEME_NAMES = [
  "default",
  "tango",
  "xterm",
  "monokai",
  "monokai-pro",
  "ristretto",
  "dracula",
  "catppuccin",
  "nord",
  "gruvbox",
  "solarized",
  "tokyo",
  "miasma",
  "github",
  "gotham",
] as const;

type WebThemePayload = { theme: string; tint?: string | null };

function normalizeThemePayload(input: unknown): WebThemePayload | null {
  if (!input) return null;
  if (typeof input === "string") {
    return { theme: input };
  }
  if (typeof input === "object") {
    const obj = input as { theme?: unknown; name?: unknown; tint?: unknown };
    const name = typeof obj.theme === "string" ? obj.theme : typeof obj.name === "string" ? obj.name : "";
    if (!name) return null;
    const tint = typeof obj.tint === "string" ? obj.tint : obj.tint === null ? null : undefined;
    return { theme: name, tint };
  }
  return null;
}

/** Channel contract required by the web UI bridge request/response helpers. */
export interface UiBridgeChannel {
  broadcastEvent(eventType: string, data: unknown): void;
}

interface UiBridgeOptions {
  waitForIdleTimeoutMs?: number;
  chatStateTtlMs?: number;
}

interface PendingUiRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
  kind: string;
  chatJid: string;
}

const DEFAULT_CHAT_STATE_TTL_MS = 24 * 60 * 60 * 1000;

/** Bridges extension UI prompts (confirm/input) to SSE events and API responses. */
export class UiBridge {
  pendingUiRequests = new Map<string, PendingUiRequest>();
  uiRequestCounter = 0;
  editorTextByChat = new Map<string, string>();
  themeByChat = new Map<string, WebThemePayload>();
  private readonly chatStateTouchedAtByChat = new Map<string, number>();
  fallbackTheme = createFallbackTheme();

  constructor(
    private channel: UiBridgeChannel,
    private readonly options: UiBridgeOptions = {},
  ) {}

  async bindSession(
    runtime: AgentSessionRuntime,
    chatJid: string,
    mutate: BoundSessionMutationRunner,
  ): Promise<void> {
    if (!chatJid.startsWith("web:")) return;
    this.touchChat(chatJid);

    const boundSession = runtime.session;

    const waitForIdle = async (): Promise<void> => {
      const session = runtime.session;
      if (!session.isStreaming) return;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      let settled = false;
      const timeoutMs = this.getWaitForIdleTimeoutMs();
      let finish = () => {};
      const unsubscribe = session.subscribe((event) => {
        if (event.type === "agent_end" || !session.isStreaming) {
          finish();
        }
      });

      try {
        const waitForSession = new Promise<void>((resolve) => {
          finish = () => {
            if (settled) return;
            settled = true;
            if (timeoutId) {
              clearTimeout(timeoutId);
              timeoutId = null;
            }
            resolve();
          };

          timeoutId = setTimeout(() => {
            log.warn("Timed out waiting for web session to go idle", {
              operation: "web_theming_ui_bridge.wait_for_idle_timeout",
              chatJid,
              timeoutMs,
            });
            finish();
          }, timeoutMs);
        });

        await waitForSession;
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
        unsubscribe();
      }
    };

    const uiContext = this.createUiContext(chatJid);
    if (boundSession !== runtime.session) {
      debugSuppressedError(log, "Skipped binding extension UI context for a replaced session", {
        operation: "web_theming_ui_bridge.bind_session.replaced_before_bind",
        chatJid,
      });
      return;
    }

    await boundSession.bindExtensions({
      uiContext,
      commandContextActions: {
        waitForIdle,
        newSession: async (options) => mutate("session", () => runtime.newSession(options)),
        fork: async (entryId, options) => mutate("session_tree", () => runtime.fork(entryId, options)),
        navigateTree: async (targetId, options) => mutate("session_tree", async (currentRuntime) => {
          const result = await currentRuntime.session.navigateTree(targetId, options);
          return { cancelled: result.cancelled };
        }),
        switchSession: async (sessionPath, options) => mutate("session", () => runtime.switchSession(sessionPath, options)),
        reload: () => mutate("session", (currentRuntime) => currentRuntime.session.reload()),
      },
      onError: (error) => {
        const message = typeof error?.error === "string" ? error.error : String(error?.error ?? error);
        const staleSessionCtx = message.includes("This extension ctx is stale after session replacement or reload");
        if (staleSessionCtx) {
          debugSuppressedError(log, "Suppressed stale extension ctx error (always benign after idle/resume)", {
            operation: "web_theming_ui_bridge.on_error.stale_ctx_suppressed",
            chatJid,
            event: error?.event,
            extensionPath: error?.extensionPath,
          });
          return;
        }

        const formattedError = [
          error.error || null,
          error.event ? `during ${error.event}` : null,
          error.extensionPath ? `in ${error.extensionPath}` : null,
        ].filter(Boolean).join(" ") || String(error);
        log.error("Extension UI error", {
          operation: "web_theming_ui_bridge.on_error",
          chatJid,
          err: error,
        });
        this.channel.broadcastEvent("extension_ui_error", {
          chat_jid: chatJid,
          error: formattedError,
        });
      },
    });
  }

  createUiContext(chatJid: string): ExtensionUIContext {
    this.touchChat(chatJid);
    const requestUiResponse = async (
      kind: string,
      payload: Record<string, unknown>,
      timeoutMs = 120000
    ): Promise<unknown> => {
      this.touchChat(chatJid);
      const requestId = `ui-${Date.now()}-${++this.uiRequestCounter}`;
      return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          this.pendingUiRequests.delete(requestId);
          this.channel.broadcastEvent("extension_ui_timeout", { request_id: requestId, kind, chat_jid: chatJid });
          resolve(undefined);
        }, timeoutMs);

        this.pendingUiRequests.set(requestId, { resolve, reject, timeoutId, kind, chatJid });
        this.channel.broadcastEvent("extension_ui_request", {
          request_id: requestId,
          kind,
          chat_jid: chatJid,
          ...payload,
        });
      });
    };

    const fallbackTheme = this.fallbackTheme;

    return {
      select: async (title, options, opts) => {
        const timeoutMs = typeof opts?.timeout === "number" ? opts.timeout : 120000;
        const result = await requestUiResponse("select", { title, options, opts }, timeoutMs);
        return typeof result === "string" ? result : undefined;
      },
      confirm: async (title, message, opts) => {
        const timeoutMs = typeof opts?.timeout === "number" ? opts.timeout : 120000;
        const result = await requestUiResponse("confirm", { title, message, opts }, timeoutMs);
        return Boolean(result);
      },
      input: async (title, placeholder, opts) => {
        const timeoutMs = typeof opts?.timeout === "number" ? opts.timeout : 120000;
        const result = await requestUiResponse("input", { title, placeholder, opts }, timeoutMs);
        return typeof result === "string" ? result : undefined;
      },
      notify: (message, type) => {
        this.channel.broadcastEvent("extension_ui_notify", { chat_jid: chatJid, message, type });
      },
      onTerminalInput: () => () => {},
      setStatus: (key, text) => {
        this.channel.broadcastEvent("extension_ui_status", { chat_jid: chatJid, key, text });
      },
      setWorkingMessage: (message) => {
        this.channel.broadcastEvent("extension_ui_working", { chat_jid: chatJid, message });
      },
      setWorkingIndicator: (options) => {
        this.channel.broadcastEvent("extension_ui_working_indicator", {
          chat_jid: chatJid,
          ...(Array.isArray(options?.frames) ? { frames: options.frames } : {}),
          ...(typeof options?.intervalMs === "number" && Number.isFinite(options.intervalMs)
            ? { interval_ms: options.intervalMs }
            : {}),
        });
      },
      setWidget: (key, content, options) => {
        if (Array.isArray(content)) {
          this.channel.broadcastEvent("extension_ui_widget", { chat_jid: chatJid, key, content, options });
        }
      },
      setFooter: () => {},
      setHeader: () => {},
      setTitle: (title) => {
        this.channel.broadcastEvent("extension_ui_title", { chat_jid: chatJid, title });
      },
      custom: async <T>(_factory: unknown, options?: unknown) => {
        // The web channel does not render arbitrary TUI components. Instead we
        // forward a typed browser-action payload via the generic custom request
        // path and let the authenticated browser decide how to handle it.
        const timeoutMs = typeof (options as { timeout?: unknown } | undefined)?.timeout === "number"
          ? Number((options as { timeout?: number }).timeout)
          : 120000;
        const result = await requestUiResponse("custom", { title: "Custom UI", options: options || null }, timeoutMs);
        return result as T;
      },
      pasteToEditor: (text) => {
        this.touchChat(chatJid);
        const current = this.editorTextByChat.get(chatJid) || "";
        const updated = current + text;
        this.editorTextByChat.set(chatJid, updated);
        this.channel.broadcastEvent("extension_ui_editor_text", { chat_jid: chatJid, text: updated });
      },
      setEditorText: (text) => {
        this.touchChat(chatJid);
        this.editorTextByChat.set(chatJid, text);
        this.channel.broadcastEvent("extension_ui_editor_text", { chat_jid: chatJid, text });
      },
      getEditorText: () => {
        this.touchChat(chatJid);
        return this.editorTextByChat.get(chatJid) || "";
      },
      editor: async (title, prefill) => {
        const result = await requestUiResponse("editor", { title, prefill });
        return typeof result === "string" ? result : undefined;
      },
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      get theme() {
        return fallbackTheme;
      },
      getAllThemes: () => WEB_THEME_NAMES.map((name) => ({ name, path: undefined })),
      getTheme: (name) => {
        if (typeof name !== "string") return undefined;
        const normalized = name.trim().toLowerCase();
        if (!WEB_THEME_NAMES.includes(normalized as (typeof WEB_THEME_NAMES)[number])) return undefined;
        return undefined;
      },
      setTheme: (nextTheme) => {
        this.touchChat(chatJid);
        const payload = normalizeThemePayload(nextTheme);
        if (!payload) return { success: false, error: "Invalid theme payload" };
        this.themeByChat.set(chatJid, payload);
        // Persist instance-wide so the theme survives restarts and applies to all clients.
        const persistedTheme = setServerUiThemeConfig({ theme: payload.theme, tint: payload.tint ?? null });
        this.channel.broadcastEvent("ui_theme", { ...persistedTheme });
        return { success: true };
      },
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
      setHiddenThinkingLabel: () => {},
      setWorkingVisible: (visible) => {
        this.channel.broadcastEvent("extension_ui_working_visible", { chat_jid: chatJid, visible: Boolean(visible) });
      },
      addAutocompleteProvider: () => {},
    };
  }

  handleUiResponse(requestId: string, outcome: unknown, chatJid?: string | null): { status: "ok" | "unknown_request" } {
    const pending = this.pendingUiRequests.get(requestId);
    if (!pending) return { status: "unknown_request" };
    const normalizedChatJid = typeof chatJid === "string" && chatJid.trim() ? chatJid.trim() : null;
    if (normalizedChatJid && pending.chatJid !== normalizedChatJid) {
      return { status: "unknown_request" };
    }
    this.touchChat(pending.chatJid);
    clearTimeout(pending.timeoutId);
    this.pendingUiRequests.delete(requestId);
    pending.resolve(outcome);
    return { status: "ok" };
  }

  clearChatState(chatJid: string, reason = "Web UI chat state expired"): void {
    const normalizedChatJid = String(chatJid || "").trim();
    if (!normalizedChatJid) return;
    this.editorTextByChat.delete(normalizedChatJid);
    this.themeByChat.delete(normalizedChatJid);
    this.chatStateTouchedAtByChat.delete(normalizedChatJid);
    for (const [requestId, pending] of this.pendingUiRequests) {
      if (pending.chatJid !== normalizedChatJid) continue;
      clearTimeout(pending.timeoutId);
      this.pendingUiRequests.delete(requestId);
      try {
        pending.reject(new Error(reason));
      } catch (error) {
        debugSuppressedError(log, "Failed to reject a stale web UI request during chat-state cleanup.", error, {
          chatJid: pending.chatJid,
          kind: pending.kind,
        });
      }
    }
  }

  stop(): void {
    for (const pending of this.pendingUiRequests.values()) {
      clearTimeout(pending.timeoutId);
      try {
        pending.reject(new Error("Web channel stopped"));
      } catch (error) {
        debugSuppressedError(log, "Failed to reject a pending web UI request during shutdown.", error, {
          chatJid: pending.chatJid,
          kind: pending.kind,
        });
      }
    }
    this.pendingUiRequests.clear();
    this.editorTextByChat.clear();
    this.themeByChat.clear();
    this.chatStateTouchedAtByChat.clear();
  }

  private getWaitForIdleTimeoutMs(): number {
    const rawTimeout = this.options.waitForIdleTimeoutMs;
    if (!Number.isFinite(rawTimeout)) return 15000;
    return Math.max(1, Math.floor(rawTimeout as number));
  }

  private getChatStateTtlMs(): number {
    const rawTtl = this.options.chatStateTtlMs;
    if (!Number.isFinite(rawTtl)) return DEFAULT_CHAT_STATE_TTL_MS;
    return Math.max(1, Math.floor(rawTtl as number));
  }

  private touchChat(chatJid: string): void {
    const normalizedChatJid = String(chatJid || "").trim();
    if (!normalizedChatJid) return;
    const now = Date.now();
    this.pruneExpiredChatState(now);
    this.chatStateTouchedAtByChat.set(normalizedChatJid, now);
  }

  private pruneExpiredChatState(now = Date.now()): void {
    const ttlMs = this.getChatStateTtlMs();
    for (const [chatJid, touchedAt] of this.chatStateTouchedAtByChat) {
      if (now - touchedAt < ttlMs) continue;
      this.clearChatState(chatJid, "Web UI chat state expired");
    }
  }
}
