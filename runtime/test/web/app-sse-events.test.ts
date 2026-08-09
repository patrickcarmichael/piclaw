import { afterEach, expect, test } from 'bun:test';

import { handleAppSseEvent, type HandleAppSseEventDependencies } from '../../web/src/ui/app-sse-events.js';
import {
  noteAppChatActivation,
  resetAppRefreshCoordination,
} from '../../web/src/ui/app-refresh-coordination.js';

afterEach(() => {
  resetAppRefreshCoordination();
});

function applyUpdate<T>(current: T, next: T | ((prev: T) => T)): T {
  return typeof next === 'function' ? (next as (prev: T) => T)(current) : next;
}

function createDeps() {
  let extensionPanels = new Map<string, any>();
  let pendingPanelActions = new Set<string>(['panel-a:run', 'autoresearch:stop']);
  let extensionWorkingState: any = { message: null, indicator: null };
  let followupQueueItems: Array<{ row_id: string; content?: string }> = [
    { row_id: 'row-1', content: 'first' },
    { row_id: 'row-2', content: 'second' },
  ];
  const toastCalls: Array<[string, string | null | undefined, string | undefined, number | undefined]> = [];
  const clearQueueCalls: number[] = [];
  let refreshQueueCalls = 0;
  let agentStatus: any = null;
  let agentDraft: any = { text: '', totalLines: 0 };
  let agentPlan: any = '';
  let agentThought: any = { text: '', totalLines: 0 };
  let pendingRequest: any = null;
  let clearAgentRunCalls = 0;
  let agentRunning = false;

  const deps: HandleAppSseEventDependencies = {
    currentChatJid: 'chat:alpha',
    updateAgentProfile: () => undefined,
    updateUserProfile: () => undefined,

    currentTurnIdRef: { current: null },
    activeChatJidRef: { current: 'chat:alpha' },
    pendingRequestRef: { current: null },
    draftBufferRef: { current: '' },
    thoughtBufferRef: { current: '' },
    previewResyncPendingRef: { current: false },
    previewResyncGenerationRef: { current: 0 },
    steerQueuedTurnIdRef: { current: null },
    thoughtExpandedRef: { current: false },
    draftExpandedRef: { current: false },
    draftThrottleRef: { current: 0 },
    thoughtThrottleRef: { current: 0 },
    viewStateRef: { current: { currentHashtag: null, searchQuery: null, searchOpen: false } },
    followupQueueItemsRef: { current: followupQueueItems },
    dismissedQueueRowIdsRef: { current: new Set<string | number>() },
    scrollToBottomRef: { current: null },
    hasMoreRef: { current: false },
    loadMoreRef: { current: null },
    lastAgentResponseRef: { current: null },
    wasAgentActiveRef: { current: false },

    setActiveTurn: (turnId) => {
      deps.currentTurnIdRef.current = typeof turnId === 'string' ? turnId : null;
    },
    applyLiveGeneratedWidgetUpdate: () => undefined,
    setFloatingWidget: () => undefined,
    clearLastActivityFlag: () => undefined,
    handleUiVersionDrift: () => false,
    setAgentStatus: (next) => {
      agentStatus = applyUpdate(agentStatus, next);
    },
    setAgentDraft: (next) => {
      agentDraft = applyUpdate(agentDraft, next);
    },
    setAgentPlan: (next) => {
      agentPlan = applyUpdate(agentPlan, next);
    },
    setAgentThought: (next) => {
      agentThought = applyUpdate(agentThought, next);
    },
    setPendingRequest: (next) => {
      pendingRequest = applyUpdate(pendingRequest, next);
    },
    clearAgentRunState: () => {
      clearAgentRunCalls += 1;
      agentRunning = false;
      deps.currentTurnIdRef.current = null;
      deps.draftBufferRef.current = '';
      deps.thoughtBufferRef.current = '';
      deps.pendingRequestRef.current = null;
    },
    getAgentStatus: async () => null,
    noteAgentActivity: (options) => {
      if (typeof options?.running === 'boolean') agentRunning = options.running;
    },
    showLastActivity: () => undefined,
    refreshTimeline: () => undefined,
    refreshModelAndQueueState: () => undefined,
    refreshActiveChatAgents: () => undefined,
    refreshCurrentChatBranches: () => undefined,
    notifyForFinalResponse: () => undefined,
    setContextUsage: () => undefined,
    refreshContextUsage: () => undefined,
    refreshQueueState: () => {
      refreshQueueCalls += 1;
    },
    setFollowupQueueItems: (next) => {
      followupQueueItems = applyUpdate(followupQueueItems, next);
      deps.followupQueueItemsRef.current = followupQueueItems;
    },
    clearQueuedSteerStateIfStale: (remainingQueueCount) => {
      clearQueueCalls.push(remainingQueueCount);
    },
    setSteerQueuedTurnId: () => undefined,
    applyModelState: () => undefined,
    getAgentContext: async () => null,
    setExtensionStatusPanels: (next) => {
      extensionPanels = applyUpdate(extensionPanels, next);
    },
    setPendingExtensionPanelActions: (next) => {
      pendingPanelActions = applyUpdate(pendingPanelActions, next);
    },
    setExtensionWorkingState: (next) => {
      extensionWorkingState = applyUpdate(extensionWorkingState, next);
    },
    refreshActiveEditorFromWorkspace: () => undefined,
    showIntentToast: (title, detail, kind, durationMs) => {
      toastCalls.push([title, detail, kind, durationMs]);
    },
    removeStalledPost: () => undefined,
    setPosts: () => undefined,
    preserveTimelineScrollTop: (mutate) => mutate(),
  };

  return {
    deps,
    getExtensionPanels: () => extensionPanels,
    getPendingPanelActions: () => pendingPanelActions,
    getExtensionWorkingState: () => extensionWorkingState,
    getFollowupQueueItems: () => followupQueueItems,
    getToastCalls: () => toastCalls,
    getClearQueueCalls: () => clearQueueCalls,
    getRefreshQueueCalls: () => refreshQueueCalls,
    getAgentStatusState: () => agentStatus,
    getAgentDraftState: () => agentDraft,
    getAgentPlanState: () => agentPlan,
    getAgentThoughtState: () => agentThought,
    getPendingRequestState: () => pendingRequest,
    getClearAgentRunCalls: () => clearAgentRunCalls,
    getAgentRunning: () => agentRunning,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('handleAppSseEvent routes status-panel widget events and clears finished pending actions', () => {
  const state = createDeps();

  handleAppSseEvent('extension_ui_widget', {
    key: 'panel-a',
    chat_jid: 'chat:alpha',
    options: { surface: 'status-panel' },
    content: [{ type: 'status_panel', panel: { state: 'done', title: 'Complete' } }],
  }, state.deps);

  expect(state.getExtensionPanels().get('panel-a')).toEqual({ state: 'done', title: 'Complete' });
  expect(Array.from(state.getPendingPanelActions())).toEqual(['autoresearch:stop']);
});

test('handleAppSseEvent preserves preview panes during post-tool model phases', () => {
  const state = createDeps();

  handleAppSseEvent('agent_thought', {
    chat_jid: 'chat:alpha',
    text: 'reasoning before the tool',
    total_lines: 1,
  }, state.deps);
  handleAppSseEvent('agent_draft', {
    chat_jid: 'chat:alpha',
    text: 'commentary before the tool',
    total_lines: 1,
    kind: 'draft',
    mode: 'replace',
  }, state.deps);

  handleAppSseEvent('agent_status', {
    chat_jid: 'chat:alpha',
    type: 'thinking',
    phase: 'post_tool_model',
    title: 'Continuing after tools...',
  }, state.deps);

  expect(state.getAgentThoughtState()).toMatchObject({ text: 'reasoning before the tool', totalLines: 1 });
  expect(state.getAgentDraftState()).toMatchObject({ text: 'commentary before the tool', totalLines: 1 });
  expect(state.deps.thoughtBufferRef.current).toBe('reasoning before the tool');
  expect(state.deps.draftBufferRef.current).toBe('commentary before the tool');
  expect(state.getAgentStatusState()).toMatchObject({ phase: 'post_tool_model' });
});

test('handleAppSseEvent preserves preview panes for repeated same-turn thinking status', () => {
  const state = createDeps();
  state.deps.currentTurnIdRef.current = 'turn-42';

  handleAppSseEvent('agent_thought', {
    chat_jid: 'chat:alpha',
    turn_id: 'turn-42',
    text: 'reasoning already streamed',
    total_lines: 1,
  }, state.deps);
  handleAppSseEvent('agent_draft', {
    chat_jid: 'chat:alpha',
    turn_id: 'turn-42',
    text: 'draft already streamed',
    total_lines: 1,
    kind: 'draft',
    mode: 'replace',
  }, state.deps);

  handleAppSseEvent('agent_status', {
    chat_jid: 'chat:alpha',
    turn_id: 'turn-42',
    type: 'thinking',
    title: 'Still thinking...',
  }, state.deps);

  expect(state.getAgentThoughtState()).toMatchObject({ text: 'reasoning already streamed', totalLines: 1 });
  expect(state.getAgentDraftState()).toMatchObject({ text: 'draft already streamed', totalLines: 1 });
  expect(state.deps.thoughtBufferRef.current).toBe('reasoning already streamed');
  expect(state.deps.draftBufferRef.current).toBe('draft already streamed');
});

test('handleAppSseEvent clears preview panes when adopting a new turn', () => {
  const state = createDeps();
  state.deps.currentTurnIdRef.current = 'turn-42';
  state.deps.draftBufferRef.current = 'draft from previous turn';
  state.deps.thoughtBufferRef.current = 'thought from previous turn';
  state.deps.setAgentDraft({ text: 'draft from previous turn', totalLines: 1 });
  state.deps.setAgentPlan('plan from previous turn');
  state.deps.setAgentThought({ text: 'thought from previous turn', totalLines: 1 });

  handleAppSseEvent('agent_status', {
    chat_jid: 'chat:alpha',
    turn_id: 'turn-43',
    type: 'thinking',
    title: 'Thinking...',
  }, state.deps);

  expect(state.getAgentDraftState()).toEqual({ text: '', totalLines: 0 });
  expect(state.getAgentPlanState()).toBe('');
  expect(state.getAgentThoughtState()).toEqual({ text: '', totalLines: 0 });
  expect(state.deps.draftBufferRef.current).toBe('');
  expect(state.deps.thoughtBufferRef.current).toBe('');
  expect(state.deps.currentTurnIdRef.current).toBe('turn-43');
});

test('handleAppSseEvent tracks extension working messages and indicators for the active chat', () => {
  const state = createDeps();

  handleAppSseEvent('extension_ui_working', {
    chat_jid: 'chat:alpha',
    message: 'Compacting context…',
  }, state.deps);

  expect(state.getExtensionWorkingState()).toEqual({
    message: 'Compacting context…',
    indicator: null,
  });

  handleAppSseEvent('extension_ui_working_indicator', {
    chat_jid: 'chat:alpha',
    frames: ['⠋', '⠙'],
    interval_ms: 90,
  }, state.deps);

  expect(state.getExtensionWorkingState()).toEqual({
    message: 'Compacting context…',
    indicator: {
      mode: 'custom',
      frames: ['⠋', '⠙'],
      intervalMs: 90,
    },
  });

  handleAppSseEvent('extension_ui_working', {
    chat_jid: 'chat:beta',
    message: 'Ignore other chats',
  }, state.deps);

  expect(state.getExtensionWorkingState()).toEqual({
    message: 'Compacting context…',
    indicator: {
      mode: 'custom',
      frames: ['⠋', '⠙'],
      intervalMs: 90,
    },
  });
});

test('handleAppSseEvent clears extension working state when the turn completes', () => {
  const state = createDeps();

  handleAppSseEvent('extension_ui_working', {
    chat_jid: 'chat:alpha',
    message: 'Compacting context…',
  }, state.deps);
  handleAppSseEvent('extension_ui_working_indicator', {
    chat_jid: 'chat:alpha',
    frames: ['⠋', '⠙'],
    interval_ms: 90,
  }, state.deps);

  handleAppSseEvent('agent_response', {
    chat_jid: 'chat:alpha',
    content: 'done',
  }, state.deps);

  expect(state.getExtensionWorkingState()).toEqual({ message: null, indicator: null, visible: true });
});

test('handleAppSseEvent removes followup rows on removal events and schedules queue refresh', () => {
  const state = createDeps();

  handleAppSseEvent('agent_followup_removed', {
    chat_jid: 'chat:alpha',
    row_id: 'row-1',
  }, state.deps);

  expect(state.deps.dismissedQueueRowIdsRef.current.has('row-1')).toBe(true);
  expect(state.getFollowupQueueItems().map((item) => item.row_id)).toEqual(['row-2']);
  expect(state.getClearQueueCalls()).toEqual([1]);
  expect(state.getRefreshQueueCalls()).toBe(1);
});

test('handleAppSseEvent adopts an authoritative active turn with clean restored state', async () => {
  const state = createDeps();
  const stalePendingRequest = { id: 'approval-old' };
  state.deps.draftBufferRef.current = 'draft from previous turn';
  state.deps.thoughtBufferRef.current = 'thought from previous turn';
  state.deps.pendingRequestRef.current = stalePendingRequest;
  state.deps.setAgentPlan('plan from previous turn');
  state.deps.setPendingRequest(stalePendingRequest);
  state.deps.getAgentStatus = async () => ({
    status: 'active',
    data: {
      chat_jid: 'chat:alpha',
      type: 'intent',
      title: 'Compacting context',
      intent_key: 'compaction',
      turn_id: 'turn-42',
      started_at: '2026-03-30T21:00:00.000Z',
    },
    thought: { text: 'thought preview', totalLines: 2 },
    draft: { text: 'draft preview', totalLines: 3 },
  });

  handleAppSseEvent('connected', { app_asset_version: 'test' }, state.deps);
  await Promise.resolve();

  expect(state.getAgentStatusState()).toEqual({
    chat_jid: 'chat:alpha',
    type: 'intent',
    title: 'Compacting context',
    intent_key: 'compaction',
    turn_id: 'turn-42',
    started_at: '2026-03-30T21:00:00.000Z',
  });
  expect(state.getAgentDraftState()).toEqual({ text: 'draft preview', totalLines: 3 });
  expect(state.getAgentPlanState()).toBe('');
  expect(state.getAgentThoughtState()).toEqual({ text: 'thought preview', totalLines: 2 });
  expect(state.getPendingRequestState()).toBeNull();
  expect(state.deps.pendingRequestRef.current).toBeNull();
  expect(state.getClearAgentRunCalls()).toBe(1);
  expect(state.getAgentRunning()).toBe(true);
});

test('handleAppSseEvent preserves same-turn live state across active reconnect resync', async () => {
  const state = createDeps();
  const pendingRequest = { id: 'approval-42' };
  state.deps.currentTurnIdRef.current = 'turn-42';
  state.deps.draftBufferRef.current = 'live draft';
  state.deps.thoughtBufferRef.current = 'live thought';
  state.deps.pendingRequestRef.current = pendingRequest;
  state.deps.setAgentDraft({ text: 'live draft', totalLines: 1 });
  state.deps.setAgentPlan('live plan');
  state.deps.setAgentThought({ text: 'live thought', totalLines: 1 });
  state.deps.setPendingRequest(pendingRequest);
  state.deps.noteAgentActivity({ running: true });
  state.deps.getAgentStatus = async () => ({
    status: 'active',
    data: { type: 'thinking', turn_id: 'turn-42', title: 'Still thinking...' },
  });

  handleAppSseEvent('connected', { app_asset_version: 'test' }, state.deps);
  await Promise.resolve();

  expect(state.getAgentDraftState()).toEqual({ text: 'live draft', totalLines: 1 });
  expect(state.getAgentPlanState()).toBe('live plan');
  expect(state.getAgentThoughtState()).toEqual({ text: 'live thought', totalLines: 1 });
  expect(state.getPendingRequestState()).toBe(pendingRequest);
  expect(state.deps.pendingRequestRef.current).toBe(pendingRequest);
  expect(state.deps.draftBufferRef.current).toBe('live draft');
  expect(state.deps.thoughtBufferRef.current).toBe('live thought');
  expect(state.getClearAgentRunCalls()).toBe(0);
  expect(state.getAgentRunning()).toBe(true);
});

test('handleAppSseEvent clears live state after inactive or missing reconnect snapshots', async () => {
  for (const response of [null, { status: 'idle', data: null }]) {
    const state = createDeps();
    const pendingRequest = { id: 'approval-42' };
    state.deps.draftBufferRef.current = 'live draft';
    state.deps.thoughtBufferRef.current = 'live thought';
    state.deps.pendingRequestRef.current = pendingRequest;
    state.deps.setAgentStatus({ type: 'thinking', turn_id: 'turn-42' });
    state.deps.setAgentDraft({ text: 'live draft', totalLines: 1 });
    state.deps.setAgentPlan('live plan');
    state.deps.setAgentThought({ text: 'live thought', totalLines: 1 });
    state.deps.setPendingRequest(pendingRequest);
    state.deps.getAgentStatus = async () => response;

    handleAppSseEvent('connected', { app_asset_version: 'test' }, state.deps);
    await Promise.resolve();

    expect(state.getAgentStatusState()).toBeNull();
    expect(state.getAgentDraftState()).toEqual({ text: '', totalLines: 0 });
    expect(state.getAgentPlanState()).toBe('');
    expect(state.getAgentThoughtState()).toEqual({ text: '', totalLines: 0 });
    expect(state.getPendingRequestState()).toBeNull();
    expect(state.deps.pendingRequestRef.current).toBeNull();
    expect(state.deps.draftBufferRef.current).toBe('');
    expect(state.deps.thoughtBufferRef.current).toBe('');
    expect(state.getClearAgentRunCalls()).toBe(1);
    expect(state.getAgentRunning()).toBe(false);
  }
});

test('handleAppSseEvent clears terminal reconnect snapshots and refreshes context usage', async () => {
  for (const [status, type] of [['idle', 'done'], ['active', 'error']] as const) {
    const state = createDeps();
    let contextRefreshes = 0;
    state.deps.draftBufferRef.current = 'live draft';
    state.deps.thoughtBufferRef.current = 'live thought';
    state.deps.getAgentStatus = async () => ({
      status,
      data: { type, title: `Terminal ${type}`, turn_id: 'turn-rotate' },
    });
    state.deps.refreshContextUsage = async () => {
      contextRefreshes += 1;
    };

    handleAppSseEvent('connected', { app_asset_version: 'test' }, state.deps);
    await Promise.resolve();

    expect(contextRefreshes).toBe(1);
    expect(state.getAgentStatusState()).toBeNull();
    expect(state.deps.draftBufferRef.current).toBe('');
    expect(state.deps.thoughtBufferRef.current).toBe('');
    expect(state.getClearAgentRunCalls()).toBe(1);
    expect(state.getAgentRunning()).toBe(false);
  }
});

test('handleAppSseEvent refetches preview state when updates race reconnect restore', async () => {
  const state = createDeps();
  const firstStatusRequest = deferred<any>();
  const secondStatusRequest = deferred<any>();
  let statusCalls = 0;
  const pendingRequest = { id: 'approval-42' };
  state.deps.currentTurnIdRef.current = 'turn-99';
  state.deps.draftBufferRef.current = 'stale draft';
  state.deps.thoughtBufferRef.current = 'stale thought';
  state.deps.pendingRequestRef.current = pendingRequest;
  state.deps.setPendingRequest(pendingRequest);
  state.deps.noteAgentActivity({ running: true });
  state.deps.getAgentStatus = async () => {
    statusCalls += 1;
    return statusCalls === 1 ? firstStatusRequest.promise : secondStatusRequest.promise;
  };

  handleAppSseEvent('connected', { app_asset_version: 'test' }, state.deps);

  expect(state.deps.previewResyncPendingRef.current).toBe(true);
  expect(state.deps.draftBufferRef.current).toBe('stale draft');
  expect(state.deps.thoughtBufferRef.current).toBe('stale thought');
  expect(state.deps.pendingRequestRef.current).toBe(pendingRequest);
  expect(state.getPendingRequestState()).toBe(pendingRequest);
  expect(state.getClearAgentRunCalls()).toBe(0);
  expect(state.getAgentRunning()).toBe(true);

  handleAppSseEvent('agent_draft_delta', {
    chat_jid: 'chat:alpha',
    delta: ' arrived during restore',
  }, state.deps);
  handleAppSseEvent('agent_thought', {
    chat_jid: 'chat:alpha',
    text: 'thought arrived during restore',
    total_lines: 1,
  }, state.deps);

  firstStatusRequest.resolve({
    status: 'active',
    data: {
      chat_jid: 'chat:alpha',
      type: 'intent',
      title: 'Restoring preview',
      turn_id: 'turn-99',
    },
    draft: { text: 'snapshot before racing draft', totalLines: 1 },
    thought: { text: 'snapshot before racing thought', totalLines: 1 },
  });
  await firstStatusRequest.promise;
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(statusCalls).toBe(2);
  expect(state.deps.previewResyncPendingRef.current).toBe(true);

  secondStatusRequest.resolve({
    status: 'active',
    data: {
      chat_jid: 'chat:alpha',
      type: 'intent',
      title: 'Restoring preview',
      turn_id: 'turn-99',
    },
    draft: { text: 'snapshot including racing draft', totalLines: 1 },
    thought: { text: 'snapshot including racing thought', totalLines: 1 },
  });
  await secondStatusRequest.promise;
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(state.deps.previewResyncPendingRef.current).toBe(false);
  expect(state.deps.draftBufferRef.current).toBe('snapshot including racing draft');
  expect(state.deps.thoughtBufferRef.current).toBe('snapshot including racing thought');
  expect(state.deps.pendingRequestRef.current).toBe(pendingRequest);
  expect(state.getPendingRequestState()).toBe(pendingRequest);
  expect(state.getClearAgentRunCalls()).toBe(0);
  expect(state.getAgentRunning()).toBe(true);
});

test('handleAppSseEvent rejects delayed active snapshots superseded by terminal status', async () => {
  for (const type of ['done', 'error'] as const) {
    const state = createDeps();
    const statusRequest = deferred<any>();
    state.deps.currentTurnIdRef.current = 'turn-a';
    state.deps.draftBufferRef.current = 'live draft';
    state.deps.thoughtBufferRef.current = 'live thought';
    state.deps.setAgentDraft({ text: 'live draft', totalLines: 1 });
    state.deps.setAgentThought({ text: 'live thought', totalLines: 1 });
    state.deps.getAgentStatus = async () => statusRequest.promise;

    handleAppSseEvent('connected', { app_asset_version: 'test' }, state.deps);
    handleAppSseEvent('agent_status', {
      chat_jid: 'chat:alpha',
      turn_id: 'turn-a',
      type,
      title: `Terminal ${type}`,
    }, state.deps);

    statusRequest.resolve({
      status: 'active',
      data: { type: 'thinking', turn_id: 'turn-a', title: 'Stale active snapshot' },
      draft: { text: 'stale restored draft', totalLines: 1 },
      thought: { text: 'stale restored thought', totalLines: 1 },
    });
    await statusRequest.promise;
    await Promise.resolve();

    expect(state.deps.previewResyncPendingRef.current).toBe(false);
    expect(state.deps.currentTurnIdRef.current).toBeNull();
    expect(state.deps.draftBufferRef.current).toBe('');
    expect(state.deps.thoughtBufferRef.current).toBe('');
    expect(state.getAgentDraftState()).toEqual({ text: '', totalLines: 0 });
    expect(state.getAgentThoughtState()).toEqual({ text: '', totalLines: 0 });
    expect(state.getAgentStatusState()?.title).not.toBe('Stale active snapshot');
  }
});

test('handleAppSseEvent rejects delayed snapshots superseded by a new turn', async () => {
  const state = createDeps();
  const statusRequest = deferred<any>();
  state.deps.currentTurnIdRef.current = 'turn-a';
  state.deps.draftBufferRef.current = 'draft from turn A';
  state.deps.thoughtBufferRef.current = 'thought from turn A';
  state.deps.getAgentStatus = async () => statusRequest.promise;

  handleAppSseEvent('connected', { app_asset_version: 'test' }, state.deps);
  handleAppSseEvent('agent_status', {
    chat_jid: 'chat:alpha',
    turn_id: 'turn-b',
    type: 'thinking',
    title: 'Turn B is active',
  }, state.deps);

  statusRequest.resolve({
    status: 'active',
    data: { type: 'thinking', turn_id: 'turn-a', title: 'Stale turn A snapshot' },
    draft: { text: 'stale turn A draft', totalLines: 1 },
    thought: { text: 'stale turn A thought', totalLines: 1 },
  });
  await statusRequest.promise;
  await Promise.resolve();

  expect(state.deps.previewResyncPendingRef.current).toBe(false);
  expect(state.deps.currentTurnIdRef.current).toBe('turn-b');
  expect(state.deps.draftBufferRef.current).toBe('');
  expect(state.deps.thoughtBufferRef.current).toBe('');
  expect(state.getAgentStatusState()).toMatchObject({ turn_id: 'turn-b', title: 'Turn B is active' });
});

test('handleAppSseEvent skips duplicate reconnect recovery during a fresh cold-open activation', async () => {
  noteAppChatActivation({ chatJid: 'chat:alpha' });
  const state = createDeps();
  let agentStatusCalls = 0;
  let timelineCalls = 0;
  let bundleCalls = 0;
  const resetCalls: string[] = [];
  state.deps.getAgentStatus = async () => {
    agentStatusCalls += 1;
    return null;
  };
  state.deps.setAgentStatus = () => {
    resetCalls.push('status');
  };
  state.deps.setAgentDraft = () => {
    resetCalls.push('draft');
  };
  state.deps.setAgentPlan = () => {
    resetCalls.push('plan');
  };
  state.deps.setAgentThought = () => {
    resetCalls.push('thought');
  };
  state.deps.setPendingRequest = () => {
    resetCalls.push('pending');
  };
  state.deps.clearAgentRunState = () => {
    resetCalls.push('clear');
  };
  state.deps.refreshTimeline = () => {
    timelineCalls += 1;
  };
  state.deps.refreshModelAndQueueState = () => {
    bundleCalls += 1;
  };

  handleAppSseEvent('connected', { app_asset_version: 'test' }, state.deps);
  await Promise.resolve();

  expect(agentStatusCalls).toBe(0);
  expect(timelineCalls).toBe(0);
  expect(bundleCalls).toBe(0);
  expect(resetCalls).toEqual(['status', 'draft', 'plan', 'thought', 'pending', 'clear']);
});

test('handleAppSseEvent refreshes compaction status metadata even when title stays the same', () => {
  const state = createDeps();

  handleAppSseEvent('agent_status', {
    chat_jid: 'chat:alpha',
    type: 'intent',
    title: 'Compacting context',
    intent_key: 'compaction',
    turn_id: 'turn-1',
    started_at: '2026-04-02T13:00:00.000Z',
  }, state.deps);

  handleAppSseEvent('agent_status', {
    chat_jid: 'chat:alpha',
    type: 'intent',
    title: 'Compacting context',
    intent_key: 'compaction',
    turn_id: 'turn-2',
    started_at: '2026-04-02T13:05:00.000Z',
    detail: 'Shrinking recent context before continuing the turn.',
  }, state.deps);

  expect(state.getAgentStatusState()).toEqual({
    chat_jid: 'chat:alpha',
    type: 'intent',
    title: 'Compacting context',
    intent_key: 'compaction',
    turn_id: 'turn-2',
    started_at: '2026-04-02T13:05:00.000Z',
    detail: 'Shrinking recent context before continuing the turn.',
  });
});

test('handleAppSseEvent applies a chat-scoped provider usage refresh without resetting model state', () => {
  const state = createDeps();
  const modelPayloads: unknown[] = [];
  state.deps.applyModelState = (payload) => modelPayloads.push(payload);

  handleAppSseEvent('model_changed', {
    chat_jid: 'chat:alpha',
    current: 'zai/glm-4',
    provider_usage: { provider: 'zai', plan: 'pro' },
  }, state.deps);
  handleAppSseEvent('model_changed', {
    chat_jid: 'chat:beta',
    current: 'zai/glm-4',
    provider_usage: { provider: 'zai', plan: 'enterprise' },
  }, state.deps);

  expect(modelPayloads).toEqual([{
    chat_jid: 'chat:alpha',
    current: 'zai/glm-4',
    provider_usage: { provider: 'zai', plan: 'pro' },
  }]);
});

test('handleAppSseEvent preserves cached context usage when model context refresh fails', async () => {
  const state = createDeps();
  const updates: any[] = [];
  state.deps.setContextUsage = (next) => {
    updates.push(typeof next === 'function' ? next(updates.at(-1)) : next);
  };
  state.deps.getAgentContext = async () => {
    throw new Error('network');
  };

  handleAppSseEvent('model_changed', {
    chat_jid: 'chat:alpha',
    current: 'gpt-5.4',
  }, state.deps);

  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(updates).toEqual([]);
});

test('handleAppSseEvent maps extension notify events into intent toasts', () => {
  const state = createDeps();

  handleAppSseEvent('extension_ui_notify', {
    chat_jid: 'chat:alpha',
    message: 'Widget synced',
    type: 'success',
  }, state.deps);

  expect(state.getToastCalls()).toEqual([
    ['Widget synced', null, 'success', undefined],
  ]);
});
