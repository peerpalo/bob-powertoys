import { describe, it, expect } from 'vitest';
import { captureSession, captureClient, takeRawResult } from '../../src/mcp/rawResults.js';

const fakeSession = (results: Record<string, any> = {}) => ({
  callTool: async (tool: string) => results[tool] ?? { content: [{ type: 'text', text: tool }] },
});

describe('rawResults', () => {
  it('records raw results and prefers identical args', async () => {
    const s: any = fakeSession({ t: { structuredContent: { a: 1 }, _meta: { m: 1 } } });
    captureSession('srvA', s);
    await s.callTool('t', { x: 1 });
    await s.callTool('t', { x: 2 });
    expect(takeRawResult('srvA', 't', { x: 1 })).toMatchObject({ structuredContent: { a: 1 } });
    // the {x:1} entry was removed; falls back to latest by tool
    expect(takeRawResult('srvA', 't', { x: 1 })).toBeDefined();
    expect(takeRawResult('srvA', 't', { x: 1 })).toBeUndefined();
  });

  it('is idempotent: wrapping twice records once', async () => {
    const s: any = fakeSession();
    captureSession('srvB', s);
    captureSession('srvB', s);
    await s.callTool('t', {});
    expect(takeRawResult('srvB', 't', {})).toBeDefined();
    expect(takeRawResult('srvB', 't', {})).toBeUndefined();
  });

  it('keeps only the last 5 per server', async () => {
    const s: any = fakeSession();
    captureSession('srvC', s);
    for (let i = 0; i < 7; i++) { await s.callTool(`t${i}`, {}); }
    expect(takeRawResult('srvC', 't0', {})).toBeUndefined();
    expect(takeRawResult('srvC', 't1', {})).toBeUndefined();
    expect(takeRawResult('srvC', 't6', {})).toBeDefined();
  });

  it('captureClient wraps sessions created through the client', async () => {
    const client: any = { createSession: async () => fakeSession({ t: { structuredContent: 1 } }) };
    captureClient(client);
    captureClient(client);
    const s = await client.createSession('srvD', false);
    await s.callTool('t', {});
    expect(takeRawResult('srvD', 't')).toMatchObject({ structuredContent: 1 });
  });

  it('returns undefined for unknown server or tool', () => {
    expect(takeRawResult('nope', 't')).toBeUndefined();
  });
});
