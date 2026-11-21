/**
 * MCP Apps support for Bob — host integration on top of the official SDK.
 *
 * Bob has no native support for MCP Apps (SEP-1865, spec 2026-01-26,
 * extension id `io.modelcontextprotocol/ui`): zero occurrences of the
 * `ui://` scheme or `text/html;profile=mcp-app` in its bundle, and its chat
 * webview is a closed React bundle that cannot host interactive iframes.
 *
 * Architecture:
 *
 *   ┌────────────────────────── WebviewPanel (ours) ─────────────────────────┐
 *   │  out/mcp/appBridge.js — official `AppBridge` from                       │
 *   │  @modelcontextprotocol/ext-apps/app-bridge (bundled by esbuild.js,      │
 *   │  runs WITHOUT an MCP client) + sandboxed View iframe (srcdoc = the      │
 *   │  ui:// resource HTML, desktop-host path of the spec)                    │
 *   └───────────────▲───────────────────────────────────┬─────────────────────┘
 *                   │ acquireVsCodeApi() relay           │ PostMessageTransport
 *                   │ (request/response/command/notify)  │ (JSON-RPC 2.0)
 *   ┌───────────────┴───────────────────────────────────▼─────────────────────┐
 *   │  this module (extension host) — Bob integration:                        │
 *   │   - discovery: tool.getDefinition()._meta.ui.resourceUri (bJ class)     │
 *   │   - capture: source.onToolWillExecute (args) / onToolDidExecute (done)  │
 *   │   - resources: Bob's read_mcp_resource / list_mcp_resources tools       │
 *   │   - tools/call proxy: live bJ instances via tool.call() (restart +      │
 *   │     elicitation handling inherited), visibility: ["app"] enforced       │
 *   │   - ui/message → chatManager.handleInputMessage                          │
 *   └──────────────────────────────────────────────────────────────────────────┘
 *
 * Ordering note: the tool call and the View bootstrap (resource read, panel
 * creation, iframe load, initialize handshake) run concurrently, and the tool
 * usually finishes first. Tool results that arrive before the View sends
 * `initialized` are therefore buffered in `pendingResults` and flushed right
 * after `tool-input` (spec order: tool-input, then tool-result).
 *
 * Known limitations (see DEVELOPMENT.md "MCP Apps host"):
 * - Bob does not negotiate the `io.modelcontextprotocol/ui` extension with
 *   servers, so strictly conforming servers may hide their UI metadata.
 * - `read_mcp_resource` drops the resource `_meta` (CSP domains), so the
 *   View iframe gets a permissive default CSP instead of the declared one.
 * - Tool results reach us through Bob's flattened text, so
 *   `structuredContent` is recovered heuristically (and may be lost if Bob
 *   truncates the stored tool message).
 * - Tools with `visibility: ["app"]` remain visible to the model (Bob does
 *   not filter them); we do enforce visibility for View-initiated calls.
 * - `ui/download-file` is not supported yet.
 */

import * as vscode from 'vscode';
import { getTaskManager, findTaskChatManager, getBobTool, logger } from '../utils.js';

/** Sandbox attribute for the View iframe (desktop-host path, null origin). */
const VIEW_IFRAME_SANDBOX = 'allow-scripts allow-forms allow-popups allow-modals';

/**
 * CSP for the View iframe. TODO(phase 2): derive from the resource's
 * `ui.csp` metadata once we can read `_meta` (needs direct session access —
 * Bob's read_mcp_resource drops it).
 */
const VIEW_IFRAME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https:",
  "style-src 'unsafe-inline' https: data:",
  'img-src https: data: blob:',
  'font-src https: data:',
  'media-src https: data: blob:',
  'connect-src https: wss:',
  'frame-src https:',
  "object-src 'none'",
  "base-uri 'self'",
].join('; ');

/** How many times / how often to look for the tool message in the chat history. */
const RESULT_LOOKUP_ATTEMPTS = 10;
const RESULT_LOOKUP_DELAY_MS = 100;

/** True when the MCP Apps host is enabled (read at call time). */
export function mcpAppsEnabled(): boolean {
  return vscode.workspace.getConfiguration('bob-powertoys').get<boolean>('mcpApps.enabled', false);
}

// ─── Pure helpers (exported for tests) ────────────────────────────────────────

interface McpToolDefinition {
  name?: string;
  description?: string;
  inputSchema?: unknown;
  _meta?: {
    ui?: { resourceUri?: string; visibility?: Array<'model' | 'app'> };
    'ui/resourceUri'?: string;  // deprecated pre-GA format
  };
}

/** Extract the `ui://` resource URI from an MCP tool definition, if any. */
export function toolUiResourceUri(definition: unknown): string | undefined {
  const def = definition as McpToolDefinition | undefined;
  const uri = def?._meta?.ui?.resourceUri ?? def?._meta?.['ui/resourceUri'];
  return typeof uri === 'string' && uri.startsWith('ui://') ? uri : undefined;
}

/** True when the tool may be called by the View (spec: visibility "app"). */
export function callableByApp(definition: unknown): boolean {
  const def = definition as McpToolDefinition | undefined;
  const visibility = def?._meta?.ui?.visibility;
  return !visibility || visibility.includes('app');
}

/**
 * Recover `structuredContent` from Bob's flattened MCP tool result text.
 *
 * `runToolWithRestart` pushes `[...textItems, JSON.stringify(structuredContent)]
 * .join('  ')` — so when structured content exists it is the LAST content
 * entry: a double-space-separated trailing JSON value. We scan the
 * double-space boundaries from the end and return the first suffix that
 * parses as a JSON object or array.
 */
export function extractStructuredContent(flattened: string): unknown {
  if (typeof flattened !== 'string') { return undefined; }
  let idx = flattened.length;
  while ((idx = flattened.lastIndexOf('  ', idx - 1)) !== -1) {
    const candidate = flattened.slice(idx + 2);
    if (!candidate.startsWith('{') && !candidate.startsWith('[')) { continue; }
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') { return parsed; }
    } catch { /* not JSON — keep scanning */ }
  }
  return undefined;
}

/** JSON-stringify with `</script` escaped so the value can be inlined in HTML. */
function jsonForHtml(value: unknown): string {
  return JSON.stringify(value).replace(/<\//g, '<\\/');
}

/** Escape a string for safe use inside an HTML attribute or <title>. */
function escapeHtmlAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** Configuration embedded in the panel document for appBridge.ts. */
export interface BridgeConfig {
  appHtml: string;
  hostInfo: { name: string; version: string };
  capabilities: Record<string, unknown>;
  hostContext: Record<string, unknown>;
  sandbox: string;
  csp: string;
}

/**
 * Build the WebviewPanel document that hosts one MCP App View.
 *
 * The document embeds `window.__MCP_APPS_CONFIG` and loads the bundled
 * official AppBridge (`out/mcp/appBridge.js`, resolved via
 * `webview.asWebviewUri()` by the caller). Everything protocol-related is
 * handled by the SDK; this document only bootstraps it.
 */
export function buildAppPanelDocument(config: BridgeConfig, bridgeScriptSrc: string, title: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtmlAttr(title)}</title>
<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttr(VIEW_IFRAME_CSP)}">
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: var(--vscode-editor-background, #fff); }
</style>
</head>
<body>
<script>window.__MCP_APPS_CONFIG = ${jsonForHtml(config)};</script>
<script src="${escapeHtmlAttr(bridgeScriptSrc)}"></script>
</body>
</html>`;
}

// ─── App state ────────────────────────────────────────────────────────────────

interface McpApp {
  /** Task the tool call belongs to (env.id from onToolWillExecute). */
  taskId: string;
  /** Live task env — forwarded to Bob's MCP tools when proxying calls. */
  env: any;
  /** MCP tool id (`mcp__<server>__<tool>`). */
  toolId: string;
  serverName: string;
  toolName: string;
  definition: any;
  resourceUri: string;
  /** Tool call arguments — sent to the View as tool-input. */
  args: Record<string, any>;
  /** The hosting panel. */
  panel: vscode.WebviewPanel;
  /** View completed the initialize handshake (tool-input was sent). */
  viewReady: boolean;
  /** Last ui/update-model-context payload (not yet surfaced to the model). */
  modelContext: unknown;
}

/** taskId:toolId → app. */
const activeApps = new Map<string, McpApp>();

/**
 * taskId:toolId → tool-result params that arrived before the View was ready.
 * Flushed on the View's `initialized` notification, right after tool-input.
 */
const pendingResults = new Map<string, { content: unknown[]; structuredContent?: unknown }>();

function appKey(taskId: string, toolId: string): string {
  return `${taskId}:${toolId}`;
}

/** JSON.stringify for logging: never throws, truncated to `max` chars. */
function safeJson(value: unknown, max = 300): string {
  try {
    const s = JSON.stringify(value);
    if (s === undefined) { return String(value); }
    return s.length > max ? `${s.slice(0, max)}… (${s.length} chars)` : s;
  } catch {
    return String(value);
  }
}

/** Tool arguments may arrive as an object or as a raw JSON string. */
function normalizeArgs(args: unknown): Record<string, any> {
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return args && typeof args === 'object' ? (args as Record<string, any>) : {};
}

// ─── Registration ─────────────────────────────────────────────────────────────

/**
 * Register the MCP Apps host hooks:
 *   - onToolWillExecute: detect UI-decorated tool calls, fetch the ui://
 *     resource and open the app panel (the tool itself runs normally).
 *   - onToolDidExecute: deliver the tool result to the View (buffered until
 *     the View is initialized).
 *
 * @param extensionUri  Needed to resolve the bundled bridge script.
 */
export function registerMcpApps(source: any, extensionUri: vscode.Uri): void {
  source.onToolWillExecute((env: any, toolId: string, args: Record<string, any>) => {
    if (!mcpAppsEnabled()) { return; }
    // A new call of the same tool supersedes any stale buffered result.
    pendingResults.delete(appKey(env?.id, toolId));
    if (toolId.startsWith('mcp__')) {
      logger.log(`MCP Apps: will-execute ${toolId} args=${safeJson(args, 500)}`);
    }
    maybeOpenApp(env, toolId, args, extensionUri).catch((e) => {
      logger.warn('MCP Apps: failed to handle tool call', e);
    });
    // Always return undefined so the tool call proceeds normally.
  });

  source.onToolDidExecute((env: any, toolId: string, _args: Record<string, any>, meta: any) => {
    if (!mcpAppsEnabled()) { return; }
    deliverToolResult(env, toolId, meta).catch((e) => {
      logger.warn('MCP Apps: failed to deliver tool result', e);
    });
  });
}

/** Open an app panel when the called tool declares a ui:// resource. */
async function maybeOpenApp(env: any, toolId: string, args: Record<string, any>, extensionUri: vscode.Uri): Promise<void> {
  const tool = getBobTool(env?.id, toolId);
  if (!tool || tool.definer !== 'mcp') { return; }

  const definition = tool.getDefinition?.();
  const resourceUri = toolUiResourceUri(definition);
  if (!resourceUri) { return; }

  const serverName = tool.serverName ?? tool.mcpInfo?.serverName;
  const toolName = tool.toolName ?? tool.mcpInfo?.toolName ?? toolId;
  if (!serverName) { return; }

  // Fetch the ui:// resource through Bob's own read_mcp_resource tool so we
  // inherit its session restart handling. The result is
  // JSON.stringify({ contents: [{ uri, mimeType, text }] }).
  const resource = await callReadMcpResource(env, serverName, resourceUri);
  const content = resource?.contents?.find((c: any) => typeof c?.text === 'string');
  if (!content || typeof content.mimeType !== 'string' || !content.mimeType.startsWith('text/html')) {
    logger.warn(`MCP Apps: resource ${resourceUri} on "${serverName}" is not an HTML app (${content?.mimeType ?? 'no content'})`);
    return;
  }

  openAppPanel({
    taskId: env.id,
    env,
    toolId,
    serverName,
    toolName,
    definition,
    resourceUri,
    args: normalizeArgs(args),
    panel: undefined as any,
    viewReady: false,
    modelContext: undefined,
  }, content.text as string, extensionUri);
}

/** Create (or replace) the panel hosting an app and wire the bridge relay. */
function openAppPanel(app: McpApp, appHtml: string, extensionUri: vscode.Uri): void {
  const key = appKey(app.taskId, app.toolId);
  const existing = activeApps.get(key);
  if (existing) { existing.panel.dispose(); }

  const title = `MCP App: ${app.toolName}`;
  const panel = vscode.window.createWebviewPanel(
    'bobPowerToysMcpApp',
    title,
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'out')] },
  );

  const config: BridgeConfig = {
    appHtml: appHtml as string,
    hostInfo: { name: 'bob-powertoys', version: '0.1.0' },
    capabilities: {
      serverTools: {},
      serverResources: {},
      logging: {},
      openLinks: {},
    },
    hostContext: {
      theme: vscode.window.activeColorTheme?.kind === vscode.ColorThemeKind.Light ? 'light' : 'dark',
      displayMode: 'inline',
      platform: 'desktop',
      locale: vscode.env.language,
      toolInfo: { tool: app.definition },
    },
    sandbox: VIEW_IFRAME_SANDBOX,
    csp: VIEW_IFRAME_CSP,
  };
  const bridgeScript = panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', 'mcp', 'appBridge.js'));
  panel.webview.html = buildAppPanelDocument(config, bridgeScript.toString(), title);

  app.panel = panel;
  activeApps.set(key, app);

  panel.webview.onDidReceiveMessage((data: any) => {
    if (!data || data.__bobPtBridge !== true) { return; }
    try {
      if (data.kind === 'request') {
        handleRelayRequest(app, data.method, data.params).then(
          (result) => postToBridge(app, { __bobPtBridge: true, kind: 'response', id: data.id, result }),
          (err) => postToBridge(app, {
            __bobPtBridge: true, kind: 'response', id: data.id,
            error: String((err as any)?.message ?? err),
          }),
        );
      } else if (data.kind === 'notify') {
        handleRelayNotify(app, data.method, data.params);
      }
    } catch (e) {
      if (data.kind === 'request') {
        postToBridge(app, { __bobPtBridge: true, kind: 'response', id: data.id, error: String(e) });
      }
    }
  });

  panel.onDidDispose(() => {
    if (activeApps.get(key) === app) {
      activeApps.delete(key);
      pendingResults.delete(key);
    }
  });

  logger.log(`MCP Apps: opened "${app.toolName}" from server "${app.serverName}" (${app.resourceUri}, ${appHtml.length} chars)`);
}

/** Send a relay message to the bridge inside the panel webview. */
function postToBridge(app: McpApp, message: unknown): void {
  try {
    void app.panel?.webview.postMessage(message);
  } catch { /* panel disposed */ }
}

// ─── Bridge relay: webview (AppBridge handlers) → extension host ──────────────

async function handleRelayRequest(app: McpApp, method: string, params: any): Promise<any> {
  switch (method) {
    case 'tools/call':
      return proxyToolCall(app, params?.name, params?.arguments ?? {});

    case 'resources/read': {
      if (typeof params?.uri !== 'string') { throw new Error('uri is required'); }
      return callReadMcpResource(app.env, app.serverName, params.uri);
    }

    case 'resources/list':
      return callResourceListTool(app.env, 'list_mcp_resources');

    case 'resources/templates/list':
      return callResourceListTool(app.env, 'list_mcp_resource_templates');

    case 'open-link': {
      const url = params?.url;
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) { throw new Error('Invalid URL'); }
      await vscode.env.openExternal(vscode.Uri.parse(url));
      return {};
    }

    case 'message': {
      const text = params?.content?.text;
      if (typeof text !== 'string') { throw new Error('Invalid message format'); }
      return trySendToChat(app, text) ? {} : Promise.reject(new Error('Message sending denied'));
    }

    case 'update-model-context':
      app.modelContext = params;
      return {};

    case 'download-file':
      throw new Error('File downloads are not supported by this host yet');

    default:
      throw new Error(`Unsupported bridge method: ${method}`);
  }
}

function handleRelayNotify(app: McpApp, method: string, params: any): void {
  switch (method) {
    case 'initialized': {
      // Spec: tool-input is sent exactly once, after the initialize handshake,
      // followed by tool-result once the tool call has completed.
      app.viewReady = true;
      logger.log(`MCP Apps (${app.toolName}): View initialized, sending tool-input`, {
        keys: Object.keys(app.args),
        preview: safeJson(app.args, 300),
      });
      postToBridge(app, { __bobPtBridge: true, kind: 'command', cmd: 'tool-input', params: { arguments: app.args } });

      // The tool usually finishes before the View is ready: flush the buffered result.
      const key = appKey(app.taskId, app.toolId);
      const pending = pendingResults.get(key);
      if (pending) {
        pendingResults.delete(key);
        logger.log(`MCP Apps (${app.toolName}): flushing buffered tool-result`);
        postToBridge(app, { __bobPtBridge: true, kind: 'command', cmd: 'tool-result', params: pending });
      }
      break;
    }

    case 'log':
      logger.log(`MCP Apps (${app.toolName}):`, params ?? '');
      break;

    default:
      break;
  }
}

// ─── Host → View: tool result delivery ────────────────────────────────────────

/**
 * Deliver the completed tool call's result to the View as tool-result.
 *
 * If the View is not ready yet (or the panel has not even been created, since
 * the ui:// resource is still being fetched) the result is buffered and sent
 * when the View reports `initialized`.
 */
async function deliverToolResult(env: any, toolId: string, meta: any): Promise<void> {
  const taskId = meta?.taskId ?? env?.id;
  const key = appKey(taskId, toolId);

  // Only tools that declare a ui:// resource are relevant (avoid buffering everything).
  const definition = getBobTool(taskId, toolId)?.getDefinition?.();
  if (!toolUiResourceUri(definition)) { return; }

  // The tool message may not be in the chat history yet when the hook fires.
  let text: string | undefined;
  for (let attempt = 0; attempt < RESULT_LOOKUP_ATTEMPTS; attempt++) {
    text = readLastToolResult(taskId, toolId);
    if (text !== undefined) { break; }
    await new Promise((resolve) => setTimeout(resolve, RESULT_LOOKUP_DELAY_MS));
  }
  if (text === undefined) {
    logger.warn(`MCP Apps: no tool result found in chat history for ${key}`);
    return;
  }

  const structuredContent = extractStructuredContent(text);
  logger.log(
    `MCP Apps: tool result for ${key}: ${text.length} chars, ` +
    `structuredContent ${structuredContent !== undefined ? 'recovered' : 'NOT recovered'}, ` +
    `text=${safeJson(text, 300)}`,
  );

  const params = {
    content: [{ type: 'text', text }],
    ...(structuredContent !== undefined && { structuredContent }),
  };

  const app = activeApps.get(key);
  if (app?.viewReady) {
    postToBridge(app, { __bobPtBridge: true, kind: 'command', cmd: 'tool-result', params });
  } else {
    pendingResults.set(key, params);
  }
}

/**
 * Read the result text of the last tool message for `toolId` on a task.
 * Bob flattens MCP results to text (see module header), so this is the same
 * string the model sees.
 */
function readLastToolResult(taskId: string, toolId: string): string | undefined {
  const tm = getTaskManager();
  const cm = tm ? findTaskChatManager(tm, taskId) : null;
  const messages = cm?.currentTask?.getMessages?.() ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'tool' && m?.toolUsage?.signature?.name === toolId && typeof m.content === 'string') {
      return m.content;
    }
  }
  return undefined;
}

// ─── Server proxying through Bob's MCP tools ──────────────────────────────────

/**
 * Call Bob's built-in `read_mcp_resource` tool. Returns the parsed JSON
 * result (`{ contents: [...] }`) or undefined on failure.
 */
async function callReadMcpResource(env: any, serverName: string, uri: string): Promise<any> {
  const tool = getBobTool(env?.id, 'read_mcp_resource');
  if (!tool) {
    logger.warn('MCP Apps: read_mcp_resource tool not found in current task');
    return undefined;
  }
  return callToolForJson(tool, env, { server: serverName, uri });
}

/**
 * Call Bob's `list_mcp_resources` / `list_mcp_resource_templates` tools
 * scoped to the app's server. Returns the parsed JSON result.
 */
async function callResourceListTool(env: any, toolId: 'list_mcp_resources' | 'list_mcp_resource_templates'): Promise<any> {
  const tool = getBobTool(env?.id, toolId);
  if (!tool) { throw new Error(`${toolId} tool not found in current task`); }
  return (await callToolForJson(tool, env, {})) ?? { resources: [] };
}

/** Call a Bob MCP tool whose result is JSON, collecting and parsing it. */
async function callToolForJson(tool: any, env: any, parameters: Record<string, any>): Promise<any> {
  let text: string | undefined;
  let fullOutput: string | undefined;

  await tool.call({
    env,
    parameters,
    pushResult: (t: string) => { text ??= t; },
    pushError: (t: string) => { logger.warn(`MCP Apps: ${tool.id ?? 'tool'} failed: ${t}`); },
    setMetadata: () => { /* not needed */ },
    // Bob calls this with the COMPLETE output when it exceeds its limit
    // (2000 lines / 50 KB) and then truncates the text it pushes. Capture the
    // full output here; returning a truthy value stops Bob from writing it to disk.
    saveToolOutput: async (full: string) => {
      fullOutput = full;
      return 'bob-powertoys://captured';
    },
  });

  const raw = fullOutput ?? text;
  if (raw === undefined) { return undefined; }
  if (fullOutput === undefined && raw.includes('Output truncated')) {
    logger.warn(`MCP Apps: ${tool.id ?? 'tool'} output truncated and not captured`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Proxy a View-initiated `tools/call` to the originating server through the
 * live MCP tool instance (inherits Bob's restart + elicitation handling).
 * Enforces the spec's `visibility: ["app"]` rule.
 */
async function proxyToolCall(app: McpApp, toolName: string, args: Record<string, any>): Promise<any> {
  const tm = getTaskManager();
  const cm = tm ? findTaskChatManager(tm, app.taskId) : null;
  const tools = cm?.currentTask?.getTools?.() ?? [];
  const tool = tools.find((t: any) =>
    t?.definer === 'mcp' &&
    (t.mcpInfo?.serverName ?? t.serverName) === app.serverName &&
    (t.mcpInfo?.toolName ?? t.toolName) === toolName);

  if (!tool) {
    return { isError: true, content: [{ type: 'text', text: `Tool "${toolName}" not found on server "${app.serverName}".` }] };
  }
  if (!callableByApp(tool.getDefinition?.())) {
    return { isError: true, content: [{ type: 'text', text: `Tool "${toolName}" is not callable by apps (visibility).` }] };
  }

  let text: string | undefined;
  let fullOutput: string | undefined;
  let isError = false;
  await tool.call({
    env: app.env,
    parameters: args,
    pushResult: (t: string) => { text ??= t; },
    pushError: (t: string) => { isError = true; text ??= t; },
    setMetadata: () => { /* not needed */ },
    // Same capture as callToolForJson, in case Bob truncates a large result.
    saveToolOutput: async (full: string) => {
      fullOutput = full;
      return 'bob-powertoys://captured';
    },
  });

  const raw = fullOutput ?? text;
  const structuredContent = raw !== undefined ? extractStructuredContent(raw) : undefined;
  return {
    isError: isError || undefined,
    content: raw !== undefined ? [{ type: 'text', text: raw }] : [],
    ...(structuredContent !== undefined && { structuredContent }),
  };
}

/**
 * Best-effort delivery of a View message into the task's conversation
 * (spec `ui/message`). Returns false when the chat manager is not reachable.
 */
function trySendToChat(app: McpApp, text: string): boolean {
  try {
    const tm = getTaskManager();
    const cm = tm ? findTaskChatManager(tm, app.taskId) : null;
    if (!cm?.handleInputMessage) { return false; }
    cm.handleInputMessage(text, cm.currentTask);
    return true;
  } catch (e) {
    logger.warn('MCP Apps: ui/message delivery failed', e);
    return false;
  }
}