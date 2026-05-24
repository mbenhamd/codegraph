/**
 * PF-627: proactive pre-install backup primitive tests.
 *
 * The installer used to back up a file ONLY when its JSON was
 * unparseable (defensive copy before overwriting with `{}`). That
 * left a user's pristine, parseable config silently overwritten on
 * first install with no recovery path. `backupBeforeInstall` now
 * captures `<filePath>.codegraph.bak` BEFORE the first install
 * write touches the file, so a future `restore-from-backup`
 * uninstall (or manual recovery) can roll back what codegraph
 * installed.
 *
 * Locks four behaviors:
 *   1. First write on an existing file creates `.codegraph.bak`
 *      capturing the pristine pre-install content.
 *   2. Re-install does NOT overwrite the snapshot — the pristine
 *      state stays pristine even after multiple codegraph upgrades.
 *   3. First write on a NEW file (the file didn't exist) creates
 *      no backup — there was nothing to back up.
 *   4. The backup is byte-for-byte identical to the original.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  atomicWriteFileSync,
  backupBeforeInstall,
  writeJsonFile,
  writeJsonFileForInstall,
  PREINSTALL_BACKUP_SUFFIX,
} from '../src/installer/targets/shared';

describe('PF-627: pre-install backup primitive', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-pf627-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('backupBeforeInstall direct', () => {
    it('creates <path>.codegraph.bak when the file exists', () => {
      const filePath = path.join(tmpDir, 'config.json');
      const pristine = '{"existing":"user-config","unrelated":42}\n';
      fs.writeFileSync(filePath, pristine, 'utf8');

      const result = backupBeforeInstall(filePath);

      expect(result).not.toBeNull();
      expect(result!.created).toBe(true);
      expect(result!.backupPath).toBe(filePath + PREINSTALL_BACKUP_SUFFIX);
      expect(fs.existsSync(result!.backupPath)).toBe(true);
      expect(fs.readFileSync(result!.backupPath, 'utf8')).toBe(pristine);
    });

    it('returns null when the source file does not exist', () => {
      const filePath = path.join(tmpDir, 'missing.json');
      const result = backupBeforeInstall(filePath);
      expect(result).toBeNull();
      expect(fs.existsSync(filePath + PREINSTALL_BACKUP_SUFFIX)).toBe(false);
    });

    it('is idempotent: a second call does NOT overwrite the snapshot', () => {
      const filePath = path.join(tmpDir, 'config.json');
      const pristine = '{"version":1}\n';
      fs.writeFileSync(filePath, pristine, 'utf8');

      const first = backupBeforeInstall(filePath);
      expect(first!.created).toBe(true);
      expect(fs.readFileSync(first!.backupPath, 'utf8')).toBe(pristine);

      // Simulate a write between calls — the file is no longer pristine.
      const postInstall = '{"version":1,"codegraph":true}\n';
      fs.writeFileSync(filePath, postInstall, 'utf8');

      const second = backupBeforeInstall(filePath);
      expect(second).not.toBeNull();
      expect(second!.created).toBe(false);
      expect(second!.backupPath).toBe(first!.backupPath);
      // Pristine content preserved — this is the whole point.
      expect(fs.readFileSync(first!.backupPath, 'utf8')).toBe(pristine);
    });

    it('logs a warning and returns null when copyFileSync fails — install must not be blocked', async () => {
      // Force a real copyFileSync failure by passing a directory as
      // the source path. fs.existsSync returns true for a directory,
      // so backupBeforeInstall proceeds past its existence guard, and
      // fs.copyFileSync then throws EISDIR because it cannot copy a
      // directory entry. Works on every platform and is unaffected
      // by uid/permission quirks (e.g. root bypassing mode bits).
      //
      // This guarantee is policy-sensitive: a failed backup must
      // NEVER stop the install itself (which is what users came for).
      const vitestMod = await import('vitest');
      const dirAsSource = fs.mkdtempSync(path.join(tmpDir, 'dir-source-'));
      expect(fs.existsSync(dirAsSource)).toBe(true);
      expect(fs.statSync(dirAsSource).isDirectory()).toBe(true);

      const warnSpy = vitestMod.vi.spyOn(console, 'warn').mockImplementation(() => { /* noop */ });
      try {
        const result = backupBeforeInstall(dirAsSource);
        expect(result).toBeNull();
        expect(warnSpy).toHaveBeenCalled();
        const msg = String(warnSpy.mock.calls[0]![0]);
        expect(msg).toMatch(/Could not create pre-install backup/);
        // The original error message bubbles through so a real
        // filesystem failure stays diagnosable from the log.
        expect(msg).toMatch(/EISDIR|illegal operation|directory/i);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe('writeJsonFileForInstall (install-only write)', () => {
    it('snapshots pristine content BEFORE the install-write overwrites an existing file', () => {
      const filePath = path.join(tmpDir, 'mcp.json');
      const pristine = '{"mcpServers":{"some-other":{"command":"x"}}}\n';
      fs.writeFileSync(filePath, pristine, 'utf8');

      writeJsonFileForInstall(filePath, {
        mcpServers: { codegraph: { command: 'codegraph' } },
      });

      const backupPath = filePath + PREINSTALL_BACKUP_SUFFIX;
      expect(fs.existsSync(backupPath)).toBe(true);
      expect(fs.readFileSync(backupPath, 'utf8')).toBe(pristine);
    });

    it('does NOT create a backup when writing a brand-new file', () => {
      const filePath = path.join(tmpDir, 'new-config.json');
      expect(fs.existsSync(filePath)).toBe(false);

      writeJsonFileForInstall(filePath, { created: 'by codegraph' });

      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.existsSync(filePath + PREINSTALL_BACKUP_SUFFIX)).toBe(false);
    });

    it('preserves the pristine snapshot across multiple install-writes (upgrade self-heal)', () => {
      const filePath = path.join(tmpDir, 'settings.json');
      const pristine = '{"theme":"dark","keybindings":{"x":"y"}}\n';
      fs.writeFileSync(filePath, pristine, 'utf8');

      writeJsonFileForInstall(filePath, { theme: 'dark', codegraph: 1 });
      writeJsonFileForInstall(filePath, { theme: 'dark', codegraph: 2 });
      writeJsonFileForInstall(filePath, { theme: 'dark', codegraph: 3 });

      const backupPath = filePath + PREINSTALL_BACKUP_SUFFIX;
      expect(fs.readFileSync(backupPath, 'utf8')).toBe(pristine);
    });
  });

  describe('writeJsonFile / atomicWriteFileSync (no auto-backup — uninstall safe)', () => {
    // Codex pass 1 BLOCKER regression: backing up inside
    // atomicWriteFileSync would snapshot codegraph-mutated content
    // during uninstall (which writes the cleaned config back through
    // the same primitive), poisoning the future restore contract.
    // The non-`*ForInstall` writers must NOT create a backup.

    it('writeJsonFile does NOT create a backup (used by uninstall write-back)', () => {
      const filePath = path.join(tmpDir, 'mcp.json');
      // Simulate the uninstall scenario: file already exists with
      // codegraph-mutated content; uninstall is about to write the
      // cleaned content back.
      const mutated = '{"mcpServers":{"codegraph":{"command":"x"}}}\n';
      fs.writeFileSync(filePath, mutated, 'utf8');

      writeJsonFile(filePath, { mcpServers: {} });

      expect(fs.existsSync(filePath + PREINSTALL_BACKUP_SUFFIX)).toBe(false);
    });

    it('atomicWriteFileSync does NOT create a backup (uninstall code paths use it directly)', () => {
      const filePath = path.join(tmpDir, 'config.toml');
      const mutated = '[mcp.codegraph]\ncommand = "x"\n';
      fs.writeFileSync(filePath, mutated, 'utf8');

      atomicWriteFileSync(filePath, '');

      expect(fs.existsSync(filePath + PREINSTALL_BACKUP_SUFFIX)).toBe(false);
    });
  });
});
