import { describe, it, expect } from 'vitest';
import {
  toolUiResourceUri,
  callableByApp,
  extractStructuredContent,
  buildAppPanelDocument,
} from '../../src/mcp/apps.js';

// Pure parts of the MCP Apps host: tool-metadata extraction, structuredContent
// recovery from Bob's flattened MCP result text, and the panel document that
// bootstraps the bundled official AppBridge.

// ─── toolUiResourceUri ────────────────────────────────────────────────────────

describe('toolUiResourceUri', () => {
  it('reads _meta.ui.resourceUri', () => {
    expect(toolUiResourceUri({ name: 't', _meta: { ui: { resourceUri: 'ui://srv/view' } } }))
      .toBe('ui://srv/view');
  });

  it('reads the deprecated _meta["ui/resourceUri"] format', () => {
    expect(toolUiResourceUri({ name: 't', _meta: { 'ui/resourceUri': 'ui://srv/view' } }))
      .toBe('ui://srv/view');
  });

  it('prefers the new format when both are present', () => {
    expect(toolUiResourceUri({ _meta: { ui: { resourceUri: 'ui://new' }, 'ui/resourceUri': 'ui://old' } }))
      .toBe('ui://new');
  });

  it('rejects non-ui:// URIs and missing metadata', () => {
    expect(toolUiResourceUri({ _meta: { ui: { resourceUri: 'https://example.com' } } })).toBeUndefined();
    expect(toolUiResourceUri({ name: 't' })).toBeUndefined();
    expect(toolUiResourceUri(undefined)).toBeUndefined();
  });
});

// ─── callableByApp ────────────────────────────────────────────────────────────

describe('callableByApp', () => {
  it('defaults to callable when visibility is omitted', () => {
    expect(callableByApp({ _meta: { ui: { resourceUri: 'ui://x' } } })).toBe(true);
    expect(callableByApp({})).toBe(true);
  });

  it('honours the visibility list', () => {
    expect(callableByApp({ _meta: { ui: { visibility: ['model', 'app'] } } })).toBe(true);
    expect(callableByApp({ _meta: { ui: { visibility: ['app'] } } })).toBe(true);
    expect(callableByApp({ _meta: { ui: { visibility: ['model'] } } })).toBe(false);
  });
});

// ─── extractStructuredContent ─────────────────────────────────────────────────

describe('extractStructuredContent', () => {
  it('recovers the trailing JSON appended by Bob for structuredContent', () => {
    // Bob pushes [...textItems, JSON.stringify(structuredContent)].join('  ')
    const text = ['Current weather: Sunny', '{"temperature":72,"conditions":"sunny"}'].join('  ');
    expect(extractStructuredContent(text)).toEqual({ temperature: 72, conditions: 'sunny' });
  });

  it('recovers arrays too', () => {
    expect(extractStructuredContent('done  [1,2,3]')).toEqual([1, 2, 3]);
  });

  it('returns undefined when there is no trailing JSON', () => {
    expect(extractStructuredContent('just text')).toBeUndefined();
    expect(extractStructuredContent('a  b  c')).toBeUndefined();
    expect(extractStructuredContent('')).toBeUndefined();
  });

  it('does not mistake JSON inside the text for structuredContent', () => {
    // The JSON must be the LAST double-space-separated entry.
    expect(extractStructuredContent('{"a":1}  trailing text')).toBeUndefined();
  });
});

// ─── buildAppPanelDocument ───────────────────────────────────────────────────

describe('buildAppPanelDocument', () => {
  const cspSource = 'vscode-webview:';
  const config = {
    appHtml: '<script>alert("hi")</script><b>app</b>',
    hostInfo: { name: 'bob-powertoys', version: '0.1.0' },
    capabilities: { serverTools: {} },
    hostContext: { theme: 'dark' },
    sandbox: 'allow-scripts',
    csp: "default-src 'none'",
    webviewCspSource: cspSource,
  };
  const html = buildAppPanelDocument(config, 'https://webview-cdn.vscode-cdn.net/mcp/appBridge.js', 'My App');

  it('embeds the bridge config safely (closing tags escaped)', () => {
    expect(html).not.toContain('<script>alert("hi")</script>');
    expect(html).toContain('<\\/script>');
    expect(html).toContain('window.__MCP_APPS_CONFIG =');
  });

  it('loads the bundled AppBridge script', () => {
    expect(html).toContain('<script src="https://webview-cdn.vscode-cdn.net/mcp/appBridge.js">');
  });

  it('carries the iframe sandbox and CSP for the bridge to apply', () => {
    const marker = 'window.__MCP_APPS_CONFIG = ';
    const start = html.indexOf(marker) + marker.length;
    const end = html.lastIndexOf(';</scr' + 'ipt>');
    const raw = html.slice(start, end);
    const parsed = JSON.parse(raw.split('<\\/').join('</'));
    expect(parsed.sandbox).toBe('allow-scripts');
    expect(parsed.csp).toBe("default-src 'none'");
    expect(parsed.appHtml).toContain('<b>app</b>');
  });

  it('host document script-src is locked to webviewCspSource (no https: wildcard for scripts)', () => {
    const cspMatch = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/);
    const csp = cspMatch?.[1] ?? '';
    expect(csp).toContain(`script-src 'unsafe-inline' ${cspSource}`);
    // script-src must not widen to https: — other directives may allow https: for the iframe
    expect(csp).not.toMatch(/script-src[^;]*https:/);
  });

  it('escapes the title', () => {
    expect(buildAppPanelDocument(config, 'x', 'a"b')).toContain('<title>a&quot;b</title>');
  });
});
