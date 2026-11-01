import { logger } from './utils.js';

/**
 * Share one MCP session across workspace roots.
 *
 * Bob's McpHub keeps one registry and one MCPClient per workspace root and
 * starts every global server once per root. When two roots resolve a server to
 * the same config, the extra sessions (processes, OAuth probes, tool loads) are
 * waste. See DEVELOPMENT.md, "MCP session sharing".
 *
 * Runs before Bob does: the extension activates on "*" and calls
 * installMcpShare() before it activates Bob. The hub itself is not reachable
 * that early, so the hook sits on objects Bob creates per root:
 *  1. For each root Bob does `registry.startupComplete = true` (plain object, no
 *     such own property yet) and only then creates `registry.client`. A narrow
 *     Object.prototype setter for `startupComplete` captures the registry, and an
 *     accessor on `registry.client` captures every client Bob assigns to it.
 *  2. `client.createSession(name, false)` is replaced: roots whose resolved
 *     server config is identical (ignoring `roots`) get the same session object.
 *     Bob's startServerSession then initializes it and loads tools per root as
 *     usual.
 *
 * Shared session lifecycle: the first disconnect by any root stops new roots from
 * joining it (so a restart really starts a fresh server); the real disconnect
 * happens when the last holder lets go. initialize() is memoized, so a failure
 * (e.g. OAuth required) happens once and every root sees the same error.
 *
 * Limits: the server only sees the first root in `roots`, and elicitation
 * requests are routed through the first root's handler.
 *
 * Depends on Bob internals (registry shape, startupComplete assignment order,
 * MCPClient.createSession/getServerConfig/sessions/activeSessions).
 */

// Per-root noise that does not change which server it is.
const IGNORED_KEYS = new Set(['roots', 'errlog', 'onElicitation', 'authProvider']);

interface Shared { session: Promise<any>; refs: number; ready: boolean; owner: string }

const shared = new Map<string, Shared>();
const patchedClients = new WeakSet<object>();

const keyOf = (name: string, config: unknown) =>
  JSON.stringify([name, config], (k, v) => (IGNORED_KEYS.has(k) ? undefined : v));

/** Wraps a freshly created session so its lifecycle is shared. */
function track(key: string, entry: Shared, session: any): any {
  const drop = () => { if (shared.get(key) === entry) { shared.delete(key); } };

  const init = session.initialize.bind(session);
  let initialized: Promise<void> | undefined;
  session.initialize = () => (initialized ??= init().then(
    () => { entry.ready = true; },
    (e: unknown) => { drop(); throw e; },
  ));

  const disconnect = session.disconnect.bind(session);
  session.disconnect = async () => {
    drop();
    if (--entry.refs <= 0) { await disconnect(); }
  };
  return session;
}

/** Makes a client reuse sessions that another root's client already created. `root` is only used in logs. */
export function shareClient(client: any, root = '?'): void {
  if (typeof client?.createSession !== 'function' || patchedClients.has(client)) { return; }
  patchedClients.add(client);

  const create = client.createSession.bind(client);
  client.createSession = async (name: string, ...rest: unknown[]) => {
    // Bob uses createSession(name, false); anything else is left alone.
    if (rest[0] !== false) { return create(name, ...rest); }

    const key = keyOf(name, client.getServerConfig(name));
    const held = shared.get(key);
    if (held) {
      const session = await held.session.catch(() => undefined);
      if (session && (!held.ready || session.isConnected)) {
        held.refs++;
        const old = client.sessions[name];
        client.sessions[name] = session;
        if (!client.activeSessions.includes(name)) { client.activeSessions.push(name); }
        if (old && old !== session) { await client.disconnectSession(old).catch(() => { /* already gone */ }); }
        logger.log(`MCP share: "${name}" in ${root} reuses the session started by ${held.owner} (${held.refs} roots share it)`);
        return session;
      }
    }

    const pending = create(name, ...rest);
    // Registered synchronously so concurrent roots join instead of connecting.
    const entry: Shared = { session: pending, refs: 1, ready: false, owner: root };
    logger.log(`MCP share: "${name}" in ${root} starts a new session`);
    entry.session = pending.then((s: any) => track(key, entry, s));
    shared.set(key, entry);
    entry.session.catch(() => { if (shared.get(key) === entry) { shared.delete(key); } });
    return entry.session;
  };
}

let installed = false;

/** Call before Bob activates. */
export function installMcpShare(): void {
  if (installed) { return; }
  installed = true;
  Object.defineProperty(Object.prototype, 'startupComplete', {
    configurable: true,
    get() { return undefined; },
    set(this: any, value: unknown) {
      // Behave like a normal assignment for everything that is not a Bob registry.
      Object.defineProperty(this, 'startupComplete', { value, writable: true, configurable: true, enumerable: true });
      if (this.serversByKey instanceof Map && 'client' in this) { hookRegistry(this); }
    },
  });
}

function hookRegistry(registry: any): void {
  let client = registry.client;
  Object.defineProperty(registry, 'client', {
    configurable: true,
    enumerable: true,
    get: () => client,
    set: (v) => { client = v; shareClient(v, registry.scopeRoot); },
  });
  shareClient(client, registry.scopeRoot);
}
