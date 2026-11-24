/**
 * Raw MCP tool results for the MCP Apps host.
 *
 * Bob flattens an MCP result to text before anyone can see it, and drops
 * `_meta`. The Insiders build also drops `structuredContent` whenever the tool
 * returned any text content (`pushToolResult`: structuredContent is only
 * serialized when nothing else was forwarded). Views such as cohort-heatmap
 * render from `structuredContent` and the map reads `_meta.viewUUID`, so they
 * get nothing useful from the flattened text.
 *
 * Fix: wrap `callTool` on every session Bob creates and keep the last few raw
 * results per server, so apps.ts can hand the View the real result.
 */

import { onMcpClient, installMcpClientHook } from './clientHook.js';

const MAX_PER_SERVER = 5;

interface Recorded { tool: string; argsKey: string; result: any }

const recorded = new Map<string, Recorded[]>();
const wrappedSessions = new WeakSet<object>();
const wrappedClients = new WeakSet<object>();

const keyOf = (args: unknown) => JSON.stringify(args ?? {});

function record(server: string, tool: string, args: unknown, result: any): void {
  const list = recorded.get(server) ?? [];
  list.push({ tool, argsKey: keyOf(args), result });
  if (list.length > MAX_PER_SERVER) { list.shift(); }
  recorded.set(server, list);
}

/** Records every `callTool` result of `session` under `server`. Idempotent. */
export function captureSession(server: string, session: any): void {
  if (typeof session?.callTool !== 'function' || wrappedSessions.has(session)) { return; }
  wrappedSessions.add(session);
  const call = session.callTool.bind(session);
  session.callTool = async (tool: string, args: unknown, ...rest: unknown[]) => {
    const result = await call(tool, args, ...rest);
    record(server, tool, args, result);
    return result;
  };
}

let installed = false;

/** Call before Bob activates (see clientHook.ts). */
export function installMcpCapture(): void {
  if (installed) { return; }
  installed = true;
  onMcpClient(captureClient);
  installMcpClientHook();
}

/** Makes every session created by `client` record its tool results. */
export function captureClient(client: any): void {
  if (typeof client?.createSession !== 'function' || wrappedClients.has(client)) { return; }
  wrappedClients.add(client);
  const create = client.createSession.bind(client);
  client.createSession = async (name: string, ...rest: unknown[]) => {
    const session = await create(name, ...rest);
    captureSession(name, session);
    return session;
  };
}

/**
 * Remove and return the newest raw result of `tool` on `server`, preferring
 * the entry with identical arguments. Undefined when nothing was recorded.
 */
export function takeRawResult(server: string, tool: string, args?: unknown): any {
  const list = recorded.get(server);
  if (!list) { return undefined; }
  const key = keyOf(args);
  let i = list.map(r => r.tool === tool && r.argsKey === key).lastIndexOf(true);
  if (i < 0) { i = list.map(r => r.tool === tool).lastIndexOf(true); }
  return i < 0 ? undefined : list.splice(i, 1)[0].result;
}
