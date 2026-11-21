/**
 * Browser bundle entry for the MCP Apps panel webview — DO NOT IMPORT FROM
 * THE EXTENSION HOST. Built separately by esbuild.js into
 * `out/mcp/appBridge.js` (iife, platform: browser) and loaded by the panel
 * document created in src/mcp/apps.ts.
 *
 * This is the official host SDK doing the protocol work: `AppBridge` from
 * `@modelcontextprotocol/ext-apps/app-bridge` handles the MCP Apps wire
 * protocol (ui/initialize handshake, tool-input/tool-result notifications,
 * request routing, teardown, size changes, …) between the View iframe and
 * this webview. We run it without an MCP client (`new AppBridge(null, …)`)
 * and wire its handlers to the extension host through a tiny request/
 * response relay over `acquireVsCodeApi()` — the extension host (mcpApps.ts)
 * answers by proxying to Bob's MCP tool instances.
 *
 * The panel document embeds the configuration as
 * `window.__MCP_APPS_CONFIG` before loading this bundle.
 */

import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';

interface BridgeConfig {
  /** HTML of the ui:// resource (rendered in the sandboxed iframe). */
  appHtml: string;
  /** Host info for the ui/initialize response. */
  hostInfo: { name: string; version: string };
  /** Host capabilities for the ui/initialize response. */
  capabilities: Record<string, unknown>;
  /** Initial host context fields (theme, …). */
  hostContext: Record<string, unknown>;
  /** Sandbox attribute for the View iframe. */
  sandbox: string;
  /** CSP for the View iframe (`csp` attribute). */
  csp: string;
}

interface VsCodeApi { postMessage(message: unknown): void }
declare function acquireVsCodeApi(): VsCodeApi;

/** Messages exchanged with the extension host (mcpApps.ts). */
interface RelayMessage {
  __bobPtBridge: true;
  kind: 'request' | 'response' | 'command' | 'notify';
  id?: number;
  method?: string;
  params?: unknown;
  cmd?: string;
  result?: unknown;
  error?: string;
}

function relayStart(config: BridgeConfig): void {
  const vscode = acquireVsCodeApi();

  // ── View iframe (desktop-host path: direct rendering, no sandbox proxy) ──
  const frame = document.createElement('iframe');
  frame.style.cssText = 'width:100%;height:100%;border:0;display:block;';
  frame.setAttribute('sandbox', config.sandbox);
  frame.setAttribute('csp', config.csp);
  frame.srcdoc = config.appHtml;

  // ── Request/response relay to the extension host ──
  let nextRequestId = 1;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  function rpc(method: string, params?: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = nextRequestId++;
      pending.set(id, { resolve, reject });
      vscode.postMessage({ __bobPtBridge: true, kind: 'request', id, method, params } satisfies RelayMessage);
    });
  }

  const bridge = new AppBridge(null, config.hostInfo, config.capabilities as any);

  window.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as RelayMessage;
    if (!data || data.__bobPtBridge !== true) { return; }

    if (data.kind === 'response' && data.id !== undefined) {
      const entry = pending.get(data.id);
      if (entry) {
        pending.delete(data.id);
        if (data.error) { entry.reject(new Error(data.error)); } else { entry.resolve(data.result); }
      }
      return;
    }

    if (data.kind === 'command') {
      // Host → View lifecycle commands, invoked on the AppBridge.
      try {
        if (data.cmd === 'tool-input') { void bridge.sendToolInput(data.params as any); }
        else if (data.cmd === 'tool-result') { void bridge.sendToolResult(data.params as any); }
        else if (data.cmd === 'tool-cancelled') { void bridge.sendToolCancelled(data.params as any); }
        else if (data.cmd === 'teardown') { void bridge.teardownResource({}).catch(() => { /* best effort */ }); }
      } catch (e) {
        console.error('[MCP Apps bridge] command failed:', e);
      }
    }
  });

  // ── AppBridge handlers → extension host ──
  (bridge as any).oncalltool = (params: any) => rpc('tools/call', params);
  (bridge as any).onreadresource = (params: any) => rpc('resources/read', params);
  (bridge as any).onlistresources = (params: any) => rpc('resources/list', params);
  (bridge as any).onlistresourcetemplates = (params: any) => rpc('resources/templates/list', params);
  (bridge as any).onopenlink = (params: any) => rpc('open-link', params);
  (bridge as any).onmessage = (params: any) => rpc('message', params);
  (bridge as any).onupdatemodelcontext = (params: any) => rpc('update-model-context', params);
  (bridge as any).onloggingmessage = (params: any) => {
    vscode.postMessage({ __bobPtBridge: true, kind: 'notify', method: 'log', params } satisfies RelayMessage);
  };
  (bridge as any).oninitialized = () => {
    vscode.postMessage({ __bobPtBridge: true, kind: 'notify', method: 'initialized' } satisfies RelayMessage);
  };
  (bridge as any).onrequestdisplaymode = () => Promise.resolve({ mode: 'inline' });  // only inline is supported
  (bridge as any).ondownloadfile = (params: any) => rpc('download-file', params);

  bridge.setHostContext(config.hostContext as any);

  // ── Connect: transport must listen before the View's scripts run, so the
  // iframe is inserted first but srcdoc parsing starts asynchronously. ──
  document.body.appendChild(frame);
  const transport = new PostMessageTransport(frame.contentWindow!, frame.contentWindow!);
  bridge.connect(transport).catch((e: unknown) => {
    console.error('[MCP Apps bridge] connect failed:', e);
  });
}

const config = (window as any).__MCP_APPS_CONFIG as BridgeConfig | undefined;
if (config) {
  relayStart(config);
} else {
  console.error('[MCP Apps bridge] missing window.__MCP_APPS_CONFIG');
}
