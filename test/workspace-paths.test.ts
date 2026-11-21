import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { resolveOpenFilePath } from '../src/utils.js';

const join = (...parts: string[]) => path.join(...parts);

const ROOT = '/src/backend';
const FOLDERS = [
  { name: 'other', uri: { fsPath: '/ws/other' } },
  { name: 'backend', uri: { fsPath: ROOT } },
  { name: 'frontend', uri: { fsPath: '/src/frontend' } },
];

describe('resolveOpenFilePath', () => {

  // ── ./ prefix stripping ────────────────────────────────────────────────────
  describe('./ prefix (webview ct() prepends this)', () => {
    it('resolves ./folder-name/sub/file.ts', () => {
      expect(resolveOpenFilePath('./backend/src/api/foo.js', FOLDERS))
        .toBe(join('/src/backend', 'src/api/foo.js'));
    });

    it('resolves ./folder-name with no sub-path', () => {
      expect(resolveOpenFilePath('./backend', FOLDERS))
        .toBe('/src/backend');
    });

    it('resolves ./folder-name/ trailing slash variant', () => {
      // stripped = "backend/" → startsWith("backend/") ✓
      expect(resolveOpenFilePath('./backend/src', FOLDERS))
        .toBe(join('/src/backend', 'src'));
    });
  });

  // ── no ./ prefix ───────────────────────────────────────────────────────────
  describe('no ./ prefix', () => {
    it('resolves folder-name/sub/file.ts', () => {
      expect(resolveOpenFilePath('backend/src/api/foo.js', FOLDERS))
        .toBe(join('/src/backend', 'src/api/foo.js'));
    });

    it('resolves exact folder name with no sub-path', () => {
      expect(resolveOpenFilePath('backend', FOLDERS))
        .toBe('/src/backend');
    });
  });

  // ── already absolute ───────────────────────────────────────────────────────
  describe('absolute paths', () => {
    it('returns absolute path unchanged (posix)', () => {
      expect(resolveOpenFilePath('/src/backend/foo.ts', FOLDERS))
        .toBe('/src/backend/foo.ts');
    });
  });

  // ── no match ───────────────────────────────────────────────────────────────
  describe('no folder match', () => {
    it('returns the original path when no folder name matches', () => {
      expect(resolveOpenFilePath('./unknown-folder/src/foo.ts', FOLDERS))
        .toBe('./unknown-folder/src/foo.ts');
    });

    it('returns empty string unchanged', () => {
      expect(resolveOpenFilePath('', FOLDERS)).toBe('');
    });
  });

  // ── backslash variant ──────────────────────────────────────────────────────
  describe('backslash separator (Windows)', () => {
    it('resolves folder-name\\sub\\file.ts', () => {
      expect(resolveOpenFilePath('backend\\src\\api\\foo.js', FOLDERS))
        .toBe(join('/src/backend', 'src', 'api', 'foo.js'));
    });
  });

  // ── primary folder is also matched ────────────────────────────────────────
  describe('primary folder', () => {
    it('resolves a path under the primary folder too', () => {
      expect(resolveOpenFilePath('./frontend/src/index.ts', FOLDERS))
        .toBe(join('/src/frontend', 'src/index.ts'));
    });
  });

  // ── prefix collision guard ─────────────────────────────────────────────────
  describe('prefix collision', () => {
    it('does not match "process" against "backend" folder', () => {
      expect(resolveOpenFilePath('./process/foo.ts', FOLDERS))
        .toBe('./process/foo.ts');
    });
  });

});
