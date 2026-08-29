import { describe, it, expect, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import {
  registerTerminalCapture,
  ListTerminalsTool,
  GetTerminalOutputTool,
  SearchTerminalOutputTool,
} from '../src/tools/terminalConsole.js';

// ─── Bootstrap ────────────────────────────────────────────────────────────────
// Capture the shell-execution handler once at module load so tests can drive it
// without re-registering or touching vitest spies.

let startHandler: ((e: any) => void) | undefined;
let closeHandler: ((t: any) => void) | undefined;

const mockWindow = vscode.window as any;
mockWindow.onDidStartTerminalShellExecution = (h: any) => { startHandler = h; return { dispose: () => {} }; };
mockWindow.onDidCloseTerminal = (h: any) => { closeHandler = h; return { dispose: () => {} }; };

registerTerminalCapture({ subscriptions: { push: (d: any) => d } } as any);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeFakeTerminal(name: string): any {
  return { name, exitStatus: undefined };
}

/** Feed chunks into the log for a terminal via the captured shell handler. */
async function seedTerminal(terminal: any, chunks: string[]) {
  // Use a sync iterable so `for await` in the handler drains all chunks in
  // a single microtask batch, making it awaitable via a simple Promise.
  let resolve!: () => void;
  const done = new Promise<void>(r => { resolve = r; });

  const execRead = async function* () {
    yield* chunks;
    resolve();
  };

  startHandler!({ terminal, execution: { read: execRead } });
  await done;
}

function makeContext<T extends Record<string, any>>(parameters: T) {
  const results: string[] = [];
  const errors: string[] = [];
  return {
    env: {},
    parameters,
    pushResult: (text: string) => results.push(text),
    pushError: (text: string) => errors.push(text),
    results,
    errors,
    result: () => JSON.parse(results[0]),
    error: () => JSON.parse(errors[0]),
  };
}

/** Set up a fresh terminal object as active and seed it. Each call creates a
 *  new object reference, so stale log entries from prior tests are orphaned. */
async function setupTerminal(name: string, chunks: string[]) {
  const terminal = makeFakeTerminal(name);  // new object each time — no log entry yet
  mockWindow.terminals = [terminal];
  mockWindow.activeTerminal = terminal;
  await seedTerminal(terminal, chunks);
  return terminal;
}

beforeEach(() => {
  // Evict log entries for any terminals still tracked from the previous test.
  // setupTerminal creates a fresh object reference each time, so entries from
  // prior tests are naturally orphaned — this just keeps the map tidy.
  for (const t of (mockWindow.terminals as any[])) {
    closeHandler?.(t);
  }
  mockWindow.terminals = [];
  mockWindow.activeTerminal = null;
});

// ─── stripAnsi (exercised via get_terminal_output) ────────────────────────────

describe('stripAnsi', () => {
  let tool: GetTerminalOutputTool;
  beforeEach(() => { tool = new GetTerminalOutputTool(); });

  async function getOutput(chunks: string[]) {
    await setupTerminal('ansi-test', chunks);
    const ctx = makeContext({ lines: 1 });
    await tool.call(ctx);
    return ctx.result().output as string;
  }

  it('strips SGR colour codes', async () => {
    expect(await getOutput(['\x1B[31mred text\x1B[0m'])).toBe('red text\n');
  });

  it('strips cursor movement sequences', async () => {
    expect(await getOutput(['\x1B[2Jhello\x1B[H'])).toBe('hello\n');
  });

  it('strips OSC window-title sequences', async () => {
    expect(await getOutput(['\x1B]0;My Terminal\x07hello'])).toBe('hello\n');
  });

  it('strips OSC hyperlink sequences', async () => {
    expect(await getOutput(['\x1B]8;;https://example.com\x07link text\x1B]8;;\x07'])).toBe('link text\n');
  });

  it('leaves plain text unchanged', async () => {
    expect(await getOutput(['hello world\n'])).toBe('hello world\n');
  });

  it('splits multi-line chunk into separate entries', async () => {
    await setupTerminal('ansi-test', ['line1\nline2\nline3\n']);
    const tool = new GetTerminalOutputTool();
    const ctx = makeContext({ lines: 10 });
    await tool.call(ctx);
    expect(ctx.result().totalLines).toBe(3);
    expect(ctx.result().output).toBe('line1\nline2\nline3\n');
  });
});

// ─── ListTerminalsTool ────────────────────────────────────────────────────────

describe('ListTerminalsTool', () => {
  let tool: ListTerminalsTool;
  beforeEach(() => { tool = new ListTerminalsTool(); });

  it('returns empty array when no terminals', async () => {
    const ctx = makeContext({});
    await tool.call(ctx);
    expect(ctx.result()).toEqual([]);
  });

  it('marks the active terminal', async () => {
    const t1 = makeFakeTerminal('bash');
    const t2 = makeFakeTerminal('zsh');
    mockWindow.terminals = [t1, t2];
    mockWindow.activeTerminal = t2;
    const ctx = makeContext({});
    await tool.call(ctx);
    const list = ctx.result();
    expect(list.find((t: any) => t.name === 'bash').isActive).toBe(false);
    expect(list.find((t: any) => t.name === 'zsh').isActive).toBe(true);
  });

  it('reports outputLines after capture', async () => {
    await setupTerminal('bash', ['line1\n', 'line2\n']);
    const ctx = makeContext({});
    await tool.call(ctx);
    const entry = ctx.result().find((t: any) => t.name === 'bash');
    expect(entry.outputLines).toBe(2);
    expect(entry.hasOutput).toBe(true);
  });

  it('reports hasOutput false for unseen terminal', async () => {
    const terminal = makeFakeTerminal('unseen');
    mockWindow.terminals = [terminal];
    const ctx = makeContext({});
    await tool.call(ctx);
    expect(ctx.result()[0].hasOutput).toBe(false);
    expect(ctx.result()[0].outputLines).toBe(0);
  });
});

// ─── GetTerminalOutputTool ────────────────────────────────────────────────────

describe('GetTerminalOutputTool', () => {
  let tool: GetTerminalOutputTool;
  beforeEach(() => { tool = new GetTerminalOutputTool(); });

  it('errors when no active terminal', async () => {
    const ctx = makeContext({});
    await tool.call(ctx);
    expect(ctx.errors).toHaveLength(1);
    expect(ctx.error().error).toMatch(/No active terminal/);
  });

  it('errors when named terminal not found', async () => {
    const ctx = makeContext({ terminalName: 'ghost' });
    await tool.call(ctx);
    expect(ctx.error().error).toMatch(/ghost/);
  });

  it('returns empty-output message when no chunks captured', async () => {
    // Terminal exists but was never seeded — no log entry
    const terminal = makeFakeTerminal('empty');
    mockWindow.terminals = [terminal];
    mockWindow.activeTerminal = terminal;
    const ctx = makeContext({});
    await tool.call(ctx);
    const r = ctx.result();
    expect(r.totalLines).toBe(0);
    expect(r.output).toBe('');
    expect(r.message).toBeTruthy();
  });

  it('returns last 50 lines by default', async () => {
    const chunks = Array.from({ length: 80 }, (_, i) => `line${i}\n`);
    await setupTerminal('bash', chunks);
    const ctx = makeContext({});
    await tool.call(ctx);
    const r = ctx.result();
    expect(r.totalLines).toBe(80);
    expect(r.output).toContain('line30');
    expect(r.output).toContain('line79');
    expect(r.output).not.toContain('line29\n');
  });

  it('lines param returns last N lines', async () => {
    await setupTerminal('bash', ['a\n', 'b\n', 'c\n', 'd\n', 'e\n']);
    const ctx = makeContext({ lines: 3 });
    await tool.call(ctx);
    const r = ctx.result();
    expect(r.output).toContain('c\n');
    expect(r.output).toContain('e\n');
    expect(r.output).not.toContain('a\n');
    expect(r.output).not.toContain('b\n');
  });

  it('startLine param returns from offset', async () => {
    await setupTerminal('bash', ['a\n', 'b\n', 'c\n', 'd\n', 'e\n']);
    const ctx = makeContext({ startLine: 2 });
    await tool.call(ctx);
    const r = ctx.result();
    expect(r.output).toContain('c\n');
    expect(r.output).toContain('e\n');
    expect(r.output).not.toContain('a\n');
  });

  it('lines wins over startLine when both provided', async () => {
    await setupTerminal('bash', ['a\n', 'b\n', 'c\n', 'd\n', 'e\n']);
    // lines:2 → last 2 = d,e; startLine:0 would give all 5
    const ctx = makeContext({ lines: 2, startLine: 0 });
    await tool.call(ctx);
    const r = ctx.result();
    expect(r.output).toContain('d\n');
    expect(r.output).toContain('e\n');
    expect(r.output).not.toContain('a\n');
  });

  it('startLine beyond buffer returns empty output', async () => {
    await setupTerminal('bash', ['a\n', 'b\n']);
    const ctx = makeContext({ startLine: 999 });
    await tool.call(ctx);
    expect(ctx.result().output).toBe('');
  });

  it('reports truncated:true when line cap exceeded', async () => {
    // request more lines than the 1000-line cap
    const big = Array.from({ length: 10 }, (_, i) => `line${i}\n`);
    await setupTerminal('bash', big);
    const ctx = makeContext({ lines: 9999 });
    await tool.call(ctx);
    expect(ctx.result().truncated).toBe(true);
    // capped at min(9999, 1000) = 1000, but buffer only has 10 → 10 returned
    expect(ctx.result().returnedLines).toBe(10);
  });

  it('does not report truncated when output fits', async () => {
    await setupTerminal('bash', ['short\n']);
    const ctx = makeContext({});
    await tool.call(ctx);
    expect(ctx.result().truncated).toBeUndefined();
  });

  it('reports returnedLines in response', async () => {
    await setupTerminal('bash', ['a\n', 'b\n', 'c\n']);
    const ctx = makeContext({ lines: 2 });
    await tool.call(ctx);
    expect(ctx.result().returnedLines).toBe(2);
  });

  it('reports totalLines in response', async () => {
    await setupTerminal('bash', ['a\n', 'b\n', 'c\n']);
    const ctx = makeContext({});
    await tool.call(ctx);
    expect(ctx.result().totalLines).toBe(3);
  });

  it('uses named terminal when terminalName provided', async () => {
    const t1 = makeFakeTerminal('bash');
    const t2 = makeFakeTerminal('python');
    mockWindow.terminals = [t1, t2];
    mockWindow.activeTerminal = t1;
    await seedTerminal(t2, ['python-output\n']);
    const ctx = makeContext({ terminalName: 'python' });
    await tool.call(ctx);
    expect(ctx.result().output).toContain('python-output');
  });

  it('terminal close clears its log', async () => {
    const terminal = await setupTerminal('bash', ['data\n']);
    closeHandler!(terminal);
    // After close, log is gone — terminal re-added but not re-seeded
    mockWindow.terminals = [terminal];
    mockWindow.activeTerminal = terminal;
    const ctx = makeContext({});
    await tool.call(ctx);
    expect(ctx.result().totalLines).toBe(0);
  });
});

// ─── SearchTerminalOutputTool ─────────────────────────────────────────────────

describe('SearchTerminalOutputTool', () => {
  let tool: SearchTerminalOutputTool;
  beforeEach(() => { tool = new SearchTerminalOutputTool(); });

  it('errors when no active terminal', async () => {
    const ctx = makeContext({ query: 'error' });
    await tool.call(ctx);
    expect(ctx.errors).toHaveLength(1);
  });

  it('returns empty match message when no output captured', async () => {
    const terminal = makeFakeTerminal('empty');
    mockWindow.terminals = [terminal];
    mockWindow.activeTerminal = terminal;
    const ctx = makeContext({ query: 'error' });
    await tool.call(ctx);
    expect(ctx.result().matchedOutput).toBe('');
    expect(ctx.result().message).toBeTruthy();
  });

  it('returns matching lines', async () => {
    await setupTerminal('bash', ['INFO start\n', 'ERROR boom\n', 'INFO end\n']);
    const ctx = makeContext({ query: 'error' });
    await tool.call(ctx);
    const r = ctx.result();
    expect(r.matchedOutput).toContain('ERROR boom');
    expect(r.matchedOutput).not.toContain('INFO');
    expect(r.matchedLines).toBe(1);
  });

  it('is case-insensitive', async () => {
    await setupTerminal('bash', ['Warning: low memory\n']);
    const ctx = makeContext({ query: 'warning' });
    await tool.call(ctx);
    expect(ctx.result().matchedLines).toBe(1);
  });

  it('reports totalLines regardless of matches', async () => {
    await setupTerminal('bash', ['a\n', 'b\n', 'c\n']);
    const ctx = makeContext({ query: 'NOPE' });
    await tool.call(ctx);
    expect(ctx.result().totalLines).toBe(3);
    expect(ctx.result().matchedLines).toBe(0);
  });

  it('matchedLines counts all matches below the cap', async () => {
    const lines = Array.from({ length: 5 }, () => `ERROR line\n`);
    await setupTerminal('bash', lines);
    const ctx = makeContext({ query: 'ERROR' });
    await tool.call(ctx);
    expect(ctx.result().matchedLines).toBe(5);
    expect(ctx.result().truncated).toBeUndefined();
  });

  it('does not report truncated when matches fit', async () => {
    await setupTerminal('bash', ['ERROR short\n']);
    const ctx = makeContext({ query: 'ERROR' });
    await tool.call(ctx);
    expect(ctx.result().truncated).toBeUndefined();
  });

  it('rejects invalid regex via validate()', async () => {
    const result = await tool.validate({ env: {}, parameters: { query: '[invalid' } });
    expect(result).toMatch(/Invalid regular expression/);
  });

  it('accepts valid regex via validate()', async () => {
    const result = await tool.validate({ env: {}, parameters: { query: 'error|warn' } });
    expect(result).toBeUndefined();
  });
});
