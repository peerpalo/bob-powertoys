/**
 * Early hook on the MCPClient Bob creates for each workspace root.
 *
 * Runs before Bob does: the extension activates on "*" and installs this before
 * it activates Bob. The McpHub itself is not reachable that early, so the hook
 * sits on objects Bob creates per root: for each root Bob does
 * `registry.startupComplete = true` (plain object, no such own property yet) and
 * only then creates `registry.client`. A narrow Object.prototype setter for
 * `startupComplete` captures the registry, and an accessor on `registry.client`
 * hands every client Bob assigns to the registered listeners.
 *
 * Users: share.ts (session sharing) and rawResults.ts (MCP Apps results).
 * Listeners run in registration order; a later one wraps the earlier one's work.
 *
 * Depends on Bob internals (registry shape, startupComplete assignment order).
 */

type ClientListener = (client: any, root: string) => void;

const listeners: ClientListener[] = [];
let installed = false;

/** Register before installMcpClientHook() / before Bob activates. */
export function onMcpClient(listener: ClientListener): void {
  listeners.push(listener);
}

export function installMcpClientHook(): void {
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
  const notify = (c: any) => { for (const l of listeners) { l(c, registry.scopeRoot); } };
  let client = registry.client;
  Object.defineProperty(registry, 'client', {
    configurable: true,
    enumerable: true,
    get: () => client,
    set: (v) => { client = v; notify(v); },
  });
  notify(client);
}
