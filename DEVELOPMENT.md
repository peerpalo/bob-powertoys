# PowerToys for Bob Development Guide

## Project Structure

```
bob-powertoys/
├── src/
│   ├── extension.ts              # Extension entry point and lifecycle
│   ├── taskManager.ts            # Task commands, last-task persistence
│   ├── debugAdapter.ts           # Centralized debug adapter tracker
│   ├── utils.ts                  # Shared utilities: taskManager access, frame resolution, forceFirstParty
│   ├── mcp/
│   │   ├── share.ts              # Shares MCP sessions across workspace roots (see "MCP session sharing")
│   │   ├── apps.ts               # Experimental MCP Apps host: ui:// views in a side panel (see "MCP Apps host")
│   │   └── appBridge.ts         # Browser bundle for the app panel: official AppBridge + relay (built to out/mcp/appBridge.js)
│   └── tools/                    # Individual tool modules
│       ├── workspace.ts          # Multi-root workspace support: list_workspace_folders + sandbox patch + prompt injection + webview patch
│       ├── videos.ts             # Video frame extraction tools (2 tools)
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

PowerToys does **not** declare `extensionDependencies` — `IBM.bob-code` is Bob-internal and not published on any marketplace, so declaring it as a dependency would break VSIX publishing. Instead, `activate()` calls `bobExtension.activate()` explicitly to ensure Bob is ready before accessing its exports:

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
    └── register 26 tools
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
forceFirstParty(source, EXTENSION_ID);   // see "First-party source override" below
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
- **`forceFirstParty(source, EXTENSION_ID)`** — stock "IBM Bob" builds disable third-party sources, so without it `sourceIsEnabled()` returns false and all tools disappear. See [First-party source override](#first-party-source-override).
- `source.onEntitlementChange` fires when Bob logs in and re-evaluates entitlements — confirmed by testing. It fires even though our source is not a paid addon; Bob's `AddonManager.triggerEntitlementChange()` iterates all enabled sources in the registry.
- `registerSource` and `registerTool` must happen **before** `completeRegisterPowerToys` so that our source is already in the registry (and thus receives `onEntitlementChange`) when Bob later logs in.
- The `fired` guard makes the listener one-shot, preventing duplicate setup if the event fires more than once.
- `source.isEntitled()` reflects **subscription** state, not login state — do not use it as a login gate.
- `vscode.authentication.onDidChangeSessions` was previously used as the retry hook but is incorrect — it is a VS Code-level auth event, not tied to Bob's internal session state.

### First-party source override

Bob's `AddonManager` (`enableSources`) builds the `_disabledSources` list. When `disableThirdParty` is set, every source that is neither an add-on source nor in the registry's `_firstPartySources` Set is added to it, and Bob logs:

```
[AddonManager] Source "bob-powertoys" is registered but disabled because third party extensions are disabled.
```

`disableThirdParty` is `hostName === "IBM Bob"` (`vscode.env.appName`), so it applies to the stock build but not to Insiders (`"IBM Bob - Insiders"`). `sourceIsEnabled()` then returns false for our source and `getEnabledTools()` filters all our tools out.

The only way into `_firstPartySources` is the third argument of the internal `registry.registerSource(id, name, firstParty)`. The public `registerSource(id, name)` wrapper drops it, nothing in Bob reads a `source.firstParty` property, and the registry is not exposed. `forceFirstParty(source, id)` in [`src/utils.ts`](src/utils.ts) therefore does two things:

1. **Remove our id from `_disabledSources`.** `source.isEntitled()` calls `registry.hasEntitlement()`, which does `this._disabledSources.includes(id)`. For that one synchronous call, `Array.prototype.includes` is wrapped to capture the receiver (the live array); our id is spliced out and `includes` is restored in a `finally`.
2. **Keep it out on later changes.** `setDisabledSources()` rebuilds the list on every profile/extension change with `filter(n => !this._firstPartySources.has(n))`. A `Set.prototype.has` override (installed once) returns `true` for our id when the Set also contains `'review'`, a source Bob itself registers as first-party. Other Sets are unaffected.

The warning above is still logged after a successful override: it is emitted from a plain array copy before `setDisabledSources()`, so it cannot be used as a pass/fail signal. Success is logged by the extension as `forceFirstParty: applied` (visible in Developer Tools, since `logger` uses `console.log`).

**Caveats**: this depends on Bob internals (`hasEntitlement` using `.includes`, `'review'` being first-party) and may break silently after a Bob update. It also bypasses an apparently intentional restriction on stock Bob; treat it as unsupported.

### MCP session sharing

Bob's `McpHub` keeps one registry (`workspaceRegistries`, keyed by workspace root) and one `MCPClient` per root. At startup the runtime does `Promise.all(workspaces.map(initWorkspace))`, so every global server in `~/.bob/settings/mcp.json` is started once per folder. `resolveServerConfigForWorkspace` adds `roots: [<this folder>]` and expands `${workspaceFolder}`, so Bob cannot assume two roots run the same server. In a 5-folder workspace a single global OAuth server logs `[mcp-use] info: Authentication required` five times.

[`src/mcpShare.ts`](src/mcpShare.ts) makes roots whose server config is identical share one session. It has to run **before** Bob starts MCP, and that happens during Bob's own activation. The `McpHub` is not reachable that early, so it hooks objects Bob creates per root instead of the hub:

1. **`installMcpShare()`** is the first call in `activate()`, before `bobExtension.activate()`, and only when the workspace has more than one root folder (`isMultiRoot()`). The decision is made once at activation: adding a second folder to a single-folder window needs a window reload before sharing applies. It installs an `Object.prototype` accessor for `startupComplete`. Bob's `startupForWorkspace` assigns `registry.startupComplete = true` right before it creates `registry.client`. The setter turns it back into an ordinary own property, so nothing else is affected. If the object looks like a registry (`serversByKey` is a `Map` and it has a `client` key), `registry.client` gets an accessor so every client Bob assigns is passed to `shareClient(client, registry.scopeRoot)`.
2. **`shareClient()`** replaces `client.createSession(name, false)`, the call Bob makes in `startServerSession`. The key is `name` plus the server config with `roots`, `errlog`, `onElicitation` and `authProvider` removed. The first root registers its pending session synchronously, so roots started in parallel join it instead of connecting. Bob then calls `session.initialize()` and loads tools per root as usual.

Lifecycle of a shared session:
- `initialize()` is memoized, so an auth failure happens once and every root sees the same error.
- The first `disconnect()` from any root unregisters the session so no new root can join it. This keeps "restart server" a real restart. The real `disconnect()` runs when the last holder releases it.
- A failed session is dropped, so the next attempt starts fresh.

Logging (Developer Tools console):
```
MCP share: "carbon-mcp" in C:\src\a starts a new session
MCP share: "carbon-mcp" in C:\src\b reuses the session started by C:\src\a (2 roots share it)
```

**Limits and caveats**
- The server sees only the first root in `roots`. A config with `${workspaceFolder}` resolves differently per root, so it is never shared.
- Elicitation requests go through the first root's handler.
- Depends on Bob internals (registry shape, the `startupComplete` then `client` assignment order, `MCPClient.createSession/getServerConfig/sessions/activeSessions`). If the hook fails, Bob falls back to one session per root.
- **Activation order is the weak point.** Bob activates on `onStartupFinished` and starts MCP inside its own `activate()`. `installMcpShare()` only helps if our extension has activated first, and VS Code gives no ordering guarantee between two extensions on the same event. `activationEvents` lists `workspaceContains:**` (fires when a non-empty workspace opens, before `onStartupFinished`) plus `onStartupFinished` as a fallback. Verified on a multi-root workspace: only one `starts a new session` line per server. That is an observation, not a guarantee. If several `starts a new session` lines ever appear for the same server, we lost the race.
- Tests: [`test/mcpShare.test.ts`](test/mcpShare.test.ts).

---

## MCP Apps host (experimental)

The host side of the [MCP Apps spec](https://github.com/modelcontextprotocol/ext-apps) (SEP-1865, version `2026-01-26`, extension id `io.modelcontextprotocol/ui`) is implemented on top of **the official SDK** plus Bob's MCP plumbing. Bob has no native support (zero `ui://` / `text/html;profile=mcp-app` occurrences in its bundle; its chat webview is a closed React bundle that cannot host iframes).

The protocol layer is **not** hand-rolled: `AppBridge` from `@modelcontextprotocol/ext-apps/app-bridge` (bundled by `esbuild.js` into `out/mcp/appBridge.js`, entry [`src/mcp/appBridge.ts`](src/mcp/appBridge.ts)) runs inside the panel webview and speaks the full MCP Apps wire protocol (`ui/initialize` handshake, `tool-input`/`tool-result` notifications, request routing, teardown, size changes, `ui/download-file`, `sampling/createMessage`, …). It is constructed without an MCP client (`new AppBridge(null, …)`) so every server interaction can be routed through Bob. [`src/mcp/apps.ts`](src/mcp/apps.ts) is the extension-host half: Bob integration + a thin request/response relay (`acquireVsCodeApi()` postMessages tagged `__bobPtBridge`) between the SDK handlers and Bob's tool instances.

### Spec → implementation map

| Spec requirement | Implementation |
|---|---|
| Discovery: tools carry `_meta.ui.resourceUri` (deprecated `_meta["ui/resourceUri"]`) | Bob stores tool definitions verbatim — `tool.getDefinition()` (the `bJ` class in extension.js); `toolUiResourceUri()` reads both formats |
| Render the `ui://` resource (desktop-host path, no sandbox proxy) | `source.onToolWillExecute` detects the call, fetches the resource via Bob's own `read_mcp_resource` tool; the panel document (`buildAppPanelDocument()`) embeds the config and loads the bundled bridge, which creates the sandboxed iframe (`allow-scripts`, null origin, iframe `csp` attribute) |
| View ↔ Host JSON-RPC over postMessage | official `AppBridge` + `PostMessageTransport` (bundled in `out/mcp/appBridge.js`); its handlers (`oncalltool`, `onreadresource`, `onopenlink`, `onmessage`, `onupdatemodelcontext`, …) are relayed to the extension host, which answers by proxying to Bob |
| `ui/notifications/tool-input` after initialize | the bridge reports `initialized`; the extension host replies with a `tool-input` command carrying the arguments captured at `onToolWillExecute` |
| `ui/notifications/tool-result` | `source.onToolDidExecute(env, toolId, args, {…meta, taskId})` → `readLastToolResult()` reads the task's last `role:'tool'` message → `tool-result` command to the bridge |
| Proxy `tools/call` to the originating server, enforce `visibility: ["app"]` | `proxyToolCall()` finds the live `bJ` instance (`mcpInfo.serverName`/`toolName`) in the task's tools and calls `tool.call({env, parameters, pushResult, pushError, setMetadata})` — inheriting Bob's restart + elicitation handling; `callableByApp()` enforces visibility |
| `resources/read` from the View | `callReadMcpResource()` → Bob's `read_mcp_resource` tool (`{server, uri}` parameters), result parsed from the JSON it pushes |
| `ui/open-link` | `vscode.env.openExternal` (https/http only) |
| `ui/message` | best-effort `chatManager.handleInputMessage` via `findTaskChatManager` |
| Host context (theme, display mode, toolInfo) | `ui/initialize` response built from `vscode.window.activeColorTheme`, panel mode, and the tool definition |

### Key Bob internals relied on

- `onToolWillExecute(env, toolId, args)` fires before MCP tool execution and can return `undefined` to let the call proceed — our capture point for tool input.
- `onToolDidExecute(env, toolId, args, meta)` (`handleToolResult` in extension.js) fires with `{...toolMetadata, taskId}` — our capture point for completion.
- MCP results are flattened by `runToolWithRestart`: `[...textItems, JSON.stringify(structuredContent)].join('  ')` — `extractStructuredContent()` recovers the structured payload by scanning double-space boundaries from the end.
- `read_mcp_resource` pushes `JSON.stringify({contents: [{uri, mimeType, text}]})` — the resource HTML is cleanly parseable, but the contents' `_meta` (CSP domains) is dropped.

### Known limitations / TODOs

- **Capability negotiation**: Bob's MCP client does not advertise `io.modelcontextprotocol/ui` during initialize, so strictly conforming servers may omit `_meta.ui`. Servers that always include it (most of the current ecosystem) work. A fix would require patching the session initialize request.
- **CSP**: the app iframe uses a permissive default CSP because the resource `_meta.ui.csp` is dropped by `read_mcp_resource`. Phase 2: read resources directly on the MCP session (needs session access like mcpShare's) to preserve `_meta`.
- **`visibility: ["app"]` tools are not hidden from the model** (Bob does not filter them) — we enforce visibility only for View-initiated calls.
- `ui/update-model-context` is stored but not yet surfaced to the model in the next turn.
- `ui/notifications/tool-input-partial` and `tool-cancelled` are not sent.
- One panel per `(taskId, toolId)`; a repeated call replaces the previous panel.

Gated on `bob-powertoys.mcpApps.enabled` (default `false`, read at call time — inert unless an Apps server is configured). Tests: [`test/mcp/apps.test.ts`](test/mcp/apps.test.ts).

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

`taskId` (`context.env.id`) is **mandatory** so the lookup is always routed to the exact chatManager running the current task — sidebar or editor tab (`findTaskChatManager` checks both active and backgrounded states; routing via `taskManager.mainPanelTask` instead returns the sidebar chatManager, which has no `currentTask` for tab-based tasks).

Bob stores all active tools in a plain array on the `Task` object. `getBobTool` finds the entry whose `.id` matches `toolId` and returns it, or `null` if the task manager is not ready, the task is not found, or the tool is not present in the current mode.

**Currently unused — kept as a utility.** It is the documented way to reach Bob's live built-in tool instances, e.g. to delegate a call with a patched `env` (`tool.call({ ...context, env: { ...context.env, workspace: otherRoot } })`) as the former `*_workspace` proxy tools did. Note that Bob wraps registered tools with a closure that rebuilds `env` from the live task, so the patched-env trick only works for **built-in** tools, not for tools registered from an extension source.

---

## registerWebviewOpenFilePatch — click-to-open for secondary folders

Bob's webview handler resolves relative paths in `openFile` messages against the primary workspace root, so clicks on secondary-folder file mentions open the wrong file.

`registerWebviewOpenFilePatch()` in [`src/tools/workspace.ts`](src/tools/workspace.ts) wraps the `openFile` handler on every webview (current and future, via `cm.ui.setWebview` and the `_chatManagers.push` intercept) and rewrites `./<folderName>/...` paths to their absolute location (`resolveOpenFilePath` from `src/utils.ts`) before Bob's own handler sees them.

### Data flow — inbound (click-to-open)

```
user clicks a path link in the chat UI
  └─► webview ct() prepends "./" to relative paths
        └─► acquireVsCodeApi().postMessage({ type: "openFile", filePath })
              └─► aM.onMessage handler → resolveOpenFilePath(filePath, folders)
                    └─► Bob's kH() resolver → vscode.open
```

Bob's `kH()` resolver always joins against the primary workspace root, so clicks on secondary-folder paths open the wrong file. `wrapHandler` intercepts the `openFile` message and calls `resolveOpenFilePath` to correct the path before Bob's handler fires.

### Patch strategy

1. **`patchView(view)`** — wraps `view.onMessage` on a single `aM` (webview) instance so the `openFile` handler is replaced with `wrapHandler(originalHandler)`.
2. **`patchChatManager(cm)`** — runs `patchView` on any view already assigned to `cm.ui`, then wraps `cm.ui.setWebview()` so every future view assignment is also patched immediately.
3. **`_chatManagers.push` intercept** — catches chatManagers created after extension activation.

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
| `isMultiRoot()` | Same gate as the sandbox patch and `list_workspace_folders`. Injection is only meaningful in multi-root workspaces. Evaluated on every `onTurnStart`, so adding a folder takes effect on the next turn. |
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

## Multi-root Sandbox Patch

### Problem

Bob decides whether a tool call works "outside the workspace" before every call (`sCr()` in `extension.js`):

1. It builds the tool's parameter schema via **`tool.getParameters(env)`** and collects the values of every parameter tagged `usage: "filePath"` (`read_file` / `write_file` / `list_files` / `glob` / `grep` / `insert_content` / `search_and_replace` / `apply_diff` tag `path`; `execute_command` tags `cwd`).
2. Each value is resolved against **`env.workspace` — always the PRIMARY workspace root** (`wi()` prefix check, with `~/.bob` and the terminal-history tmp dir as exceptions).
3. Any path under a secondary folder is flagged `isOutsideWorkspace: true`.

That flag then drives Bob's approval pipeline:

| State | Behaviour |
|---|---|
| `outsideWorkspaceAllowed` **OFF** | `validateToolExecution()` hard-blocks the call: *"Tools are blocked from working outside of the current workspace…"* |
| `outsideWorkspaceAllowed` **ON** | Sandbox passes, but `requiresExplicitApproval()` still demands a prompt unless the per-group `permissionOptions[].enableOutsideWorkspace` flag (the newer *auto-approve reading files outside workspace* setting) is on. |

A secondary workspace folder is part of the workspace the user opened — neither state is correct for it. And since our `source.onToolWillExecute` hook fires **before** the sandbox check but can only *cancel* a call (it cannot suppress the prompt), the only way to make built-ins prompt-free on secondary folders is to stop Bob from tagging those calls in the first place.

### Solution

[`src/tools/workspace.ts`](src/tools/workspace.ts) (multi-root sandbox patch) makes Bob's own check workspace-aware with two prototype wraps, installed lazily from `source.onTurnStart` (the turn's task and its tools exist by then, and the wraps are in place before the turn's first tool call):

1. **`Task.recordToolCallArguments(toolCall)`** — called synchronously at the start of every tool call, *before* `sCr()` runs — is wrapped to stash the call's arguments keyed by task id (`env.id`).
2. **The built-in file tools' `getParameters(env)`** is wrapped: when every `filePath`-tagged argument of the pending call resolves inside one of the workspace folders (and none inside `~/.bob`), the `usage: "filePath"` tag is dropped from the returned descriptors for that call. `sCr()` then sees no file paths, computes `isOutsideWorkspace: false`, and the call behaves exactly like a primary-folder path: **no block, no prompt, Bob's flags irrelevant**. Paths genuinely outside every folder keep their tags, so Bob's native behavior (block / prompt / auto-approve per the user's flags) is unchanged.

A third wrap on the same tools' **`call()`** rewrites `folderName/...`-style relative paths to absolute paths inside that folder — but only when the path does not exist under the primary root *and* the rewritten path exists on disk, and only for native calls (`env.workspace` = primary root). This lets the model address secondary folders naturally, e.g. `read_file("backend/src/app.ts")`.

The symbol tools (`FindSymbol` / `FindReferencingSymbols`) get the same `call()` wrap for their path parameters (`filter_path` / `relative_path`) — plus, when a path resolves inside a secondary folder, the forwarded context's **`env.workspace` is scoped to that folder**, because those tools hardwire the workspace root for the language-server query and path resolution. Their parameters are not `filePath`-tagged, so they need no `getParameters` wrap.

Both wraps are generic (they resolve `this.id` at call time), so one prototype wrap per tool class covers every past and future instance; re-running on later turns catches tools exposed by modes that were not active earlier. Wrappers are tagged (`__bobPtSandboxPatch`) and installs are idempotent.

### Decision logic

The pure functions `shouldStripFilePathUsage(params, args, env, folders)`, `resolveLikeBob()`, `isInsideDir()` and `rewriteSecondaryRelativePath()` are exported for testability (see [`test/workspace-sandbox.test.ts`](test/workspace-sandbox.test.ts)):

- Paths resolve exactly like Bob's `vs()`: a leading `~` expands to the home directory, then `path.resolve(env.workspace, value)`.
- The strip only fires when **every** provided `filePath` value is inside a workspace folder; any genuinely-outside value keeps the whole call native.
- Paths inside `~/.bob` never strip, so Bob's `isBobHomeWrite` protection stays intact.
- Directory containment is case-insensitive on Windows and requires `fsPath + path.sep` prefix (no `/src/backend` vs `/src/backend-v2` collisions).

### Gating

All wraps check `isMultiRoot()` **at call time**, so adding a folder takes effect on the next turn with no reload. In single-root workspaces the wraps are pass-through and Bob behaves exactly as stock.

### Caveats

- Mode `fileRegex` restrictions and the `isBobHomeWrite` flag are driven by the same `filePath`-tagged values; while a strip is active for a call, those checks see no paths. Home-write is protected explicitly (see above); mode file-regex restrictions are skipped for in-workspace secondary-folder paths (niche, accepted).
- Depends on Bob internals: `recordToolCallArguments` on the Task prototype, class-method `getParameters` on the built-in tools, `env.id` being the task id. If the shapes change, the wraps are never installed (or become pass-through) and Bob falls back to its native single-root behavior — logged as a warning.

The install path is covered by [`test/workspace-gating.test.ts`](test/workspace-gating.test.ts), which drives the captured `onTurnStart` callback against fake task/tool classes and verifies both the strip (active) and the pass-through (area off).

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

### Tool area settings (`bob-powertoys.tools.*`)

Enable or disable entire groups of tools. All default to `true`. Changes take effect on the next Bob turn — no restart required.

| Setting | Controls |
|---|---|
| `bob-powertoys.tools.debug.enabled` | All 18 debug and breakpoint tools |
| `bob-powertoys.tools.debug.breakpointNotifications` | Breakpoint hit notification mode (`disabled`, `bobOnly`, `all`) |
| `bob-powertoys.tools.terminal.enabled` | 4 terminal tools |
| `bob-powertoys.tools.video.enabled` | `read_video_file` (multi-root native: resolves secondary-folder paths itself) |
| `bob-powertoys.tools.extensions.enabled` | `list_extensions` |

Read at call time via `isAreaEnabled(area)` in each tool's `enabled()` method — no registration-time gating, so no restart is needed.

### bob-powertoys.tools.debug.breakpointNotifications

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
- `activate(context)` - entry point; registers status bar, waits for Bob, calls `registerTaskCommands`; registers `onDidChangeConfiguration` listener that logs area enable/disable changes
- `registerPowerToys(context, bobExports)` - phase 1: wraps `source.registerTool` to collect all tool instances into `registeredTools[]`, calls `registerSource` then all `registerXxxTools`; always succeeds regardless of login state
- `completeRegisterPowerToys(context, bobExports, source)` - phase 2: calls `registerTaskManager`, `registerTaskPersistence`, `restoreTasks`, debug adapter tracker; retries via `source.onEntitlementChange` if Bob is not yet logged in
- `showStatus()` - displays active tool count (computed live from `registeredTools` via `enabled()`) and disabled areas
- `showStatusBarError()` - status bar error state

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
forceFirstParty(source: any, id: string): boolean   // re-enables our source on stock Bob (see First-party source override)
registerTaskManager(bobExports: any): Promise<void> // resolves + caches, with retries
getTaskManager(): any                               // returns cached instance
findTaskChatManager(taskManager, taskId): any|null  // active + backgrounded lookup
getBobTool(taskId: string, toolId: string): any | null  // resolves a Bob built-in tool for the given task (context.env.id); currently unused, kept as a utility
resolveFrameId(frameId, resolveTopFrame): Promise<number|undefined>
normaliseWorkspacePath(filePath: string): string    // normalises user-supplied relative paths for vscode.Uri.joinPath
resolveOpenFilePath(filePath, folders): string      // resolves ./folderName/... webview click paths to absolute
isAreaEnabled(area: string): boolean                // reads bob-powertoys.tools.{area}.enabled from VS Code config; default true
```

### 4. Bob's Tool Interface

Each tool implements:

```typescript
class MyTool {
  static id = 'my_tool';
  groups = ['read'];       // or ['edit'] / ['execute']
  permission = 'read';     // or 'edit' / 'execute'

  getId(): string { return MyTool.id; }
  enabled(_env?: any): boolean { return true; }  // optional: hide tool when false; called by Bob on every turn
                                                  // use isAreaEnabled('Area') to gate on a config setting
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

| File | Tools | Count | Area setting |
|---|---|---|---|
| `workspace.ts` | `list_workspace_folders` | 1 | `isMultiRoot()` |
| `videos.ts` | `read_video_file` | 1 | `bob-powertoys.tools.video.enabled` |
| `breakpoints.ts` | `set_breakpoints`, `remove_breakpoints`, `list_breakpoints` | 3 | `bob-powertoys.tools.debug.enabled` |
| `debugControl.ts` | `step_over`, `step_into`, `step_out`, `continue`, `pause` | 5 | `bob-powertoys.tools.debug.enabled` |
| `debugConsole.ts` | `evaluate_expression`, `get_variables`, `get_stack_trace`, `get_scopes`, `set_variable`, `get_debug_output` | 6 | `bob-powertoys.tools.debug.enabled` |
| `debugSession.ts` | `get_active_debug_session`, `list_debug_configurations`, `start_debug_session`, `stop_debug_session` | 4 | `bob-powertoys.tools.debug.enabled` |
| `terminalConsole.ts` | `list_terminals`, `get_terminal_output`, `search_terminal_output`, `focus_terminal` | 4 | `bob-powertoys.tools.terminal.enabled` |
| `bobExtensions.ts` | `list_extensions` | 1 | `bob-powertoys.tools.extensions.enabled` |
| `universeAnswer.ts` | `universe_answer` | 1 | always on |
| **Total** | | **26** | 25 active in single-root, 26 in multi-root |

---

## Complete Tool Reference (26 Tools)

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

### Multi-Root Workspace Tools (1)

> **Visibility**: These tools are only active in multi-root VS Code workspaces (2+ root folders).
> They are completely hidden from the LLM in single-root workspaces via the `enabled()` method.
> The built-in file tools also work on every workspace folder natively — see [Multi-root Sandbox Patch](#multi-root-sandbox-patch).

| Tool | Description |
|---|---|
| `list_workspace_folders` | List all root folders - call this first to discover folder names |
The built-in tools (including `FindSymbol` / `FindReferencingSymbols` via the sandbox patch's `call()` rewrite and `env.workspace` scoping) handle secondary folders natively — see [Multi-root Sandbox Patch](#multi-root-sandbox-patch).

### Video Analysis Tools (1)
| Tool | Description |
|---|---|
| `read_video_file` | Extract frames from a video file using ffmpeg for visual analysis. Evenly-spaced by default; supports custom `-vf` filters and `-ss` seek. Works on every workspace folder (absolute path, or relative path starting with a secondary folder name). Requires ffmpeg on PATH. |

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
[PowerToys for Bob] Successfully registered 36 tools with Bob
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