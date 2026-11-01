import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { shareClient, installMcpShare } from '../src/mcpShare.js';
import { logger } from '../src/utils.js';

// Fake MCPClient: createSession(name, false) returns an uninitialized session
// (as Bob does); initialize() is what actually "connects".
let spawned = 0;
function fakeClient(servers: Record<string, any>, opts: { failInit?: boolean } = {}) {
  const client: any = {
    sessions: {} as Record<string, any>,
    activeSessions: [] as string[],
    getServerConfig: (n: string) => servers[n],
    getSession(n: string) { return this.sessions[n] ?? null; },
    disconnectSession: (s: any) => s.disconnect(),
    async createSession(name: string) {
      const s: any = {
        id: ++spawned,
        isConnected: false,
        init: vi.fn(async () => {
          if (opts.failInit) { throw new Error('Authentication required'); }
          s.isConnected = true;
        }),
        initialize() { return this.init(); },
        disconnect: vi.fn(async () => { s.isConnected = false; }),
      };
      this.sessions[name] = s;
      this.activeSessions.push(name);
      return s;
    },
  };
  return client;
}

// `shared` is module state, so each test gets its own server identity.
let testId = 0;
beforeEach(() => { testId++; });
const cfg = (extra: object = {}) => ({ command: 'x', args: [`test-${testId}`], roots: [{ uri: Math.random() }], errlog: {}, ...extra });
// Bob: createSession(name, false) then session.initialize() (startServerSession).
const start = async (c: any, name: string) => {
  const s = await c.createSession(name, false);
  await s.initialize();
  return s;
};

describe('shareClient', () => {
  it('ignores objects that are not clients and is idempotent', () => {
    expect(() => shareClient(undefined)).not.toThrow();
    expect(() => shareClient({})).not.toThrow();
    const c = fakeClient({});
    shareClient(c);
    const patched = c.createSession;
    shareClient(c);
    expect(c.createSession).toBe(patched);
  });

  it('gives roots with the same config one session, initialized once', async () => {
    const a = fakeClient({ srv: cfg() }), b = fakeClient({ srv: cfg() });
    shareClient(a); shareClient(b);

    const [sa, sb] = await Promise.all([start(a, 'srv'), start(b, 'srv')]);

    expect(sb).toBe(sa);
    expect(b.getSession('srv')).toBe(sa);
    expect(b.activeSessions).toEqual(['srv']);
    expect(sa.init).toHaveBeenCalledTimes(1);
  });

  it('logs which root starts a session and which root reuses it', async () => {
    const log = vi.spyOn(logger, 'log').mockImplementation(() => {});
    const a = fakeClient({ srv: cfg() }), b = fakeClient({ srv: cfg() });
    shareClient(a, 'C:\\ws\\one'); shareClient(b, 'C:\\ws\\two');

    await start(a, 'srv');
    await start(b, 'srv');

    const lines = log.mock.calls.map(c => c[0]);
    log.mockRestore();
    expect(lines).toContain('MCP share: "srv" in C:\\ws\\one starts a new session');
    expect(lines).toContain('MCP share: "srv" in C:\\ws\\two reuses the session started by C:\\ws\\one (2 roots share it)');
  });

  it('keeps separate sessions when the resolved config differs', async () => {
    const a = fakeClient({ srv: cfg({ cwd: '/a' }) }), b = fakeClient({ srv: cfg({ cwd: '/b' }) });
    shareClient(a); shareClient(b);

    const [sa, sb] = await Promise.all([start(a, 'srv'), start(b, 'srv')]);

    expect(sb).not.toBe(sa);
  });

  it('does not share different servers with the same name', async () => {
    const a = fakeClient({ srv: cfg({ command: 'x' }) }), b = fakeClient({ srv: cfg({ command: 'y' }) });
    shareClient(a); shareClient(b);
    const [sa, sb] = await Promise.all([start(a, 'srv'), start(b, 'srv')]);
    expect(sb).not.toBe(sa);
  });

  it('shares the failure of a shared session once, then lets the next attempt retry', async () => {
    const a = fakeClient({ srv: cfg() }, { failInit: true }), b = fakeClient({ srv: cfg() }, { failInit: true });
    shareClient(a); shareClient(b);

    const results = await Promise.allSettled([start(a, 'srv'), start(b, 'srv')]);
    expect(results.map(r => r.status)).toEqual(['rejected', 'rejected']);
    expect(a.getSession('srv').init).toHaveBeenCalledTimes(1);

    // failed entry is dropped: a later attempt makes a fresh session
    const c = fakeClient({ srv: cfg() });
    shareClient(c);
    const sc = await start(c, 'srv');
    expect(sc.isConnected).toBe(true);
    expect(sc).not.toBe(a.getSession('srv'));
  });

  it('disconnects the real session only when the last root lets go', async () => {
    const a = fakeClient({ srv: cfg() }), b = fakeClient({ srv: cfg() });
    shareClient(a); shareClient(b);
    const [s] = await Promise.all([start(a, 'srv'), start(b, 'srv')]);

    await a.disconnectSession(s);
    expect(s.isConnected).toBe(true);
    await b.disconnectSession(s);
    expect(s.isConnected).toBe(false);
  });

  it('starts a fresh server after a root disconnects (restart does not rejoin the old session)', async () => {
    const a = fakeClient({ srv: cfg() }), b = fakeClient({ srv: cfg() });
    shareClient(a); shareClient(b);
    const s1 = await start(a, 'srv');
    await a.disconnectSession(s1);

    const s2 = await start(b, 'srv');
    expect(s2).not.toBe(s1);
    expect(s2.isConnected).toBe(true);
  });

  it('leaves createSession calls that are not Bob\'s startup path alone', async () => {
    const a = fakeClient({ srv: cfg() }), b = fakeClient({ srv: cfg() });
    shareClient(a); shareClient(b);
    const s1 = await a.createSession('srv', true);
    const s2 = await b.createSession('srv', true);
    expect(s2).not.toBe(s1);
  });
});

describe('installMcpShare', () => {
  afterAll(() => { delete (Object.prototype as any).startupComplete; });

  it('hooks a registry when Bob sets startupComplete, before the client exists', async () => {
    installMcpShare();
    // Same shape as Bob's registry: no own `startupComplete` until Bob assigns it.
    const mk = (scopeRoot: string): any => ({ scopeRoot, serversByKey: new Map(), activeServersByName: new Map(), client: undefined });
    const r1 = mk('C:\\ws\\one'), r2 = mk('C:\\ws\\two');

    // Bob: registry.startupComplete = true; then registry.client = new MCPClient()
    r1.startupComplete = true; r1.client = fakeClient({ srv: cfg() });
    r2.startupComplete = true; r2.client = fakeClient({ srv: cfg() });

    expect(r1.startupComplete).toBe(true);
    const [s1, s2] = await Promise.all([start(r1.client, 'srv'), start(r2.client, 'srv')]);
    expect(s2).toBe(s1);

    // closeClient sets client back to undefined without breaking
    r1.client = undefined;
    expect(r1.client).toBeUndefined();
  });

  it('is a plain assignment for objects that are not registries', () => {
    const o: any = {};
    o.startupComplete = 5;
    expect(o.startupComplete).toBe(5);
    expect(Object.keys(o)).toContain('startupComplete');
  });
});
