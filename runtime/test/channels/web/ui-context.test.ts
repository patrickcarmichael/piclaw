/**
 * test/channels/web/ui-context.test.ts – Tests for the extension UI context.
 *
 * Verifies UiBridge and UIContext handle confirm/input dialogs, timeouts,
 * cancellation, and session binding correctly.
 */

import { describe, test, expect } from "bun:test";
import "../../helpers.js";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { UiBridge } from "../../../src/channels/web/theming/ui-bridge.js";
import { bindSessionUiContext, createUiContext } from "../../../src/channels/web/ui-context.js";

function makeChannel(options: { waitForIdleTimeoutMs?: number; chatStateTtlMs?: number } = {}) {
  const events: Array<{ type: string; payload: any }> = [];
  const channel = {
    broadcastEvent: (type: string, payload: any) => events.push({ type, payload }),
  };
  const uiBridge = new UiBridge(channel as any, {
    ...(options.waitForIdleTimeoutMs == null ? {} : { waitForIdleTimeoutMs: options.waitForIdleTimeoutMs }),
    ...(options.chatStateTtlMs == null ? {} : { chatStateTtlMs: options.chatStateTtlMs }),
  });
  (channel as any).uiBridge = uiBridge;
  return { channel, events, uiBridge };
}

function directMutationRunner(runtime: AgentSessionRuntime) {
  return async (_mutation: string, action: (current: AgentSessionRuntime) => unknown) => action(runtime);
}

function createRuntime(session: any): AgentSessionRuntime {
  return {
    session,
    cwd: "/workspace",
    diagnostics: [],
    services: {} as any,
    modelFallbackMessage: undefined,
    newSession: async () => ({ cancelled: false }),
    switchSession: async () => ({ cancelled: true }),
    fork: async () => ({ cancelled: false }),
    importFromJsonl: async () => ({ cancelled: false }),
    dispose: async () => {},
  } as any;
}

describe("ui-context", () => {
  test("createUiContext handles confirm/input/editor and editor updates", async () => {
    const { channel, events, uiBridge } = makeChannel();
    const ui = createUiContext(channel as any, "web:default");

    const confirmPromise = ui.confirm("Confirm", "Are you sure?", { timeout: 50 });
    let requestId = Array.from(uiBridge.pendingUiRequests.keys())[0] as string;
    let pending = uiBridge.pendingUiRequests.get(requestId)!;
    clearTimeout(pending.timeoutId);
    uiBridge.pendingUiRequests.delete(requestId);
    pending.resolve(true);
    expect(await confirmPromise).toBe(true);

    const inputPromise = ui.input("Input", "Type here", { timeout: 50 });
    requestId = Array.from(uiBridge.pendingUiRequests.keys())[0] as string;
    pending = uiBridge.pendingUiRequests.get(requestId)!;
    clearTimeout(pending.timeoutId);
    uiBridge.pendingUiRequests.delete(requestId);
    pending.resolve("hello");
    expect(await inputPromise).toBe("hello");

    const editorPromise = ui.editor("Editor", "prefill");
    requestId = Array.from(uiBridge.pendingUiRequests.keys())[0] as string;
    pending = uiBridge.pendingUiRequests.get(requestId)!;
    clearTimeout(pending.timeoutId);
    uiBridge.pendingUiRequests.delete(requestId);
    pending.resolve("edited");
    expect(await editorPromise).toBe("edited");

    const customPromise = (ui.custom as any)(() => null, {
      timeout: 25,
      action: "open_workspace_file",
      path: "notes/index.md",
      target: "popout",
    });
    requestId = Array.from(uiBridge.pendingUiRequests.keys())[0] as string;
    pending = uiBridge.pendingUiRequests.get(requestId)!;
    clearTimeout(pending.timeoutId);
    expect(events.filter((event) => event.type === "extension_ui_request").at(-1)?.payload?.options?.action).toBe("open_workspace_file");
    uiBridge.pendingUiRequests.delete(requestId);
    pending.resolve({ ok: true, opened: true });
    expect(await customPromise).toEqual({ ok: true, opened: true });

    ui.setStatus("key", "Working");
    ui.setWorkingMessage("Busy");
    ui.setTitle("Title");
    ui.setWidget("widget", [{ type: "text", text: "hi" }], { compact: true });

    ui.setEditorText("Alpha");
    expect(ui.getEditorText()).toBe("Alpha");
    ui.pasteToEditor("Beta");
    expect(ui.getEditorText()).toBe("AlphaBeta");

    const eventTypes = events.map((event) => event.type);
    expect(eventTypes).toContain("extension_ui_status");
    expect(eventTypes).toContain("extension_ui_working");
    expect(eventTypes).toContain("extension_ui_title");
    expect(eventTypes).toContain("extension_ui_widget");
    expect(eventTypes).toContain("extension_ui_editor_text");
  });

  test("createUiContext does not expose form prompts until the web form bridge exists", () => {
    const { channel } = makeChannel();
    const ui = createUiContext(channel as any, "web:default") as any;

    // pi-mcp-adapter 2.9.0 only enables MCP elicitation when ctx.ui.form exists.
    // Keep this absent until Piclaw has a real web form renderer/response path,
    // so MCP servers cannot advertise a prompt mode that Piclaw cannot render.
    expect(typeof ui.form).toBe("undefined");
  });

  test("createUiContext timeout resolves undefined", async () => {
    const { channel, events, uiBridge } = makeChannel();
    const ui = createUiContext(channel as any, "web:default");

    const selectPromise = ui.select("Pick", ["a", "b"], { timeout: 10 });
    await Bun.sleep(20);
    expect(await selectPromise).toBeUndefined();

    const timeoutEvent = events.find((event) => event.type === "extension_ui_timeout");
    expect(timeoutEvent).toBeDefined();
    expect(uiBridge.pendingUiRequests.size).toBe(0);
  });

  test("bindSessionUiContext wires command actions", async () => {
    const { channel, events } = makeChannel();
    let boundArgs: any = null;
    let reloadCalled = false;
    let subscribeCalled = false;
    let unsubscribeCalled = false;
    let forkArgs: any[] | null = null;
    let switchArgs: any[] | null = null;
    let newSessionOptions: any = null;

    const session = {
      isStreaming: true,
      subscribe: (cb: (event: any) => void) => {
        subscribeCalled = true;
        const timer = setTimeout(() => cb({ type: "agent_end" }), 0);
        return () => {
          unsubscribeCalled = true;
          clearTimeout(timer);
        };
      },
      bindExtensions: async (args: any) => {
        boundArgs = args;
      },
      navigateTree: async () => ({ cancelled: true }),
      reload: async () => {
        reloadCalled = true;
      },
    } as any;

    const runtime = createRuntime(session) as any;
    runtime.newSession = async (options: any) => {
      newSessionOptions = options;
      return { cancelled: false };
    };
    runtime.fork = async (...args: any[]) => {
      forkArgs = args;
      return { cancelled: false };
    };
    runtime.switchSession = async (...args: any[]) => {
      switchArgs = args;
      return { cancelled: true };
    };

    await bindSessionUiContext(channel as any, runtime, "web:default", directMutationRunner(runtime) as any);
    expect(boundArgs).toBeDefined();

    const actions = boundArgs.commandContextActions;
    await actions.waitForIdle();
    expect(subscribeCalled).toBe(true);
    expect(unsubscribeCalled).toBe(true);
    const withSession = async () => {};
    expect(await actions.newSession({ withSession })).toEqual({ cancelled: false });
    expect(newSessionOptions).toEqual({ withSession });
    expect(await actions.fork("abc", { position: "at", withSession })).toEqual({ cancelled: false });
    expect(forkArgs).toEqual(["abc", { position: "at", withSession }]);
    expect(await actions.navigateTree("abc", {})).toEqual({ cancelled: true });
    expect(await actions.switchSession("path", { withSession })).toEqual({ cancelled: true });
    expect(switchArgs).toEqual(["path", { withSession }]);
    await actions.reload();
    expect(reloadCalled).toBe(true);

    const originalError = console.error;
    console.error = () => {};
    boundArgs.onError(new Error("boom"));
    console.error = originalError;
    const errorEvent = events.find((event) => event.type === "extension_ui_error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.payload?.chat_jid).toBe("web:default");
  });

  test("bindSessionUiContext suppresses stale ctx errors from replaced sessions", async () => {
    const { channel, events } = makeChannel();
    let currentSession: any;
    const replacementSession = { isStreaming: false, reload: async () => {} };
    const staleMessage = "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().";
    const oldSession = {
      isStreaming: false,
      bindExtensions: async (args: any) => {
        currentSession = replacementSession;
        args.onError({
          error: staleMessage,
          event: "session_start",
          extensionPath: "<inline:6>",
        });
      },
      reload: async () => {},
    } as any;
    currentSession = oldSession;
    const runtime = {
      get session() { return currentSession; },
      cwd: "/workspace",
      diagnostics: [],
      services: {} as any,
      modelFallbackMessage: undefined,
      newSession: async () => ({ cancelled: false }),
      switchSession: async () => ({ cancelled: false }),
      fork: async () => ({ cancelled: false }),
      importFromJsonl: async () => ({ cancelled: false }),
      dispose: async () => {},
    } as any;

    await bindSessionUiContext(channel as any, runtime, "web:default", directMutationRunner(runtime) as any);

    expect(events.some((event) => event.type === "extension_ui_error")).toBe(false);
  });

  test("bindSessionUiContext waitForIdle unsubscribes after a bounded timeout when agent_end never arrives", async () => {
    const { channel } = makeChannel({ waitForIdleTimeoutMs: 10 });
    let boundArgs: any = null;
    let unsubscribeCalled = false;

    const session = {
      isStreaming: true,
      subscribe: () => () => {
        unsubscribeCalled = true;
      },
      bindExtensions: async (args: any) => {
        boundArgs = args;
      },
      navigateTree: async () => ({ cancelled: false }),
      reload: async () => {},
    } as any;

    await bindSessionUiContext(channel as any, createRuntime(session), "web:default", directMutationRunner(createRuntime(session)) as any);
    await boundArgs.commandContextActions.waitForIdle();
    expect(unsubscribeCalled).toBe(true);
  });

  test("bindSessionUiContext waitForIdle resolves when streaming stops before agent_end", async () => {
    const { channel } = makeChannel({ waitForIdleTimeoutMs: 1000 });
    let boundArgs: any = null;
    let unsubscribeCalled = false;
    let listener: ((event: any) => void) | null = null;

    const session = {
      isStreaming: true,
      subscribe: (cb: (event: any) => void) => {
        listener = cb;
        return () => {
          unsubscribeCalled = true;
        };
      },
      bindExtensions: async (args: any) => {
        boundArgs = args;
      },
      navigateTree: async () => ({ cancelled: false }),
      reload: async () => {},
    } as any;

    await bindSessionUiContext(channel as any, createRuntime(session), "web:default", directMutationRunner(createRuntime(session)) as any);
    const waitForIdle = boundArgs.commandContextActions.waitForIdle();
    session.isStreaming = false;
    listener?.({ type: "message_end" });
    await waitForIdle;
    expect(unsubscribeCalled).toBe(true);
  });

  test("bindSessionUiContext ignores non-web chats", async () => {
    const { channel } = makeChannel();
    let bindCalled = false;
    const session = {
      isStreaming: false,
      bindExtensions: async () => {
        bindCalled = true;
      },
    } as any;

    await bindSessionUiContext(channel as any, createRuntime(session), "whatsapp:123", directMutationRunner(createRuntime(session)) as any);
    expect(bindCalled).toBe(false);
  });

  test("UiBridge prunes stale per-chat state and rejects stale pending requests", async () => {
    const { uiBridge } = makeChannel({ chatStateTtlMs: 10 });
    const staleUi = uiBridge.createUiContext("web:stale");
    staleUi.setEditorText("Alpha");
    staleUi.setTheme("tango");
    const pendingConfirm = staleUi.confirm("Confirm", "Are you sure?", { timeout: 1000 });

    await Bun.sleep(20);

    const freshUi = uiBridge.createUiContext("web:fresh");
    freshUi.setEditorText("Beta");

    await expect(pendingConfirm).rejects.toThrow("Web UI chat state expired");
    expect(uiBridge.pendingUiRequests.size).toBe(0);
    expect(uiBridge.editorTextByChat.has("web:stale")).toBe(false);
    expect(uiBridge.themeByChat.has("web:stale")).toBe(false);
    expect(uiBridge.editorTextByChat.get("web:fresh")).toBe("Beta");
  });
});
