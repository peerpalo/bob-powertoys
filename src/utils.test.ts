import { describe, it, expect } from 'vitest';
import { normaliseWorkspacePath } from './utils.js';

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
