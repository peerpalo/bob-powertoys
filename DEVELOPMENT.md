# PowerToys for Bob Development Guide

## Project Structure

```
bob-powertoys/
├── src/
│   ├── extension.ts              # Extension entry point and lifecycle
│   ├── taskManager.ts            # Task commands, last-task persistence
│   ├── debugAdapter.ts           # Centralized debug adapter tracker
│   ├── utils.ts                  # Shared utilities: taskManager access, frame resolution
│   └── tools/                    # Individual tool modules
│       ├── workspace.ts          # Multi-root workspace tools (10 tools + prompt injection)
│       ├── breakpoints.ts        # Breakpoint management (batch operations)
│       ├── debugControl.ts       # Debug stepping & control
│       ├── debugConsole.ts       # Debug console & variable inspection
│       ├── debugSession.ts       # Debug session management
│       ├── terminalConsole.ts    # Terminal output capture & search
│       ├── bobExtensions.ts      # list_extensions tool
│       └── universeAnswer.ts     # Easter egg tool
├── out/                          # Compiled JavaScript output
├── .vscode/
│   ├── launch.json               # Debug configurations
│   └── tasks.json                # Build tasks
├── package.json                  # Extension manifest and dependencies
├── tsconfig.json                 # TypeScript configuration
├── README.md                     # User documentation
└── DEVELOPMENT.md                # This file
```

---

## Architecture

### High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                Bob Extension: PowerToys for Bob                  │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────────┐         ┌──────────────────────────────┐   │
│  │  Bob Public API  │         │  Centralized Debug Adapter   │   │
│  │  registerSource  │         │  - Output capture            │   │
│  │                  │         │  - State tracking            │   │
│  │  Tool Registry   │◄────────┤  - Breakpoint notifications  │   │
│  └────────┬─────────┘         └──────────────────────────────┘   │
│           │                              ▲                       │
│           │                              │                       │
│           │                    ┌─────────┴───────────┐           │
│           │                    │  VSCode APIs        │           │
│           │                    │  - Debug API (DAP)  │           │
│           │                    │  - Terminal API     │           │
│           │                    │  - Workspace API    │           │
│           │                    └─────────────────────┘           │
│           ▼                                                      │
│  ┌───────────────────────────────────────────────────────────┐   │
│  │  Bob Internal taskManager extraction                      │   │
│  │  - extractTaskManager via Array.prototype.find patch      │   │
│  │  - enables: openTaskInWindow, last-task persistence       │   │
│  └───────────────────────────────────────────────────────────┘   │
└───────────┬──────────────────────────────────────────────────────┘
            │ Bob's Native Tool Interface
            │ Direct integration via registerSource
            │ + Automatic breakpoint notifications
            ▼
   ┌──────────────────┐
   │  Bob Assistant   │
   │  (AI Assistant)  │
   └──────────────────┘
```

### Host Extension

IBM Bob is a fork of VS Code. The Bob application ships a built-in extension with the VS Code extension ID **`IBM.bob-code`** - this is the extension that PowerToys activates against. It is always present in any Bob installation; there is nothing to install separately.

PowerToys declares `"extensionDependencies": ["IBM.bob-code"]` in `package.json`, which guarantees Bob is fully activated before our `activate()` runs, and gives us access to `bobExtension.exports` via:

```typescript
const bobExtension = vscode.extensions.getExtension('IBM.bob-code');
const bobExports = await bobExtension.activate();
```

### Extension Lifecycle

```typescript
activate(context)
    ↓
extensionContext = context                       // saved module-level for deactivate/saveLastTask
registerTerminalCapture(context)                 // terminal shell execution tracking
    ↓
bobExtension.activate().then(...)
    ↓
registerPowerToys(context, bobExports)
    ├── await registerTaskManager(bobExports)    // extract & cache internal taskManager (with retries)
    ├── await restoreLastTask(context)           // reopen last task from globalState
    ├── registerLastTaskSave()                   // wrap webview to intercept setCurrentTasks
    ├── registerDebugAdapterTracker(bobExports)  // DAP event tracking + notifications
    ├── bobExports.registerSource(...)           // register tool source
    └── register 29 tools
    ↓
Commands registered (independent of Bob):
    ├── bob-powertoys.showStatus
    ├── bob-powertoys.newTaskInWindow
    └── bob-powertoys.openTaskInWindow
    ↓
deactivate() -> statusBarItem.dispose()
```

---

## Bob's Public API

`bobExtension.exports` exposes exactly 6 methods:

```typescript
bobExports.registerSource(id: string, name: string): Source
bobExports.setFindings(...)
bobExports.setChatContent(content: string, append: boolean)
bobExports.openNewTask(...)
bobExports.startTask(...)
bobExports.startWorkflow(...)
```

The `Source` object returned by `registerSource` exposes:

```typescript
source.registerTool(tool: Tool): void
source.isEntitled(): boolean                      // true when Bob is logged in and has a valid entitlement
source.onEntitlementChange(cb: () => void): void  // fires when login/logout changes entitlement state
source.onTurnStart(cb: (taskId: string, envs: any, isEmpty: boolean) => void): void
source.onTurnEnd(cb: () => void): void
source.onToolWillExecute(cb): void
source.onToolExecution(cb): void
source.onToolDidExecute(cb): void
source.onCommandWillExecute(cb): void
```

**`taskManager` is NOT on the public exports.** It must be extracted via internal hack (see below).

### Login-deferred registration

The registration flow is split into two phases:

1. **Always runs** (`registerPowerToys`): `registerSource` + `registerTool` calls. These always succeed regardless of login state because Bob's `BobSourceRegistry` accepts sources unconditionally.

2. **Login-dependent** (`completeRegisterPowerToys`): `registerTaskManager`, `registerTaskPersistence`, `restoreTasks`, debug adapter tracker. These require Bob to be logged in (chat panel must exist).

If Bob is not yet logged in when the extension activates, `registerTaskManager` throws. `completeRegisterPowerToys` catches this and arms a one-shot `source.onEntitlementChange` listener to retry:

```typescript
// Phase 1 — always works
const source = bobExports.registerSource(EXTENSION_ID, EXTENSION_DISPLAY_NAME);
registerBreakpointTools(source);
// ... all other registerXxxTools calls ...

// Phase 2 — login-dependent
await completeRegisterPowerToys(context, bobExports, source);

// inside completeRegisterPowerToys:
try {
  await registerTaskManager(bobExports);
} catch {
  // Bob not logged in yet — retry when entitlements are re-evaluated on login
  let fired = false;
  const disposable = source.onEntitlementChange(() => {
    if (fired) { return; }
    fired = true;
    disposable.dispose();
    completeRegisterPowerToys(context, bobExports, source);
  });
  context.subscriptions.push(disposable);
  return;
}
```

Key points:
- `source.onEntitlementChange` fires when Bob logs in and re-evaluates entitlements — confirmed by testing. It fires even though our source is not a paid addon; Bob's `AddonManager.triggerEntitlementChange()` iterates all enabled sources in the registry.
- `registerSource` and `registerTool` must happen **before** `completeRegisterPowerToys` so that our source is already in the registry (and thus receives `onEntitlementChange`) when Bob later logs in.
- The `fired` guard makes the listener one-shot, preventing duplicate setup if the event fires more than once.
- `source.isEntitled()` reflects **subscription** state, not login state — do not use it as a login gate.
- `vscode.authentication.onDidChangeSessions` was previously used as the retry hook but is incorrect — it is a VS Code-level auth event, not tied to Bob's internal session state.

---

## Bob Internal Structures

### taskManager - key methods

```typescript
taskManager.getTopLevelChatManager()          // returns mainPanelTask (sidebar panel chatManager)
taskManager.openTask({ taskId? })             // opens a task in the sidebar; {} = go home
taskManager.openTaskInNewTab(taskId)          // opens a task as an editor tab
taskManager.getChatManagerByTaskId(taskId)    // active task lookup
taskManager.getOpenChatManagerByRootTaskId(taskId) // backgrounded task lookup
taskManager.deleteTask(taskId)
taskManager.cancelTask(taskId)
taskManager.renameTask(taskId, name)
taskManager.getTaskMetadata(taskId)
taskManager.store.onEvent(cb)                 // fires task.created / task.opened / task.updated / task.deleted / task.status / task.cancelled
```

### chatManager - key methods

```typescript
chatManager.getTaskId()                       // current task ID (numeric string)
chatManager.isEmpty()                         // true when on home/new-task screen
chatManager.isProcessing()                    // true while Bob is running a turn
chatManager.handleInputMessage(msg, task)     // inject a user message
chatManager.pushSessionHistory()              // refresh history panel
chatManager.onWebviewSet(cb)                  // fires every time the webview becomes ready
chatManager.onceWebviewUnset(cb)              // fires once when webview is closed/unset
chatManager._webview                          // the active webview wrapper (Q1 class)
chatManager.view                              // alias (same object in some contexts)
```

### webview wrapper - key methods

```typescript
webview.sendMessage(msg)                      // send a message to the webview HTML
webview.onMessage(type, handler)              // register a handler for a webview->extension message
webview.onDispose(cb)                         // fires when the webview panel is disposed
webview.isPanel                               // true when displayed as editor tab (not sidebar)
webview.view                                  // underlying VSCode WebviewPanel (has onDidChangeViewState)
```

---

## taskManager Extraction

Bob does not expose `taskManager` in its public API. We obtain it by temporarily patching `Array.prototype.find`:

```
bobExports.setChatContent('', false)
  └─► chatManager.getTopLevelChatManager()
        └─► this._chatManagers.find(e => e.view?.isPanel === false)
              └─► Array.prototype.find fires with this = _chatManagers array
                    └─► this[0].taskManager  ← that's N0
```

The patch lives for a single synchronous call and is removed in a `finally` block.

**Returns `null` if no chat managers exist yet** (Bob panel not yet rendered). `registerTaskManager` retries up to 3 times with a 1-second delay to handle this race.

```typescript
// src/utils.ts
export async function registerTaskManager(bobExports: any): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const tm = bobExports?.taskManager ?? extractTaskManager(bobExports);
    if (tm != null) { _cachedTaskManager = tm; return; }
    if (attempt < 3) await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('taskManager not available after all retries');
}

export function getTaskManager(): any {
  return _cachedTaskManager;
}
```

---

## getBobTool — accessing Bob's built-in tools

`getBobTool(taskId, toolId)` in [`src/utils.ts`](src/utils.ts) resolves any of Bob's registered built-in tool instances at call time by walking the live task graph:

```
findTaskChatManager(taskId) → chatManager → currentTask → getTools()
                                                              ↓
                                                    search by .id here
```

`taskId` (`context.env.id`) is **mandatory**. It is used to find the exact chatManager running the current task via `findTaskChatManager`, which checks both active and backgrounded states. Without it, the old approach (`taskManager.mainPanelTask`) always returned the sidebar chatManager — which has no `currentTask` for tab-based tasks — causing lookup failures after context compaction.

Bob stores all active tools in a plain array on the `Task` object. `getBobTool` finds the entry whose `.id` matches `toolId` and returns it, or `null` if the task manager is not ready, the task is not found, or the tool is not present in the current mode.

### Why this is needed

Bob's built-in tools have complex internal implementations (fuzzy diff engine, `execa` shell runner, `DiagnosticDiff` captures, truncation detection, undo entry registration) that live inside the closed Bob bundle. Reimplementing them would be brittle and would silently diverge on every Bob update.

Instead, every workspace tool resolves the live tool object at call-time via `getBobTool(id)` and delegates to its `call()` method, patching only what needs to change in the forwarded context.

### Delegation pattern

All callers follow the same three-step pattern:

1. `resolveInFolder(workspace, '')` → get the secondary folder's absolute `fsPath`
2. `getBobTool(context.env.id, toolId)` → get the live Bob tool instance for this task
3. `tool.call({ ...context, env: { ...context.env, workspace: fsPath }, parameters: { /* workspace stripped */ }, ... shims })` → forward

**Context shims** bridge Bob's internal callbacks back to our context:

| Shim | Used by | What it does |
|---|---|---|
| `trackFileRead(uri, mtime)` | `read_workspace_file` | Writes into `K.fileMtimes` via `context.setMetadata?.({ fileMtimes: { [uri]: mtime } })` |
| `pushEdit(uri, { before, after, mtime })` | all edit tools | Writes into `K.changes` and `K.fileMtimes` via `context.setMetadata?.({ changes: { [uri]: ... }, fileMtimes: ... })` |

### Current callers

| Caller | `toolId` | What it patches |
|---|---|---|
| `ReadWorkspaceFileTool` | `'read_file'` | `env.workspace`, strips `workspace` param, adds `trackFileRead` shim |
| `ListWorkspaceFilesTool` | `'list_files'` | `env.workspace`, strips `workspace` param |
| `GlobWorkspaceTool` | `'glob'` | `env.workspace` per root (loops for all-folders case), strips `workspace` param |
| `GrepWorkspaceTool` | `'grep'` | `env.workspace` per root (loops for all-folders case), strips `workspace` param |
| `WriteWorkspaceFileTool` | `'write_file'` | `env.workspace`, strips `workspace` param, adds `pushEdit` shim |
| `InsertWorkspaceContentTool` | `'insert_content'` | `env.workspace`, strips `workspace` param, adds `pushEdit` shim |
| `SearchAndReplaceWorkspaceTool` | `'search_and_replace'` | `env.workspace`, strips `workspace` param, adds `pushEdit` shim |
| `ApplyDiffWorkspaceTool` | `'apply_diff'` | `env.workspace`, strips `workspace` param, adds `pushEdit` shim |
| `ExecuteWorkspaceCommandTool` | `'execute_command'` | `env.workspace` set to resolved `cwd`, strips `workspace` and `cwd` params |

### Key internal objects accessed

| Expression | What it is |
|---|---|
| `findTaskChatManager(taskManager, taskId)` | Finds the chatManager by task ID (active or backgrounded) |
| `chatManager.currentTask` | The active `Task` object |
| `task.getTools()` | Flat array of all tool instances registered for the current mode |
| `tool.id` | String identifier matching what Bob exposes as the tool name |

---

## registerWebviewToolNamePatch — rich UI for workspace tool results

Bob's webview renderer (`chat-*.js`) keys off `toolUsage.signature.name` to decide which rich component to render for a tool result. It hardcodes the built-in names (`"read_file"`, `"list_files"`, `"glob"`, `"grep"`) — tools with any other name fall through to a plain `MarkdownBlock`.

`registerWebviewToolNamePatch()` in [`src/tools/workspace.ts`](src/tools/workspace.ts) does two things:
1. **Name remapping** — intercepts outbound `{ type: "setMessages" }` messages and maps workspace tool names to their built-in equivalents so the rich renderer components (`FileListBlock`, `GrepResultBlock`, `CodeBlock`) are used.
2. **Click-to-open path resolution** — intercepts inbound `{ type: "openFile" }` messages from the webview and resolves secondary-folder paths to their correct absolute location before Bob's own handler sees them.

### Data flow — outbound (name remapping)

```
task messages (BobTask.getMessages())
  └─► D5e.updateMessagesUi()
        └─► aM.updateMessagesUi(tasks, workspace, getMessagesFn)
              └─► aM.sendMessage({ type: "setMessages", taskId, messages })
                    └─► webview HTML → React store → renderer
```

The messages array inside `{ type: "setMessages" }` contains raw task message objects. Each tool-result message has a `toolUsage.signature.name` field — this is what the renderer reads.

### Data flow — inbound (click-to-open)

```
user clicks a path link in the chat UI
  └─► webview ct() prepends "./" to relative paths
        └─► acquireVsCodeApi().postMessage({ type: "openFile", filePath })
              └─► aM.onMessage handler → resolveOpenFilePath(filePath, folders)
                    └─► Bob's kH() resolver → vscode.open
```

Bob's `kH()` resolver always joins against the primary workspace root, so clicks on secondary-folder paths open the wrong file. `wrapHandler` intercepts the `openFile` message and calls `resolveOpenFilePath` (from `src/utils.ts`) to correct the path before Bob's handler fires.

### Patch strategy

1. **`patchView(view)`** — wraps `view.sendMessage` on a single `aM` (webview) instance. Intercepts `{ type: "setMessages" }`, maps each message's `toolUsage.signature.name` through `NAME_MAP`, and forwards the (possibly mutated) message object to the original. Also wraps `view.onMessage` so the `openFile` handler is replaced with `wrapHandler(originalHandler)`.

2. **`patchChatManager(cm)`** — runs `patchView` on any view already assigned to `cm.ui`, then wraps `cm.ui.setWebview()` so every future view assignment is also patched immediately.

3. **`_chatManagers.push` intercept** — catches chatManagers created after extension activation.

4. **`wrapHandler(handler)`** — returns a new handler that calls `resolveOpenFilePath` on `openFile` messages, then delegates to the original handler.

### NAME_MAP

| Workspace tool | Renders as |
|---|---|
| `read_workspace_file` | `read_file` (CodeBlock) |
| `list_workspace_files` | `list_files` (FileListBlock) |
| `glob_workspace` | `glob` (FileListBlock) |
| `grep_workspace` | `grep` (GrepResultBlock) |

Edit tools (`write_workspace_file`, etc.) already get `DiffView` via `_meta.changes.patch` set by the `pushEdit` shim — no name remapping needed for them.

### absolutiseToolContent — correct paths in FileListBlock / GrepResultBlock

`FileListBlock` and `GrepResultBlock` render paths as clickable links using the raw text emitted by Bob's `formatOutput` / `formatFilesOutput`. Those functions write *relative* paths (via `path.relative(workspaceRoot, absPath)`), so links for secondary-folder tools point to the wrong location.

The `pushResult` wrappers in `glob_workspace` and `grep_workspace` call `absolutiseToolContent(content, 'glob'|'grep', workspaceRoot)` (from `src/utils.ts`) to rewrite relative paths to absolute before the result is stored, so the rendered links are always correct regardless of which folder was searched.

---

## System Prompt Injection

Bob builds a new system message on **every turn**. There is no public API for appending to it - but we can mutate the message object directly once it exists.

### Why it's needed

`source.onTurnStart` is the earliest hook we have. However, the call sequence is:

```
onTurnStart(taskId, envs, isEmpty) ← our callback fires HERE
  └─► l.submitTurn(...)
        └─► ZJo(t, ...)
              └─► t.newMessage({ appendSystem: ..., ... })  ← system message built HERE
```

When `onTurnStart` fires, `messages[0]` with `role === "system"` **does not yet exist**. Any attempt to append to it synchronously is a no-op (the object hasn't been created).

### The polling fix

After `onTurnStart` fires we schedule a micro-task (`setTimeout(tryInject, 0)`) that polls until the system message appears, then mutates its `content` string in-place:

```typescript
// src/tools/workspace.ts - registerWorkspacePromptInjection()
source.onTurnStart((taskId: string, _envs: any, isEmpty: boolean) => {
  if (!isEmpty || folders.length < 2) { return; }   // only on new turns in multi-root workspaces

  const injection = buildInjection(folders);

  const MAX_POLLS = 50;   // ~500 ms total
  const POLL_MS   = 10;
  let   attempts  = 0;

  function tryInject() {
    const tm = getTaskManager();                    // cached, never null after activation
    const cm = findTaskChatManager(tm, taskId);     // active or backgrounded chatManager
    const messages = cm?.currentTask?.getMessages?.();
    const systemMessage = messages?.[0];

    if (!systemMessage || systemMessage.role !== 'system') {
      if (++attempts < MAX_POLLS) { setTimeout(tryInject, POLL_MS); }
      return;                                       // not ready yet - retry
    }

    systemMessage.content += injection;             // mutate in-place ✓
  }

  setTimeout(tryInject, 0);
});
```

### Key internal objects accessed

| Expression | What it is |
|---|---|
| `getTaskManager()` | Cached `_4` / N0 singleton from the extraction hack |
| `cm.currentTask` | The active `Task` object inside the chatManager |
| `cm.currentTask.getMessages()` | Returns the ordered message array for the current turn |
| `messages[0]` | System message - always first; `role === "system"` when present |
| `systemMessage.content` | Mutable string - append our block here |

### Conditions checked before injecting

| Condition | Reason |
|---|---|
| `isEmpty === true` | `onTurnStart` fires on every turn, including resume turns on an already-started task. `isEmpty` is `true` only when the task has **no prior messages** - i.e. the very first user message in a brand-new task. That's the only turn where the system message is freshly built and our injection needs to be added. |
| `folders.length >= 2` | Injection is only meaningful in multi-root workspaces |
| `systemMessage.role === 'system'` | Guard against `messages` existing but not yet having a system entry |

### What was tried and why the alternatives failed

| Approach | Problem |
|---|---|
| Append synchronously in `onTurnStart` | System message doesn't exist yet at that point |
| `appendSystem` option on `newMessage` | Internal to Bob's UI layer - not accessible from `registerSource` callbacks |
| `source.onTurnEnd` + prepend | Turn is already finished; LLM never sees the update |
| Long `setTimeout` (e.g. 200 ms) | Brittle - slow machines may miss it; fast machines waste time |
| **Poll with `setTimeout(0)` × 50** | **Works - system message typically appears within 1–3 polls (~10–30 ms)** |

---

## Commands

| Command ID | Title (palette) | Where it appears |
|---|---|---|
| `bob-powertoys.showStatus` | PowerToys for Bob: Show Status | Command palette |
| `bob-powertoys.newTaskInWindow` | PowerToys for Bob: New Task In Window | `bob-code.moreOptions` dropdown (the "..." button) |
| `bob-powertoys.openTaskInWindow` | PowerToys for Bob: Open Task In Window | Right-click inside Bob's webview (`webview/context`) |
| `bob-powertoys.openTaskInEditor` | PowerToys for Bob: Open Task In Editor | Right-click inside Bob's webview (`webview/context`) |

> **Note:** "New Task In Editor" is intentionally absent - Bob already provides this action in its own "More Options" (`...`) menu, so we don't duplicate it.

Both `openTaskInWindow` and `openTaskInEditor` are gated by the `bob-powertoys.hasLastSidebarTask` context key - they only appear in the right-click menu when a sidebar task is currently active.

### openTaskInWindow logic

1. `getTaskManager().getTopLevelChatManager()` - get the sidebar chatManager
2. Check `chatManager.isEmpty()` - if `true`, user is on the home screen (no real task)
3. If a task is active:
   - `taskManager.openTask({})` - navigate sidebar back to home (releases the panel)
   - `taskManager.openTaskInNewTab(taskId)` - open as an editor tab
   - `workbench.action.moveEditorToNewWindow` - pop the tab into a new OS window
4. If no active task: `bob-code.task.pickWorkspaceInEditor` + `moveEditorToNewWindow`

### openTaskInEditor logic

Identical to `openTaskInWindow` but **omits** the final `moveEditorToNewWindow` step - the task opens as an editor tab in the current window.

1. `getTaskManager().getTopLevelChatManager()` - get the sidebar chatManager
2. Check `chatManager.isEmpty()` - if `true`, user is on the home screen
3. If a task is active:
   - `taskManager.openTask({})` - navigate sidebar back to home
   - `taskManager.openTaskInNewTab(taskId)` - open as an editor tab in the current window
4. If no active task: `bob-code.task.pickWorkspaceInEditor` (opens a task picker as a tab)

---

## Last-Task Persistence

On every session restart, Bob shows the home screen. We save and restore both the sidebar task and all editor-tab tasks using `ExtensionContext.globalState`.

### Scope

| Location | Tracked? | globalState key | Restore call |
|---|---|---|---|
| Sidebar (`isPanel === false`) | single task ID | `bob-powertoys.lastSidebarTaskId` | `openTask({ taskId })` |
| Editor tab (`isPanel === true`) | set of `{ taskId, viewColumn }` per window | `bob-powertoys.tabsTaskIds` | `openTaskInNewTab(taskId)` + `panel.reveal(col)` |
| New OS window | via per-window bucket in `tabsTaskIds` | same key, different bucket | each window restores its own bucket independently |

### Module-level state

```typescript
let lastSidebarTaskId: string | undefined;
```

This variable mirrors `globalState`. It drives the `bob-powertoys.hasLastSidebarTask` context key which controls the right-click menu entry visibility.

### Storage types

```typescript
interface TabEntry { taskId: string; viewColumn: number; }
type TabsStore = Record<string, TabEntry[]>; // windowKey - entries
```

`TABS_TASK_IDS_KEY` stores a `TabsStore` - a map from window fingerprint to the list of tab entries for that window. Each entry records both the task ID and its editor column so it can be restored to the same position.

### Window fingerprint (`windowKey()`)

Each OS window gets a unique key computed from:

```typescript
function windowKey(): string {
  const cols = vscode.window.tabGroups.all
    .map(g => g.viewColumn).sort().join(',');
  return `${vscode.env.sessionId}:${cols}`;
}
```

`vscode.window.tabGroups.all` is **scoped to the current OS window** - each window's extension host only sees its own tab groups. Combined with `sessionId` as a session salt, this produces a key that is stable within a window's lifetime and unique across windows even on the same workspace.

### Save: webview message interception

`wrapWebviewSendMessage(context, chatManager, isPanel)` patches `chatManager._webview.sendMessage` to intercept `setCurrentTasks`. Bob sends this message to both sidebar and tab webviews whenever the active task changes - it fires reliably with no shutdown race.

```typescript
wv.sendMessage = (msg) => {
  if (msg?.type === 'setCurrentTasks') {
    const hasTasks = (msg.tasks?.length ?? 0) > 0;
    if (!isPanel || hasTasks) saveTasks(context, chatManager, isPanel);
  }
  return originalSend(msg);
};
```

- **Sidebar** (`isPanel === false`): fires on every message including empty - clears state when user navigates home
- **Tab** (`isPanel === true`): only fires when `tasks.length > 0` - ignores the empty home-screen signal

For tabs, `wrapWebviewSendMessage` also hooks `wv.onDispose` to call `removeTabTask` when the tab is closed.

### Save: openTask patch (tab chatManager interception)

Tab chatManagers are created on-demand inside `openTask`. We intercept them by patching `taskManager.openTask` in `registerTaskPersistence`:

```typescript
taskManager.openTask = async (opts) => {
  const result = await originalOpenTask(opts);
  if (result?._webview?.isPanel === true)
    wrapWebviewSendMessage(context, result, true);
  return result;
};
```

Guarded by `__bobPowerToysPatched` so it is applied exactly once.

### Save: tab data written

`saveTasks` (tab branch) reads `panel.viewColumn` from `chatManager._webview.view` (the underlying `vscode.WebviewPanel`) and upserts the entry under the current `windowKey()`. If the user moves the tab to a different column, the next `setCurrentTasks` updates the stored `viewColumn`.

### Restore: on startup

`restoreTasks(context)` is called once in `registerPowerToys` after `registerTaskPersistence` (so the `openTask` patch is already in place before any `openTaskInNewTab` calls).

1. **Sidebar**: reads `LAST_SIDEBAR_TASK_ID_KEY`, calls `openTask({ taskId })`. Clears state if the task no longer exists.
2. **Tabs**: reads the `TabsStore`, finds the bucket for `windowKey()`, calls `openTaskInNewTab(taskId)` for each entry, then `panel.reveal(viewColumn, true)` to restore the original column position.
3. **Blank window guard**: if both the sidebar key and the tab bucket are empty, the window was reopened blank by VSCode's session restore with nothing to show - it is closed via `workbench.action.closeWindow`.

Each OS window's extension host runs `restoreTasks` independently and only restores its own bucket. Other windows' buckets are left untouched for their own hosts to handle.

### Cleanup: tab closed

`removeTabTask` is called from the `wv.onDispose` hook registered in `wrapWebviewSendMessage`. It removes the entry from the bucket under `windowKey()` and cleans up the key from `globalState` if the bucket becomes empty.

### Context key: bob-powertoys.hasLastSidebarTask

| Value | When |
|---|---|
| `true` | A sidebar task has been saved (set by `saveTasks` or `restoreTasks`) |
| `false` | Home screen active, task deleted, or first ever launch |

Used in `package.json` as: `"when": "webviewId == bobChatView && bob-powertoys.hasLastSidebarTask"`

### What was tried and why it didn't work

| Approach | Problem |
|---|---|
| `deactivate()` returning `Thenable<void>` | VSCode doesn't reliably await it before killing the process |
| `context.subscriptions.push({ dispose: () => save() })` | Same issue - async writes are lost at shutdown |
| `vscode.window.onDidChangeWindowState` | Works but fires on every focus change - noisy |
| `source.onTurnStart` | Requires user to send a message first |
| `chatManager.onWebviewSet` / `onceWebviewUnset` | Did not fire from outside Bob's own code |
| `taskManager.store.onEvent` | Did not fire from outside Bob's own code |
| `panel.onDidChangeViewState` | Did not fire reliably |
| `vscode.env.sessionId` as window key | Same value across all OS windows in a session |
| `WebviewPanelSerializer` anchor panel | `registerPowerToys` only runs in main window - serializer fires in secondary windows before Bob activates |
| **webview `sendMessage` intercept** | **Works - fires on every task change during normal use** |
| **`taskManager.openTask` patch** | **Works - intercepts every new tab chatManager before it becomes active** |
| **`tabGroups.all` viewColumn fingerprint** | **Works - window-scoped, unique per OS window** |

---

## Configuration Settings

### breakpointNotifications

Controls when Bob is automatically notified about breakpoint hits.

| Value | Behavior |
|---|---|
| `disabled` | Never notify Bob |
| `bobOnly` | Only notify for breakpoints set via Bob's tools (default) |
| `all` | Notify for all breakpoint hits |

---

## Key Components

### 1. extension.ts

**Purpose**: Extension lifecycle and Bob integration only. No task or persistence logic.

**Key functions**:
- `activate(context)` - entry point; registers status bar, waits for Bob, calls `registerTaskCommands`
- `registerPowerToys(context, bobExports)` - phase 1: calls `registerSource` then all `registerXxxTools`; always succeeds regardless of login state
- `completeRegisterPowerToys(context, bobExports, source)` - phase 2: calls `registerTaskManager`, `registerTaskPersistence`, `restoreTasks`, debug adapter tracker; retries via `source.onEntitlementChange` if Bob is not yet logged in
- `showStatus()` / `showStatusBarError()` - status bar management

### 2. taskManager.ts

**Purpose**: All task-related concerns: window commands, task persistence (sidebar + tabs), webview interception.

**Exported functions**:
```typescript
registerTaskCommands(context): void       // registers newTaskInWindow + openTaskInWindow
registerTaskPersistence(context): void    // wraps sidebar webview + patches taskManager.openTask for tabs
restoreTasks(context): Promise<void>      // restores sidebar task + tab tasks; closes blank windows
```

**Internal types**:
```typescript
interface TabEntry { taskId: string; viewColumn: number; }
type TabsStore = Record<string, TabEntry[]>; // windowKey - entries
```

**Internal state**:
- `lastSidebarTaskId: string | undefined` - mirrors globalState, drives the context key
- `wrappedWebviews: WeakSet` - prevents double-patching the same webview object
- `LAST_SIDEBAR_TASK_ID_KEY` - globalState key (`bob-powertoys.lastSidebarTaskId`)
- `TABS_TASK_IDS_KEY` - globalState key (`bob-powertoys.tabsTaskIds`) - `TabsStore` JSON
- `HAS_LAST_SIDEBAR_TASK_CTX` - VSCode context key (`bob-powertoys.hasLastSidebarTask`)

**Private functions**:
- `windowKey()` - returns `sessionId:cols` fingerprint unique per OS window
- `wrapWebviewSendMessage(context, chatManager, isPanel)` - patches `sendMessage`; for tabs also hooks `wv.onDispose`
- `saveTasks(context, chatManager, isPanel)` - sidebar: writes taskId + context key; tab: upserts `TabEntry` with viewColumn
- `removeTabTask(context, taskId)` - removes entry from the current window's bucket (called from `onDispose`)

### 3. debugAdapter.ts

**Purpose**: Centralized debug adapter tracker - output capture, state tracking, breakpoint notifications.

**Exported functions**:
```typescript
getCurrentStoppedState(): { threadId: number; frameId?: number } | undefined
getRecentDebugOutput(lineCount?: number): string
registerDebugAdapterTracker(bobExports: any): vscode.Disposable
flushPendingNotifications(): Promise<void>
```

**Notification routing**:
- On DAP `stopped` with `reason: breakpoint`, fetches stack trace + local variables
- `getBreakpointOwner(file, line)` looks up which Bob task set that breakpoint
- `findTaskChatManager(taskManager, taskId)` does escalating lookup: active -> backgrounded
- `safeNotify(chatManager, taskId, message)` injects the message into the correct task

### 4. utils.ts

**Purpose**: Shared utilities - taskManager lifecycle, chat manager lookup, Bob tool access, frame resolution, workspace path helpers.

**Exported functions**:
```typescript
extractTaskManager(bobExports: any): any            // internal hack, sync
registerTaskManager(bobExports: any): Promise<void> // resolves + caches, with retries
getTaskManager(): any                               // returns cached instance
findTaskChatManager(taskManager, taskId): any|null  // active + backgrounded lookup
getBobTool(taskId: string, toolId: string): any | null  // resolves a Bob built-in tool for the given task (context.env.id)
resolveFrameId(frameId, resolveTopFrame): Promise<number|undefined>
normaliseWorkspacePath(filePath: string): string    // normalises user-supplied relative paths for vscode.Uri.joinPath
absolutiseToolContent(content, tool, workspaceRoot): string  // absolutises relative paths in glob/grep tool output
resolveOpenFilePath(filePath, folders): string      // resolves ./folderName/... webview click paths to absolute
```

### 4. Bob's Tool Interface

Each tool implements:

```typescript
class MyTool {
  static id = 'my_tool';
  groups = ['read'];       // or ['edit'] / ['execute']
  permission = 'read';     // or 'edit' / 'execute'

  getId(): string { return MyTool.id; }
  enabled(_env?: any): boolean { return true; }  // optional: hide tool when false
  getDescription(_env?: any): string { ... }     // full description in system prompt
  getCostEffectiveDescription(): string { ... }  // brief one-liner for tool selection

  private static readonly PARAMS = [
    {
      name:        'param1',            // parameter key used in context.parameters
      type:        'string',            // 'string' | 'number' | 'boolean' | 'array'
      required:    true,                // false or omit - optional
      description: 'Full sentence sent to the LLM.',   // read by toolToOpenAi - LLM schema
      detail:      'Short label in approval UI.',      // read by module 25772 - approval dialog label
      usage:       'example value',                    // autocomplete hint shown in UI
                                                       // special sentinel: 'command' - triggers Approve/Reject dialog
      renderHint:  'code',                             // optional — controls approval dialog rendering:
                                                       //   'code'   - single-line code block (commands, paths)
                                                       //   'diff'   - diff viewer
                                                       //   'json'   - JSON viewer
                                                       //   'text'   - plain text
                                                       //   'hidden' - not shown (e.g. workspace name, already in title)
                                                       //   omit     - default: paramName: value style
                                                       // if NO param in the tool has renderHint - raw JSON blob fallback
    },
  ];

  // Property - read by toolToOpenAi(e).parameters
  parameters = paramsToSchema(MyTool.PARAMS);

  // Method - read by the newer getParameters(env) paths
  getParameters(_env?: any): any[] { return MyTool.PARAMS; }

  getLabels(args: Record<string, any>) {
    return {
      displayName: `My Tool: ${args.param1}`,
      running:     `Running with ${args.param1}…`,
      success:     `Done: ${args.param1}`,
      error:       `Failed: ${args.param1}`,
    };
  }

  async call(context: {
    env: any;
    parameters: Record<string, any>;
    pushResult: (text: string) => void;
    pushError:  (text: string) => void;
  }): Promise<void> { ... }
}
```

### 5. tools/ Directory

| File | Tools | Count |
|---|---|---|
| `workspace.ts` | `list_workspace_folders`, `read_workspace_file`, `write_workspace_file`, `list_workspace_files`, `glob_workspace`, `grep_workspace`, `insert_workspace_content`, `search_and_replace_workspace`, `apply_diff_workspace`, `execute_workspace_command` | 10 |
| `breakpoints.ts` | `set_breakpoints`, `remove_breakpoints`, `list_breakpoints` | 3 |
| `debugControl.ts` | `step_over`, `step_into`, `step_out`, `continue`, `pause` | 5 |
| `debugConsole.ts` | `evaluate_expression`, `get_variables`, `get_stack_trace`, `get_scopes`, `set_variable`, `get_debug_output` | 6 |
| `debugSession.ts` | `get_active_debug_session`, `list_debug_configurations`, `start_debug_session`, `stop_debug_session` | 4 |
| `terminalConsole.ts` | `list_terminals`, `get_terminal_output`, `search_terminal_output`, `focus_terminal` | 4 |
| `bobExtensions.ts` | `list_extensions` | 1 |
| `universeAnswer.ts` | `universe_answer` | 1 |
| **Total** | | **34** |

---

## Complete Tool Reference (34 Tools)

### Breakpoint Tools (3)
| Tool | Description |
|---|---|
| `set_breakpoints` | Set one or more breakpoints (supports conditions) |
| `remove_breakpoints` | Remove breakpoints by file/line |
| `list_breakpoints` | List all current breakpoints |

### Debug Control Tools (5)
| Tool | Description |
|---|---|
| `step_over` | Step over the current line |
| `step_into` | Step into a function call |
| `step_out` | Step out of the current function |
| `continue` | Continue execution until next breakpoint |
| `pause` | Pause a running debug session |

### Debug Console Tools (6)
| Tool | Description |
|---|---|
| `evaluate_expression` | Evaluate an expression in the debug context |
| `get_variables` | Get variables in the current scope |
| `get_stack_trace` | Get the current call stack |
| `get_scopes` | Get available variable scopes |
| `set_variable` | Set a variable value |
| `get_debug_output` | Get recent debug console output |

### Debug Session Tools (4)
| Tool | Description |
|---|---|
| `get_active_debug_session` | Get info about the current debug session |
| `list_debug_configurations` | List available launch configurations |
| `start_debug_session` | Start a debug session by name |
| `stop_debug_session` | Stop the current debug session |

### Terminal Console Tools (4)
| Tool | Description |
|---|---|
| `list_terminals` | List all open terminals |
| `get_terminal_output` | Get recent output from a terminal |
| `search_terminal_output` | Search terminal output for a pattern |
| `focus_terminal` | Focus a specific terminal |

### Multi-Root Workspace Tools (10)

> **Visibility**: These tools are only active in multi-root VS Code workspaces (2+ root folders).
> They are completely hidden from the LLM in single-root workspaces via the `enabled()` method.

| Tool | Description |
|---|---|
| `list_workspace_folders` | List all root folders - call this first to discover folder names |
| `read_workspace_file` | Read a file in any workspace folder (replaces `read_file` for non-primary folders) |
| `write_workspace_file` | Write/create a file in any workspace folder (replaces `write_file` for non-primary folders) |
| `list_workspace_files` | Browse a directory in any workspace folder (replaces `list_files`) |
| `glob_workspace` | Find files by glob pattern in any workspace folder (replaces `glob`) |
| `grep_workspace` | Search file contents by regex in any workspace folder (replaces `grep`) |
| `insert_workspace_content` | Insert lines at a specific position in a file in any workspace folder (replaces `insert_content`) |
| `search_and_replace_workspace` | Find-and-replace text (literal or regex) in a file in any workspace folder (replaces `search_and_replace`) |
| `apply_diff_workspace` | Apply a SEARCH/REPLACE diff block to a file in any workspace folder using Bob's fuzzy diff engine (replaces `apply_diff`) |
| `execute_workspace_command` | Run a CLI command with its working directory in any workspace folder (replaces `execute_command` for non-primary folders) |

All ten tools accept a `workspace` parameter (the folder `name` from `list_workspace_folders`) and a `path`/`cwd` relative to that folder root. `glob_workspace` and `grep_workspace` also accept an optional `workspace` param — omit it to search all folders at once. All tools except `list_workspace_folders` delegate entirely to the corresponding Bob built-in via `getBobTool`, so output format, error messages, undo tracking, and future improvements are inherited automatically.

### Bob Extensions (1)
| Tool | Description |
|---|---|
| `list_extensions` | List all installed Bob extensions with optional filter by name/ID |

### Easter Egg (1)
| Tool | Description |
|---|---|
| `universe_answer` | Returns 42 |

---

## Development Setup

### Prerequisites
- Node.js 18+
- VSCode with IBM Bob extension installed
- TypeScript

### Installation
```bash
npm install
```

### Build
```bash
npm run compile          # one-shot build
npm run typecheck        # type-check without emitting
npm run lint             # lint src/
npm run lint:fix         # lint and auto-fix
npm run watch            # watch mode (background)
```

### Running the Extension
1. Open this project in VSCode
2. Press `F5` to launch Extension Development Host
3. In the new VSCode window, open a project and start a debug session

---

## Development Workflow

1. Edit source in `src/`
2. `npm run compile` (or watch mode)
3. Press `F5` to open Extension Development Host
4. Open Bob's **Output** channel or the **Developer Tools** console (`Help -> Toggle Developer Tools`) to see `[PowerToys for Bob]` logs

### Key debug log lines to watch for

```
[PowerToys for Bob] Extension activating...
[PowerToys for Bob] taskManager obtained via internal hack
[PowerToys for Bob] webview sendMessage wrapped
[PowerToys for Bob] setCurrentTasks intercepted, tasks: 1
[PowerToys for Bob] Saving last task: <taskId>
[PowerToys for Bob] Restoring last task: <taskId>
[PowerToys for Bob] Successfully registered 34 tools with Bob
```

---

## Adding New Tools

### Step-by-Step Guide

1. **Create tool class** in the appropriate `tools/*.ts` file:

```typescript
class MyNewTool {
  static id = 'my_new_tool';
  groups = ['read']; // or ['edit']
  permission = 'read'; // or 'edit'
  private static readonly PARAMS = [
    {
      name: 'param1',
      required: true,
      type: 'string',
      description: 'Full sentence sent to the LLM in the function schema.',
      detail: 'Short label shown in the approval UI.',
      usage: 'example value',
      // renderHint: 'code' | 'diff' | 'json' | 'text' | 'hidden'
    }
  ];
  parameters = paramsToSchema(MyNewTool.PARAMS);
  getParameters(_env?: any): any[] { return MyNewTool.PARAMS; }

  getId(): string { return MyNewTool.id; }

  // Optional - return false to hide tool from LLM entirely (e.g. wrong workspace type)
  enabled(_env?: any): boolean { return true; }

  getDescription(_env?: any): string {
    return 'Full description shown in the system prompt. Be specific about when to use this tool.';
  }

  getCostEffectiveDescription(): string {
    return 'Brief one-liner for tool selection';
  }

  getLabels(args: Record<string, any>) {
    return {
      displayName: `My Tool: ${args.param1}`,
      running: `Running with ${args.param1}...`,
      success: `Done: ${args.param1}`,
      error: `Failed: ${args.param1}`,
    };
  }

  async call(context: {
    env: any;
    parameters: Record<string, any>;
    pushResult: (text: string) => void;
    pushError: (text: string) => void;
  }): Promise<void> {
    const { param1 } = context.parameters;
    // implementation
    context.pushResult(JSON.stringify({ result: param1 }, null, 2));
  }
}
```

2. **Register it** in the appropriate `register*Tools(source)` function:
```typescript
source.registerTool(new MyNewTool());
```

3. **Update the count** in `extension.ts` and in this document.

### Parameter fields: `description`, `detail`, `usage`, `renderHint`

Bob's pipeline has **two completely separate consumers** of the PARAMS data, each reading different fields:

| Field | Required | Read by | Purpose |
|---|---|---|---|
| `description` | ✅ | `toolToOpenAi()` in extension.js (BobToolRegistry) - LLM function schema | Full sentence describing the parameter, sent to the model. |
| `detail` | ✅ | `getParameterRenderHints()` in extension.js module 25772 (tool parameter utilities) | Short label shown beneath the field value in the approval dialog. |
| `usage` | ⬜ | `getParameterUses()` in extension.js module 25772 (tool parameter utilities) | Example value for autocomplete hints. Special sentinel: `'command'` triggers the **Approve / Reject / Approve for task** dialog. |
| `renderHint` | ⬜ | `getParameterRenderHints()` in extension.js module 25772 (tool parameter utilities) | Controls field rendering: `'code'` (code block), `'diff'` (diff view), `'json'` (JSON viewer), `'text'` (plain text), `'hidden'` (not shown). |

Always define **both** `description` and `detail`. `paramsToSchema()` (see below) mirrors each into the other as a fallback, so a param with only one field still works — but having both gives the best experience.

**`renderHint` is optional per-parameter**, but its presence on at least one parameter in the tool determines whether the approval dialog renders individually or falls back to a raw JSON blob:

- **At least one param has `renderHint`** - formatted view: each param rendered according to its hint; params without a hint get the default `name: value` style.
- **No param has `renderHint`** - entire tool falls back to a single collapsible JSON blob.
- `'hidden'` suppresses a param entirely from the dialog (e.g. `workspace` — already shown in the tool title).
- `usage: 'command'` is **independent** of `renderHint` — it only controls whether the approval dialog fires, not how it looks.

#### Why `parameters` must not be the raw PARAMS array

Bob's source-tool registration pipeline (`Rzn` in the bundle) calls `BobToolRegistry.toolToOpenAi(o)` to produce the OpenAI JSON Schema. That function inspects `o.parameters`:

```
toolToOpenAi(o):
  if (typeof o.parameters === 'object' && !Array.isArray(o.parameters))
    - return o.parameters as-is          ← object passthrough: all fields preserved ✓
  if (Array.isArray(o.parameters))
    - convert: only copies { type, description } per entry  ← usage/detail/renderHint STRIPPED ✗
```

The resulting schema `r` is then registered as `getParameters: () => r`. Bob's UI renderer and approval pipeline **only ever call `registeredTool.getParameters()`**, which returns `r` — your tool's own `getParameters()` method is **never called by Bob**.

If `parameters` is set to the raw array, `usage`, `detail`, and `renderHint` are all stripped, causing:
- The approval dialog to never fire for `permission = 'execute'` tools (missing `usage: 'command'` sentinel).
- Parameters to render as a raw JSON blob instead of individual formatted fields.

#### `paramsToSchema()` in `utils.ts`

`paramsToSchema()` (exported from `src/utils.ts`) converts a PARAMS array into the correct object form, preserving all four fields and mirroring `description`↔`detail` as fallbacks:

```typescript
// src/utils.ts
export function paramsToSchema(params: ReadonlyArray<{
  name: string; type: string;
  description?: string; detail?: string;
  required?: boolean; usage?: string; renderHint?: string;
  [key: string]: unknown;
}>): object
```

Use it for every tool — the pattern is the same across all tool files:

```typescript
private static readonly PARAMS = [
  { name: 'workspace', type: 'string', required: true,
    description: 'Workspace folder name…',  // - LLM schema
    detail:      'Workspace folder name',   // - approval UI label
    usage:       'backend',
    renderHint:  'hidden' },
  { name: 'command', type: 'string', required: true,
    description: 'The CLI command to execute.',
    detail:      'The CLI command to execute',
    usage:       'command',   // ← sentinel: triggers Approve/Reject dialog
    renderHint:  'code' },
];

// Property - read by toolToOpenAi(e).parameters
parameters = paramsToSchema(MyTool.PARAMS);

// Method - read by the newer getParameters(env) paths
getParameters(_env?: any): any[] { return MyTool.PARAMS; }
```

### Conditionally visible tools (`enabled()`)

Use `enabled()` to completely hide a tool from the LLM when it's not applicable:

```typescript
// Only show in multi-root workspaces
enabled(_env?: any): boolean {
  return (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
}
```

Bob evaluates `enabled?.(env) ?? true` at tool-list build time. A tool returning `false` is excluded from the LLM's context entirely - it consumes no tokens and cannot be called.

---

## Troubleshooting

### Workspace proxy tools fail after context compaction (`read_file tool not found`)

Symptom: `read_workspace_file` (and other `*_workspace` tools) return `"read_file tool not found in current task"` after the conversation has been running for a while. The calls complete in 1–3 ms (no I/O — pure lookup failure).

Cause: This happened when `getBobTool` navigated via `taskManager.mainPanelTask` (the sidebar chatManager). Tasks running in editor tabs (`isPanel === true`) have a different chatManager — the sidebar one has no `currentTask` for them. After context compaction the model switches from calling `read_file` directly to calling `read_workspace_file`, which hit this broken lookup path.

Fix (current): `getBobTool` now takes a mandatory `taskId` parameter and routes via `findTaskChatManager(taskManager, taskId)`, which finds the correct chatManager regardless of whether the task is in the sidebar or a tab.

### taskManager is null on startup
`extractTaskManager` can return null if Bob's chat panel hasn't rendered yet when `setChatContent` is called. `registerTaskManager` automatically retries up to 3 times with 1s delays. If it still fails after 3 attempts, the status bar shows an error icon and breakpoint notifications are disabled - but all other tools still work.

### Extension doesn't activate
- Check that IBM Bob (`IBM.bob-code`) is installed and active
- Check Output panel for `[PowerToys for Bob]` errors

### Tools don't appear in Bob
- Verify `registerSource` didn't throw (check Dev Tools console)
- Make sure `source.registerTool` was called for each tool

### Last task not restored
- The save fires when `setCurrentTasks` is intercepted - you must open/switch to a task at least once per session for it to save
- Check Dev Tools console for `setCurrentTasks intercepted` and `Saving last task` log lines

### TypeScript errors
```bash
npm run compile 2>&1
```

---

## Building for Distribution

```bash
npm run compile
npx vsce package
# produces bob-powertoys-x.x.x.vsix
```

Install locally:
```
Extensions panel -> ... -> Install from VSIX
```

---

## Resources

- [VSCode Extension API](https://code.visualstudio.com/api)
- [Debug Adapter Protocol](https://microsoft.github.io/debug-adapter-protocol/)
- [VSCode Extension Samples](https://github.com/microsoft/vscode-extension-samples)

## License

MIT

## Contributing

Contributions welcome! Please:
1. Fork the repository
2. Create feature branch
3. Make changes following style guidelines
4. Add tests if applicable
5. Submit pull request

## Support

For issues and questions:
1. Check existing GitHub issues
2. Review documentation
3. Create new issue with details