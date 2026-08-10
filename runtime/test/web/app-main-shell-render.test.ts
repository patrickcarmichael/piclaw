import { expect, mock, test } from 'bun:test';

import { ComposeBox, QueuedFollowupStack } from '../../web/src/components/compose-box.js';
import {
  buildMainShellClassName,
  extractPostedUserMessageId,
  handleComposePost,
  renderMainShell,
  scrollToPostedTimelineMessage,
} from '../../web/src/ui/app-main-shell-render.js';

test('buildMainShellClassName composes workspace/editor/chat/zen modifiers', () => {
  expect(buildMainShellClassName({
    workspaceOpen: true,
    editorOpen: false,
    chatOnlyMode: false,
    zenMode: false,
  })).toBe('app-shell');

  expect(buildMainShellClassName({
    workspaceOpen: false,
    editorOpen: true,
    chatOnlyMode: true,
    zenMode: true,
  })).toBe('app-shell workspace-collapsed editor-open chat-only zen-mode');
});

test('extractPostedUserMessageId prefers user_message.id and falls back to row_id', () => {
  expect(extractPostedUserMessageId({ user_message: { id: 42 }, row_id: 7 })).toBe(42);
  expect(extractPostedUserMessageId({ row_id: 7 })).toBe(7);
  expect(extractPostedUserMessageId({})).toBeNull();
});

test('handleComposePost scrolls to the posted user message without reloading the timeline', () => {
  const scrollToBottom = mock(() => {});
  const scrollPostedMessage = mock(() => {});

  handleComposePost({
    response: { user_message: { id: 99 } },
    viewStateRef: { current: { searchQuery: null, searchOpen: false } },
    scrollToBottom,
    scrollPostedMessage,
  });

  expect(scrollPostedMessage).toHaveBeenCalledWith(99);
  expect(scrollToBottom).not.toHaveBeenCalled();
});

test('handleComposePost falls back to scrolling to the bottom when there is no posted row id', () => {
  const scrollToBottom = mock(() => {});
  const scrollPostedMessage = mock(() => {});

  handleComposePost({
    response: { command: { type: 'model' } },
    viewStateRef: { current: { searchQuery: null, searchOpen: false } },
    scrollToBottom,
    scrollPostedMessage,
  });

  expect(scrollToBottom).toHaveBeenCalledTimes(1);
  expect(scrollPostedMessage).not.toHaveBeenCalled();
});

function walkVNodes(node: any, visit: (entry: any) => void) {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const child of node) walkVNodes(child, visit);
    return;
  }
  if (typeof node !== 'object') return;
  if (!('type' in node) || !('props' in node)) return;

  visit(node);
  walkVNodes((node as any).props?.children, visit);
}

function createMainShellRenderOptions(overrides: Record<string, unknown> = {}) {
  const noop = () => {};
  return {
    appShellRef: { current: null },
    workspaceOpen: false,
    editorOpen: false,
    chatOnlyMode: true,
    zenMode: false,
    isRenameBranchFormOpen: false,
    closeRenameCurrentBranchForm: noop,
    handleRenameCurrentBranch: noop,
    renameBranchNameDraft: '',
    renameBranchNameInputRef: { current: null },
    setRenameBranchNameDraft: noop,
    renameBranchDraftState: { kind: 'info', message: '', canSubmit: false },
    isRenamingBranch: false,
    addFileRef: noop,
    addFolderRef: noop,
    openEditor: noop,
    openTerminalTab: noop,
    openVncTab: noop,
    hasDockPanes: false,
    toggleDock: noop,
    dockVisible: false,
    handleSplitterMouseDown: noop,
    handleSplitterTouchStart: noop,
    showEditorPaneContainer: false,
    tabStripTabs: [],
    tabStripActiveId: null,
    handleTabActivate: noop,
    handleTabClose: noop,
    handleTabCloseOthers: noop,
    handleTabCloseAll: noop,
    handleTabTogglePin: noop,
    handleTabTogglePreview: noop,
    handleTabToggleDiff: noop,
    handleTabEditSource: noop,
    handleReattachPane: noop,
    previewTabs: new Set(),
    diffTabs: new Set(),
    tabPaneOverrides: new Map(),
    toggleZenMode: noop,
    handlePopOutPane: noop,
    isWebAppMode: false,
    editorContainerRef: { current: null },
    editorInstanceRef: { current: null },
    detachedTabs: [],
    activeDetachedTab: null,
    detachedDockPane: null,
    handleDockSplitterMouseDown: noop,
    handleDockSplitterTouchStart: noop,
    TERMINAL_TAB_PATH: 'terminal',
    dockContainerRef: { current: null },
    handleEditorSplitterMouseDown: noop,
    handleEditorSplitterTouchStart: noop,
    searchQuery: null,
    isIOSDevice: () => false,
    currentBranchRecord: null,
    currentChatJid: 'web:default',
    currentChatBranches: [],
    handleBranchPickerChange: noop,
    formatBranchPickerLabel: () => '',
    openRenameCurrentBranchForm: noop,
    handlePruneCurrentBranch: noop,
    handlePurgeArchivedBranch: noop,
    currentHashtag: null,
    handleBackToTimeline: noop,
    activeSearchScopeLabel: 'Current chat',
    oobePanelState: null,
    composePrefillRequest: null,
    requestComposePrefill: noop,
    handleOobeSetupProvider: noop,
    handleOobeShowModelPicker: noop,
    handleOobeOpenWorkspace: noop,
    handleDismissProviderMissingOobe: noop,
    handleCompleteProviderReadyOobe: noop,
    posts: [],
    isMainTimelineView: true,
    hasMore: false,
    loadMore: noop,
    timelineRef: { current: null },
    handleHashtagClick: noop,
    addMessageRef: noop,
    scrollToMessage: noop,
    openFileFromPill: noop,
    openTimelineFileFromPill: noop,
    handleDeletePost: noop,
    handleOpenFloatingWidget: noop,
    agents: [],
    userProfile: null,
    removingPostIds: new Set(),
    agentStatus: null,
    isCompactionStatus: () => false,
    agentDraft: null,
    agentPlan: null,
    agentThought: null,
    pendingRequest: null,
    intentToast: null,
    currentTurnId: null,
    steerQueued: null,
    handlePanelToggle: noop,
    btwSession: null,
    closeBtwPanel: noop,
    handleBtwRetry: noop,
    handleBtwInject: noop,
    floatingWidget: null,
    handleCloseFloatingWidget: noop,
    handleFloatingWidgetEvent: noop,
    attachmentPreview: null,
    setAttachmentPreview: noop,
    extensionStatusPanels: new Map(),
    pendingExtensionPanelActions: new Set(),
    handleExtensionPanelAction: noop,
    searchOpen: false,
    followupQueueItems: [],
    handleInjectQueuedFollowup: noop,
    handleRemoveQueuedFollowup: noop,
    handleMoveQueuedFollowup: noop,
    viewStateRef: { current: null },
    loadPosts: noop,
    scrollToBottom: noop,
    searchScope: 'current',
    handleSearch: noop,
    handleSearchScopeChange: noop,
    setSearchScope: noop,
    enterSearchMode: noop,
    exitSearchMode: noop,
    fileRefs: [],
    removeFileRef: noop,
    clearFileRefs: noop,
    setFileRefsFromCompose: noop,
    folderRefs: [],
    removeFolderRef: noop,
    clearFolderRefs: noop,
    setFolderRefsFromCompose: noop,
    messageRefs: [],
    removeMessageRef: noop,
    clearMessageRefs: noop,
    setMessageRefsFromCompose: noop,
    handleCreateSessionFromCompose: noop,
    handleCreateRootSessionFromCompose: noop,
    handleRestoreBranch: noop,
    attachActiveEditorFile: noop,
    followupQueueCount: 0,
    handleBtwIntercept: noop,
    handleMessageResponse: noop,
    handleComposeSubmitError: noop,
    isComposeBoxAgentActive: false,
    activeChatAgents: [],
    connectionStatus: 'connected',
    stateAccessFailed: false,
    activeModel: null,
    agentModelsPayload: null,
    activeModelUsage: null,
    activeThinkingLevel: null,
    supportsThinking: false,
    contextUsage: null,
    extensionWorkingState: null,
    notificationsEnabled: false,
    notificationPermission: 'default',
    handleToggleNotifications: noop,
    setActiveModel: noop,
    applyModelState: noop,
    setPendingRequest: noop,
    pendingRequestRef: { current: null },
    toggleWorkspace: noop,
    ...overrides,
  };
}

test('renderMainShell passes queue controls to ComposeBox and does not render a top-level queue stack', () => {
  const followupQueueItems = [{ row_id: 7, content: 'queued item' }];
  const handleRemoveQueuedFollowup = mock(() => {});

  const tree = renderMainShell(createMainShellRenderOptions({
    followupQueueItems,
    handleRemoveQueuedFollowup,
  }));

  let composeVNode: any = null;
  let topLevelQueueStackCount = 0;

  walkVNodes(tree, (node) => {
    if (node.type === ComposeBox) composeVNode = node;
    if (node.type === QueuedFollowupStack) topLevelQueueStackCount += 1;
  });

  expect(composeVNode).toBeTruthy();
  expect(composeVNode.props.followupQueueItems).toBe(followupQueueItems);
  expect(composeVNode.props.onRemoveQueuedFollowup).toBe(handleRemoveQueuedFollowup);
  expect(composeVNode.props.showQueueStack).toBeUndefined();
  expect(topLevelQueueStackCount).toBe(0);
});

test('renderMainShell binds compose Abort to the operation identity in the authoritative status', () => {
  const tree = renderMainShell(createMainShellRenderOptions({
    agentStatus: {
      type: 'thinking',
      operation_id: 'operation-visible-1',
      operation_authority: 'durable',
    },
    isComposeBoxAgentActive: true,
  }));

  let composeVNode: any = null;
  walkVNodes(tree, (node) => {
    if (node.type === ComposeBox) composeVNode = node;
  });

  expect(composeVNode).toBeTruthy();
  expect(composeVNode.props.activeOperationId).toBe('operation-visible-1');
  expect(composeVNode.props.activeOperationAuthority).toBe('durable');
});

test('handleComposePost does nothing while search is active', () => {
  const scrollToBottom = mock(() => {});
  const scrollPostedMessage = mock(() => {});

  handleComposePost({
    response: { user_message: { id: 99 } },
    viewStateRef: { current: { searchQuery: 'foo', searchOpen: true } },
    scrollToBottom,
    scrollPostedMessage,
  });

  expect(scrollToBottom).not.toHaveBeenCalled();
  expect(scrollPostedMessage).not.toHaveBeenCalled();
});

test('scrollToPostedTimelineMessage waits for the existing row and highlights it without reloading', () => {
  const element = {
    scrollIntoView: mock(() => {}),
    classList: {
      add: mock(() => {}),
      remove: mock(() => {}),
    },
  } as any;
  let lookups = 0;
  const getElementById = mock((id: string) => {
    lookups += 1;
    if (id !== 'post-77') return null;
    return lookups >= 3 ? element : null;
  });
  const rafQueue: Array<() => void> = [];
  const timeoutQueue: Array<() => void> = [];
  const scrollToBottom = mock(() => {});

  scrollToPostedTimelineMessage({
    id: 77,
    scrollToBottom,
    getElementById,
    scheduleRaf: (callback) => { rafQueue.push(callback); },
    scheduleTimeout: (callback, delayMs) => {
      if (delayMs === 2000) {
        callback();
        return;
      }
      timeoutQueue.push(callback);
    },
    maxAttempts: 4,
  });

  while (rafQueue.length > 0 || timeoutQueue.length > 0) {
    const raf = rafQueue.shift();
    if (raf) raf();
    const timeout = timeoutQueue.shift();
    if (timeout) timeout();
  }

  expect(getElementById).toHaveBeenCalled();
  expect(element.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
  expect(element.classList.add).toHaveBeenCalledWith('post-highlight');
  expect(element.classList.remove).toHaveBeenCalledWith('post-highlight');
  expect(scrollToBottom).not.toHaveBeenCalled();
});
