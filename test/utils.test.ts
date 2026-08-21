import { describe, it, expect } from 'vitest';
import { normaliseWorkspacePath, paramsToSchema } from '../src/utils.js';

describe('normaliseWorkspacePath', () => {

  // ── dotfolders must be preserved  ─────────────────────────────────────────
  describe('dotfolder preservation', () => {
    it('preserves .bob', () => {
      expect(normaliseWorkspacePath('.bob')).toBe('.bob');
    });
    it('preserves .idea', () => {
      expect(normaliseWorkspacePath('.idea')).toBe('.idea');
    });
    it('preserves .git', () => {
      expect(normaliseWorkspacePath('.git')).toBe('.git');
    });
    it('preserves dotfolder with nested path', () => {
      expect(normaliseWorkspacePath('.idea/workspace.xml')).toBe('.idea/workspace.xml');
    });
    it('preserves dotfile inside a dotfolder', () => {
      expect(normaliseWorkspacePath('.idea/.gitignore')).toBe('.idea/.gitignore');
    });
    it('preserves dotfile at root', () => {
      expect(normaliseWorkspacePath('.gitignore')).toBe('.gitignore');
    });
  });

  // ── current-directory prefix stripping ───────────────────────────────────
  describe('./ prefix stripping', () => {
    it('strips leading ./', () => {
      expect(normaliseWorkspacePath('./src')).toBe('src');
    });
    it('strips leading ./ leaving nested path intact', () => {
      expect(normaliseWorkspacePath('./src/app.ts')).toBe('src/app.ts');
    });
    it('strips ./ before a dotfolder', () => {
      expect(normaliseWorkspacePath('./.idea')).toBe('.idea');
    });
  });

  // ── root references collapse to empty string ─────────────────────────────
  describe('root reference', () => {
    it('collapses lone . to empty string', () => {
      expect(normaliseWorkspacePath('.')).toBe('');
    });
    it('returns empty string unchanged', () => {
      expect(normaliseWorkspacePath('')).toBe('');
    });
  });

  // ── backslash normalisation (Windows paths) ───────────────────────────────
  describe('backslash normalisation', () => {
    it('converts backslashes to forward slashes', () => {
      expect(normaliseWorkspacePath('src\\app.ts')).toBe('src/app.ts');
    });
    it('converts backslashes in dotfolder path', () => {
      expect(normaliseWorkspacePath('.idea\\workspace.xml')).toBe('.idea/workspace.xml');
    });
    it('strips .\\ prefix (Windows ./ equivalent)', () => {
      expect(normaliseWorkspacePath('.\\src')).toBe('src');
    });
  });

  // ── absolute prefix stripping ─────────────────────────────────────────────
  describe('leading slash stripping', () => {
    it('strips a bare leading /', () => {
      expect(normaliseWorkspacePath('/src')).toBe('src');
    });
  });

  // ── normal paths pass through unchanged ──────────────────────────────────
  describe('normal paths pass through unchanged', () => {
    it('plain directory', () => {
      expect(normaliseWorkspacePath('src')).toBe('src');
    });
    it('nested path', () => {
      expect(normaliseWorkspacePath('src/tools/workspace.ts')).toBe('src/tools/workspace.ts');
    });
  });

});

describe('paramsToSchema', () => {

  // ── schema envelope ───────────────────────────────────────────────────────
  describe('schema envelope', () => {
    it('returns type object', () => {
      expect(paramsToSchema([]).type).toBe('object');
    });
    it('sets additionalProperties to false', () => {
      expect(paramsToSchema([]).additionalProperties).toBe(false);
    });
    it('returns empty properties and required for empty PARAMS', () => {
      const s = paramsToSchema([]);
      expect(s.properties).toEqual({});
      expect(s.required).toEqual([]);
    });
  });

  // ── required ──────────────────────────────────────────────────────────────
  describe('required', () => {
    it('includes only required params in required array', () => {
      const s = paramsToSchema([
        { name: 'a', type: 'string', required: true,  description: 'A' },
        { name: 'b', type: 'string', required: false, description: 'B' },
        { name: 'c', type: 'string',                  description: 'C' },
      ]);
      expect(s.required).toEqual(['a']);
    });
  });

  // ── description / detail fallback ─────────────────────────────────────────
  describe('description and detail', () => {
    it('uses description when both are present', () => {
      const s = paramsToSchema([
        { name: 'p', type: 'string', description: 'long desc', detail: 'short detail' },
      ]);
      expect(s.properties.p.description).toBe('long desc');
    });
    it('uses detail as description fallback when description is absent', () => {
      const s = paramsToSchema([
        { name: 'p', type: 'string', detail: 'short detail' },
      ]);
      expect(s.properties.p.description).toBe('short detail');
    });
    it('uses description as detail fallback when detail is absent', () => {
      const s = paramsToSchema([
        { name: 'p', type: 'string', description: 'long desc' },
      ]);
      expect(s.properties.p.detail).toBe('long desc');
    });
    it('preserves detail when both are present', () => {
      const s = paramsToSchema([
        { name: 'p', type: 'string', description: 'long desc', detail: 'short detail' },
      ]);
      expect(s.properties.p.detail).toBe('short detail');
    });
    it('falls back to empty string when neither is present', () => {
      const s = paramsToSchema([{ name: 'p', type: 'string' }]);
      expect(s.properties.p.description).toBe('');
      expect(s.properties.p.detail).toBe('');
    });
  });

  // ── usage sentinel ────────────────────────────────────────────────────────
  describe('usage', () => {
    it('preserves usage when present', () => {
      const s = paramsToSchema([
        { name: 'cmd', type: 'string', description: 'd', usage: 'command' },
      ]);
      expect(s.properties.cmd.usage).toBe('command');
    });
    it('omits usage when absent', () => {
      const s = paramsToSchema([{ name: 'p', type: 'string', description: 'd' }]);
      expect(s.properties.p).not.toHaveProperty('usage');
    });
  });

  // ── renderHint ────────────────────────────────────────────────────────────
  describe('renderHint', () => {
    it('preserves renderHint when present', () => {
      const s = paramsToSchema([
        { name: 'p', type: 'string', description: 'd', renderHint: 'code' },
      ]);
      expect(s.properties.p.renderHint).toBe('code');
    });
    it('omits renderHint when absent', () => {
      const s = paramsToSchema([{ name: 'p', type: 'string', description: 'd' }]);
      expect(s.properties.p).not.toHaveProperty('renderHint');
    });
    it('preserves hidden renderHint', () => {
      const s = paramsToSchema([
        { name: 'p', type: 'string', description: 'd', renderHint: 'hidden' },
      ]);
      expect(s.properties.p.renderHint).toBe('hidden');
    });
  });

  // ── type passthrough ──────────────────────────────────────────────────────
  describe('type passthrough', () => {
    it('copies string type', () => {
      const s = paramsToSchema([{ name: 'p', type: 'string', description: 'd' }]);
      expect(s.properties.p.type).toBe('string');
    });
    it('copies number type', () => {
      const s = paramsToSchema([{ name: 'p', type: 'number', description: 'd' }]);
      expect(s.properties.p.type).toBe('number');
    });
  });

  // ── multiple params ───────────────────────────────────────────────────────
  describe('multiple params', () => {
    it('builds a property entry for every param', () => {
      const s = paramsToSchema([
        { name: 'workspace', type: 'string', required: true,  description: 'ws',  detail: 'ws',  renderHint: 'hidden' },
        { name: 'command',   type: 'string', required: true,  description: 'cmd', detail: 'cmd', usage: 'command', renderHint: 'code' },
        { name: 'cwd',       type: 'string', required: false, description: 'dir', detail: 'dir' },
      ]);
      expect(Object.keys(s.properties)).toEqual(['workspace', 'command', 'cwd']);
      expect(s.required).toEqual(['workspace', 'command']);
      expect(s.properties.workspace.renderHint).toBe('hidden');
      expect(s.properties.command.usage).toBe('command');
      expect(s.properties.cwd).not.toHaveProperty('usage');
    });
  });

});
