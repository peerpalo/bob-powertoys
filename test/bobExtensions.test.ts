import { describe, it, expect, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { ListExtensionsTool } from '../src/tools/bobExtensions.js';

// Helper: build a minimal fake extension object.
function makeExt(overrides: {
  id: string;
  isActive?: boolean;
  isBuiltin?: boolean;
  displayName?: string;
  name?: string;
  version?: string;
  publisher?: string;
  description?: string;
}): any {
  const { id, isActive = false, isBuiltin = false, displayName, name, version, publisher, description } = overrides;
  return {
    id,
    isActive,
    packageJSON: {
      isBuiltin,
      displayName,
      name: name ?? id,
      version: version ?? '1.0.0',
      publisher: publisher ?? 'test-publisher',
      description: description ?? '',
    },
  };
}

// Helper: invoke ListExtensionsTool.call and return the parsed JSON result.
async function invoke(params: { filter?: string; include_builtin?: boolean }) {
  const tool = new ListExtensionsTool();
  let result = '';
  await tool.call({
    env: {},
    parameters: params,
    pushResult: (text) => { result = text; },
    pushError: () => {},
  });
  return JSON.parse(result);
}

// Reset vscode.extensions.all before each test.
beforeEach(() => {
  (vscode.extensions as any).all = [];
});

// ─── ListExtensionsTool ───────────────────────────────────────────────────────

describe('ListExtensionsTool', () => {

  // ── metadata ────────────────────────────────────────────────────────────────
  describe('metadata', () => {
    it('getId returns list_extensions', () => {
      expect(new ListExtensionsTool().getId()).toBe('list_extensions');
    });

    it('getDescription returns a non-empty string', () => {
      expect(new ListExtensionsTool().getDescription().length).toBeGreaterThan(0);
    });

    it('getCostEffectiveDescription returns a non-empty string', () => {
      expect(new ListExtensionsTool().getCostEffectiveDescription().length).toBeGreaterThan(0);
    });

    it('getLabels with no filter', () => {
      const labels = new ListExtensionsTool().getLabels({});
      expect(labels.displayName).toBe('List Extensions');
    });

    it('getLabels with filter includes filter in displayName', () => {
      const labels = new ListExtensionsTool().getLabels({ filter: 'python' });
      expect(labels.displayName).toBe('List Extensions: python');
    });
  });

  // ── empty extension list ─────────────────────────────────────────────────────
  describe('empty extension list', () => {
    it('returns total 0 and empty array when no extensions exist', async () => {
      const res = await invoke({});
      expect(res.total).toBe(0);
      expect(res.extensions).toEqual([]);
    });
  });

  // ── builtin filtering ────────────────────────────────────────────────────────
  describe('builtin filtering', () => {
    beforeEach(() => {
      (vscode.extensions as any).all = [
        makeExt({ id: 'built.in', isBuiltin: true }),
        makeExt({ id: 'user.ext' }),
      ];
    });

    it('excludes builtin extensions by default', async () => {
      const res = await invoke({});
      expect(res.total).toBe(1);
      expect(res.extensions[0].id).toBe('user.ext');
    });

    it('includes builtin extensions when include_builtin is true', async () => {
      const res = await invoke({ include_builtin: true });
      expect(res.total).toBe(2);
      const ids = res.extensions.map((e: any) => e.id);
      expect(ids).toContain('built.in');
      expect(ids).toContain('user.ext');
    });
  });

  // ── filter (substring match) ─────────────────────────────────────────────────
  describe('filter', () => {
    beforeEach(() => {
      (vscode.extensions as any).all = [
        makeExt({ id: 'ms-python.python', displayName: 'Python' }),
        makeExt({ id: 'ms-vscode.go',     displayName: 'Go' }),
      ];
    });

    it('filters by id substring (case-insensitive)', async () => {
      const res = await invoke({ filter: 'PYTHON' });
      expect(res.total).toBe(1);
      expect(res.extensions[0].id).toBe('ms-python.python');
    });

    it('filters by displayName substring (case-insensitive)', async () => {
      const res = await invoke({ filter: 'go' });
      expect(res.total).toBe(1);
      expect(res.extensions[0].id).toBe('ms-vscode.go');
    });

    it('returns all non-builtin extensions when filter is empty string', async () => {
      const res = await invoke({ filter: '' });
      expect(res.total).toBe(2);
    });

    it('returns 0 results for a non-matching filter', async () => {
      const res = await invoke({ filter: 'rust' });
      expect(res.total).toBe(0);
    });
  });

  // ── result shape ─────────────────────────────────────────────────────────────
  describe('result shape', () => {
    it('maps extension fields correctly', async () => {
      (vscode.extensions as any).all = [
        makeExt({
          id: 'acme.tool',
          isActive: true,
          displayName: 'Acme Tool',
          version: '2.3.4',
          publisher: 'acme',
          description: 'Does things',
        }),
      ];
      const res = await invoke({});
      const ext = res.extensions[0];
      expect(ext.id).toBe('acme.tool');
      expect(ext.displayName).toBe('Acme Tool');
      expect(ext.version).toBe('2.3.4');
      expect(ext.isActive).toBe(true);
      expect(ext.isBuiltin).toBe(false);
      expect(ext.publisher).toBe('acme');
      expect(ext.description).toBe('Does things');
    });

    it('falls back to packageJSON.name when displayName is absent', async () => {
      (vscode.extensions as any).all = [
        makeExt({ id: 'acme.notitle', name: 'notitle' }),
      ];
      const res = await invoke({});
      expect(res.extensions[0].displayName).toBe('notitle');
    });

    it('falls back to id when both displayName and name are absent', async () => {
      (vscode.extensions as any).all = [{
        id: 'bare.id',
        isActive: false,
        packageJSON: {},
      }];
      const res = await invoke({});
      expect(res.extensions[0].displayName).toBe('bare.id');
    });

    it('results are sorted by id', async () => {
      (vscode.extensions as any).all = [
        makeExt({ id: 'zzz.last' }),
        makeExt({ id: 'aaa.first' }),
        makeExt({ id: 'mmm.mid' }),
      ];
      const res = await invoke({});
      const ids = res.extensions.map((e: any) => e.id);
      expect(ids).toEqual(['aaa.first', 'mmm.mid', 'zzz.last']);
    });
  });

});
