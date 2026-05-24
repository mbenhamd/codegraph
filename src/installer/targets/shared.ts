/**
 * Helpers shared across `AgentTarget` implementations.
 *
 * Lifted from the original `config-writer.ts` so each target can
 * compose them without inheritance. Kept deliberately small — the
 * targets are different enough (JSON vs TOML vs Markdown, varying
 * idempotency markers) that a base class would force the awkward
 * shape onto everyone.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * The MCP-server config block codegraph injects. Same shape across
 * all JSON-shaped agent configs (Claude, Cursor, opencode), only the
 * surrounding wrapper differs. Codex (TOML) builds its own block.
 */
export function getMcpServerConfig(): { type: string; command: string; args: string[] } {
  return {
    type: 'stdio',
    command: 'codegraph',
    args: ['serve', '--mcp'],
  };
}

/**
 * Permissions list for Claude `settings.json`. Other targets that
 * have a permissions concept can compose this list directly. The
 * permission strings follow Claude's `mcp__<server>__<tool>` format.
 */
export function getCodeGraphPermissions(): string[] {
  return [
    'mcp__codegraph__codegraph_search',
    'mcp__codegraph__codegraph_context',
    'mcp__codegraph__codegraph_callers',
    'mcp__codegraph__codegraph_callees',
    'mcp__codegraph__codegraph_impact',
    'mcp__codegraph__codegraph_node',
    'mcp__codegraph__codegraph_explore',
    'mcp__codegraph__codegraph_files',
    'mcp__codegraph__codegraph_status',
  ];
}

/**
 * Read a JSON file, returning `{}` when missing or unparseable.
 *
 * Unparseable files are backed up to `<path>.backup` BEFORE we return
 * `{}` — so an idempotent re-run never silently deletes a user's
 * existing config that happened to break JSON parse temporarily.
 */
export function readJsonFile(filePath: string): Record<string, any> {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  Warning: Could not parse ${path.basename(filePath)}: ${msg}`);
    console.warn(`  A backup will be created before overwriting.`);
    try {
      fs.copyFileSync(filePath, filePath + '.backup');
    } catch { /* ignore backup failure */ }
    return {};
  }
}

/**
 * PF-627: extension used for the proactive pre-install backup. Kept
 * deliberately distinct from the `.backup` suffix `readJsonFile`
 * writes on JSON parse failure — that one is a defensive copy of a
 * file we're about to overwrite with `{}`, while this one captures
 * the user's pristine pre-install state so a future
 * `restore-from-backup` uninstall path (or a manual recovery) can
 * roll back what codegraph installed.
 */
export const PREINSTALL_BACKUP_SUFFIX = '.codegraph.bak';

/**
 * Snapshot `filePath` to `<filePath>.codegraph.bak` BEFORE the first
 * install touches it. Idempotent: the backup is only created when
 * the target file exists AND a backup doesn't already exist — so a
 * repeat install (codegraph upgrade self-heal) NEVER overwrites the
 * pristine snapshot with the post-install state.
 *
 * Returns the backup path on creation, `null` when no backup was
 * needed (file missing) or attempted (backup already exists). Never
 * throws on I/O failure: a failed backup must not block the install
 * itself, which is what users came for. Errors are logged so a real
 * filesystem problem isn't silently swallowed.
 */
export function backupBeforeInstall(
  filePath: string,
): { backupPath: string; created: boolean } | null {
  if (!fs.existsSync(filePath)) return null;
  const backupPath = filePath + PREINSTALL_BACKUP_SUFFIX;
  if (fs.existsSync(backupPath)) {
    // Pristine snapshot already captured on the first install. Don't
    // re-snapshot — the current file state already includes our
    // installed changes.
    return { backupPath, created: false };
  }
  try {
    fs.copyFileSync(filePath, backupPath);
    return { backupPath, created: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `  Warning: Could not create pre-install backup ${path.basename(backupPath)}: ${msg}`,
    );
    return null;
  }
}

/**
 * Write a file atomically: write to `<path>.tmp.<pid>`, then rename.
 *
 * Prevents corruption if the process crashes mid-write. The temp
 * file is cleaned up on rename failure.
 *
 * NB: this primitive does NOT take a pre-install backup. Both install
 * AND uninstall code paths call it; auto-backup here would snapshot
 * codegraph-mutated content during uninstall and poison the future
 * restore contract. Install-only callers should call
 * `backupBeforeInstall(filePath)` first, or use
 * `writeJsonFileForInstall` / `replaceOrAppendMarkedSection`, which
 * back up explicitly.
 */
export function atomicWriteFileSync(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = filePath + '.tmp.' + process.pid;
  try {
    fs.writeFileSync(tmpPath, content);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Atomic JSON write. Trailing newline matches the convention every
 * existing target had — preserves diff-friendly file shape.
 *
 * Used by BOTH install and uninstall code paths (uninstall writes
 * the cleaned config back). Callers on the install side should use
 * `writeJsonFileForInstall` instead so the user's pristine
 * pre-install state is snapshotted to `.codegraph.bak` before the
 * first overwrite.
 */
export function writeJsonFile(filePath: string, data: Record<string, any>): void {
  atomicWriteFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

/**
 * PF-627: install-only JSON writer. Snapshots `filePath` to
 * `<filePath>.codegraph.bak` (idempotent — see
 * `backupBeforeInstall`), then performs the same atomic JSON write
 * as `writeJsonFile`. Use this from install paths so a user's
 * pristine pre-install config is recoverable; use `writeJsonFile`
 * (no backup) from uninstall paths where the on-disk content is
 * already codegraph-mutated and backing it up would poison restore.
 */
export function writeJsonFileForInstall(
  filePath: string,
  data: Record<string, any>,
): void {
  backupBeforeInstall(filePath);
  atomicWriteFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

/**
 * Compare two JSON values for deep equality, ignoring key order.
 *
 * Used for idempotency: when the on-disk config already exactly
 * matches what we'd write, return action=`unchanged` instead of
 * re-writing (and emitting a confusing "Updated" log line).
 */
export function jsonDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => jsonDeepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).sort();
  const bk = Object.keys(bo).sort();
  if (ak.length !== bk.length) return false;
  if (!ak.every((k, i) => k === bk[i])) return false;
  return ak.every((k) => jsonDeepEqual(ao[k], bo[k]));
}

/**
 * Replace or append a marker-delimited section in a markdown-ish file.
 *
 * Used by Claude / Codex for the `<!-- CODEGRAPH_START --> ... <!--
 * CODEGRAPH_END -->` block. Preserves all content outside the
 * markers verbatim.
 *
 * Returns `created` when the file didn't exist; `updated` when
 * markers were found and content swapped; `appended` when markers
 * weren't found and section was added at end. `unchanged` when the
 * existing block already matches `body`.
 */
export function replaceOrAppendMarkedSection(
  filePath: string,
  body: string,
  startMarker: string,
  endMarker: string,
): 'created' | 'updated' | 'appended' | 'unchanged' {
  if (!fs.existsSync(filePath)) {
    atomicWriteFileSync(filePath, body + '\n');
    return 'created';
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const startIdx = content.indexOf(startMarker);
  const endIdx = content.indexOf(endMarker);

  if (startIdx !== -1 && endIdx > startIdx) {
    const existingBlock = content.substring(startIdx, endIdx + endMarker.length);
    if (existingBlock === body) {
      return 'unchanged';
    }
    // PF-627: install-only function — backup the pristine pre-install
    // state before the first overwrite (idempotent on re-install).
    backupBeforeInstall(filePath);
    const before = content.substring(0, startIdx);
    const after = content.substring(endIdx + endMarker.length);
    atomicWriteFileSync(filePath, before + body + after);
    return 'updated';
  }

  // No markers — append. Preserve existing content with a separating
  // blank line.
  // PF-627: install-only path — same backup rationale as above.
  backupBeforeInstall(filePath);
  const trimmed = content.trimEnd();
  const sep = trimmed.length > 0 ? '\n\n' : '';
  atomicWriteFileSync(filePath, trimmed + sep + body + '\n');
  return 'appended';
}

/**
 * Inverse of `replaceOrAppendMarkedSection`. Strips the marker
 * block from `filePath` if present. If the file becomes empty after
 * removal, deletes the file entirely (matches the existing Claude
 * uninstall behavior).
 *
 * Returns `removed` when content was stripped, `not-found` when
 * the markers weren't present, `kept` when the file didn't exist.
 */
export function removeMarkedSection(
  filePath: string,
  startMarker: string,
  endMarker: string,
): 'removed' | 'not-found' | 'kept' {
  if (!fs.existsSync(filePath)) return 'kept';

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return 'kept';
  }

  const startIdx = content.indexOf(startMarker);
  const endIdx = content.indexOf(endMarker);
  if (startIdx === -1 || endIdx <= startIdx) return 'not-found';

  const before = content.substring(0, startIdx).trimEnd();
  const after = content.substring(endIdx + endMarker.length).trimStart();
  const joined = before + (before && after ? '\n\n' : '') + after;

  if (joined.trim() === '') {
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
  } else {
    atomicWriteFileSync(filePath, joined.trim() + '\n');
  }
  return 'removed';
}
