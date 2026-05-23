/**
 * Extraction Orchestrator
 *
 * Coordinates file scanning, parsing, and database storage.
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import {
  Language,
  FileRecord,
  ExtractionResult,
  ExtractionError,
} from '../types';
import { QueryBuilder } from '../db/queries';
import { extractFromSource } from './tree-sitter';
import { detectLanguage, isSourceFile, isLanguageSupported, initGrammars, loadGrammarsForLanguages } from './grammars';
import { logDebug, logWarn } from '../errors';
import { validatePathWithinRoot, normalizePath, isPathWithinRootReal } from '../utils';
import { getCodeGraphDir } from '../directory';
import ignore, { Ignore } from 'ignore';
import { detectFrameworks } from '../resolution/frameworks';
import type { ResolutionContext } from '../resolution/types';

/**
 * Number of files to read in parallel during indexing.
 * File reads are I/O-bound; batching overlaps I/O wait with CPU parse work.
 */
const FILE_IO_BATCH_SIZE = 10;

// PARSER_RESET_INTERVAL moved to parse-worker.ts (runs in worker thread)

/**
 * Maximum time (ms) to wait for a single file to parse in the worker thread.
 * If tree-sitter hangs or WASM runs out of memory, this prevents the entire
 * indexing run from freezing. The worker is restarted after a timeout.
 */
const PARSE_TIMEOUT_MS = 10_000;

/**
 * Number of files to parse before recycling the worker thread.
 * WASM linear memory can grow but NEVER shrink (WebAssembly spec limitation).
 * The only way to reclaim tree-sitter's WASM heap is to destroy the entire
 * V8 isolate by terminating the worker thread and spawning a fresh one.
 * This interval balances memory usage against the cost of reloading grammars.
 */
const WORKER_RECYCLE_INTERVAL = 250;

/**
 * Progress callback for indexing operations
 */
export interface IndexProgress {
  phase: 'scanning' | 'parsing' | 'storing' | 'resolving';
  current: number;
  total: number;
  currentFile?: string;
}

/**
 * Result of an indexing operation
 */
export interface IndexResult {
  success: boolean;
  filesIndexed: number;
  filesSkipped: number;
  filesErrored: number;
  nodesCreated: number;
  edgesCreated: number;
  errors: ExtractionError[];
  durationMs: number;
}

export type SensitiveSkipReason = 'env-file' | 'key-file' | 'secret-like-source';
export type IndexPathSkipReason = SensitiveSkipReason | 'gitignored';

export interface ScanSafetyStats {
  sensitiveFilesSkipped: number;
  sensitiveFilesByReason: Partial<Record<SensitiveSkipReason, number>>;
}

export interface ScanDirectoryResult {
  files: string[];
  safety: ScanSafetyStats;
}

/**
 * Result of a sync operation
 */
export interface SyncResult {
  filesChecked: number;
  filesAdded: number;
  filesModified: number;
  filesRemoved: number;
  nodesUpdated: number;
  durationMs: number;
  changedFilePaths?: string[];
}

/**
 * Calculate SHA256 hash of file contents
 */
export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Skip files larger than this (bytes). Generated bundles, minified JS, and
 * vendored blobs blow the WASM heap and the worker-recycle budget for no useful
 * symbols. 1 MB covers essentially all hand-written source.
 */
const MAX_FILE_SIZE = 1024 * 1024;
const INDEX_SAFETY_STATS_METADATA_KEY = 'indexSafetyStats';

const PRIVATE_KEY_BASENAMES = new Set([
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'identity',
]);

const KEY_FILE_EXTENSIONS = new Set([
  '.key',
  '.pem',
  '.p8',
  '.p12',
  '.pfx',
]);

const SECRET_LIKE_SOURCE_BASENAME = /(^|[._-])(secret|secrets|credential|credentials|api[._-]?key|private[._-]?key)([._-]|$)/i;

function emptyScanSafetyStats(): ScanSafetyStats {
  return {
    sensitiveFilesSkipped: 0,
    sensitiveFilesByReason: {},
  };
}

function recordSensitiveSkip(stats: ScanSafetyStats, reason: SensitiveSkipReason): void {
  stats.sensitiveFilesSkipped++;
  stats.sensitiveFilesByReason[reason] = (stats.sensitiveFilesByReason[reason] ?? 0) + 1;
}

function cloneScanSafetyStats(stats: ScanSafetyStats): ScanSafetyStats {
  return {
    sensitiveFilesSkipped: stats.sensitiveFilesSkipped,
    sensitiveFilesByReason: { ...stats.sensitiveFilesByReason },
  };
}

function parseStoredScanSafetyStats(raw: string | null): ScanSafetyStats {
  if (!raw) return emptyScanSafetyStats();

  try {
    const parsed = JSON.parse(raw) as Partial<ScanSafetyStats>;
    const byReason: Partial<Record<SensitiveSkipReason, number>> = {};
    for (const reason of ['env-file', 'key-file', 'secret-like-source'] as const) {
      const value = parsed.sensitiveFilesByReason?.[reason];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        byReason[reason] = value;
      }
    }

    const total = typeof parsed.sensitiveFilesSkipped === 'number' && Number.isFinite(parsed.sensitiveFilesSkipped) && parsed.sensitiveFilesSkipped >= 0
      ? parsed.sensitiveFilesSkipped
      : Object.values(byReason).reduce((sum, count) => sum + (count ?? 0), 0);

    return {
      sensitiveFilesSkipped: total,
      sensitiveFilesByReason: byReason,
    };
  } catch {
    return emptyScanSafetyStats();
  }
}

interface IgnoreRule {
  negated: boolean;
  matcher: Ignore;
}

interface ScopedIgnore {
  dir: string;
  rules: IgnoreRule[];
}

function loadScopedIgnore(dir: string): ScopedIgnore | null {
  try {
    const giPath = path.join(dir, '.gitignore');
    if (!fs.existsSync(giPath)) return null;

    const rules: IgnoreRule[] = [];
    for (const line of fs.readFileSync(giPath, 'utf-8').split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue;
      const negated = line.startsWith('!') && line.length > 1;
      const pattern = negated ? line.slice(1) : line;
      rules.push({ negated, matcher: ignore().add(pattern) });
    }
    return { dir, rules };
  } catch {
    // Unreadable .gitignore — treat as absent.
    return null;
  }
}

function isIgnoredByScopedIgnores(fullPath: string, isDir: boolean, matchers: ScopedIgnore[]): boolean {
  let ignored = false;
  for (const { dir, rules } of matchers) {
    let rel = normalizePath(path.relative(dir, fullPath));
    if (!rel || rel.startsWith('..')) continue; // not under this matcher's dir
    if (isDir) rel += '/'; // dir-only rules (e.g. `build/`) only match with the slash
    for (const rule of rules) {
      if (rule.matcher.ignores(rel)) {
        ignored = !rule.negated;
      }
    }
  }
  return ignored;
}

function getGitIgnoredPaths(repoDir: string, filePaths: string[]): Set<string> {
  if (filePaths.length === 0) return new Set();

  try {
    const output = execFileSync(
      'git',
      ['check-ignore', '--no-index', '-z', '--stdin'],
      {
        cwd: repoDir,
        input: Buffer.from(filePaths.join('\0') + '\0', 'utf-8'),
        timeout: 30000,
        maxBuffer: 50 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );

    return new Set(
      output
        .toString('utf-8')
        .split('\0')
        .filter(Boolean)
        .map(normalizePath)
    );
  } catch {
    // git check-ignore exits 1 when no paths match. Other failures should not
    // make indexing unusable, so callers fall back to the existing visible set.
    return new Set();
  }
}

function collectGitIgnoreFilePaths(repoDir: string, prefix: string, files: Set<string>, visitedRepos = new Set<string>()): boolean {
  let realRepoDir: string;
  try {
    realRepoDir = fs.realpathSync(repoDir);
  } catch {
    return false;
  }
  if (visitedRepos.has(realRepoDir)) return true;
  visitedRepos.add(realRepoDir);

  const gitOpts = { cwd: repoDir, encoding: 'utf-8' as const, timeout: 10000, maxBuffer: 50 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] };

  try {
    const output = execFileSync('git', ['ls-files', '-c', '-o', '--exclude-standard', '--', '.gitignore', ':(glob)**/.gitignore'], gitOpts);
    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) files.add(normalizePath(prefix + trimmed));
    }

    const untracked = execFileSync('git', ['ls-files', '-o', '--exclude-standard'], gitOpts);
    const ignoredDirs = execFileSync('git', ['ls-files', '-o', '-i', '--exclude-standard', '--directory'], gitOpts);
    for (const line of `${untracked}\n${ignoredDirs}`.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.endsWith('/')) continue;

      const childDir = path.join(repoDir, trimmed);
      if (fs.existsSync(path.join(childDir, '.git'))) {
        collectGitIgnoreFilePaths(childDir, prefix + trimmed, files, visitedRepos);
      }
    }

    return true;
  } catch {
    return false;
  }
}

function getIgnoreFilePaths(rootDir: string): string[] {
  const gitFiles = new Set<string>();
  if (collectGitIgnoreFilePaths(rootDir, '', gitFiles)) {
    for (const filePath of getAncestorGitIgnoreFilePaths(rootDir)) {
      gitFiles.add(filePath);
    }
    return [...gitFiles];
  }

  const files: string[] = [];

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === '.codegraph') continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name === '.gitignore') {
        files.push(normalizePath(path.relative(rootDir, fullPath)));
      }
    }
  };

  walk(rootDir);
  return files;
}

function getAncestorGitIgnoreFilePaths(rootDir: string): string[] {
  const files: string[] = [];
  try {
    const gitRoot = execFileSync(
      'git',
      ['rev-parse', '--show-toplevel'],
      { cwd: rootDir, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    const resolvedRoot = path.resolve(rootDir);
    const resolvedGitRoot = path.resolve(gitRoot);
    if (resolvedGitRoot === resolvedRoot) return files;

    let current = resolvedRoot;
    while (current !== resolvedGitRoot) {
      const parent = path.dirname(current);
      if (parent === current) break;
      const relToGitRoot = path.relative(resolvedGitRoot, parent);
      if (relToGitRoot.startsWith('..') || path.isAbsolute(relToGitRoot)) break;

      const gitignorePath = path.join(parent, '.gitignore');
      if (fs.existsSync(gitignorePath)) {
        files.push(normalizePath(path.relative(rootDir, gitignorePath)));
      }
      current = parent;
    }
  } catch {
    // No enclosing git root; local .gitignore files are enough.
  }

  return files;
}

function getIgnoreFingerprint(rootDir: string): string {
  return getIgnoreFilePaths(rootDir)
    .sort()
    .map((filePath) => {
      try {
        const content = fs.readFileSync(path.join(rootDir, filePath));
        const hash = crypto.createHash('sha256').update(content).digest('hex');
        return `${filePath}:${hash}`;
      } catch {
        return `${filePath}:missing`;
      }
    })
    .join('|');
}

function getIgnoreFingerprintPath(rootDir: string): string {
  return path.join(getCodeGraphDir(rootDir), 'ignore-fingerprint');
}

function readStoredIgnoreFingerprint(rootDir: string): string {
  try {
    return fs.readFileSync(getIgnoreFingerprintPath(rootDir), 'utf-8');
  } catch {
    return '';
  }
}

function writeStoredIgnoreFingerprint(rootDir: string, fingerprint: string): void {
  try {
    fs.writeFileSync(getIgnoreFingerprintPath(rootDir), fingerprint, 'utf-8');
  } catch {
    // Fingerprint persistence is an optimization for incremental sync. If it
    // fails, the in-memory value still keeps the current process correct.
  }
}

/**
 * Conservative path-only safety filter for files that commonly contain raw
 * credentials. This intentionally does not inspect contents, so status output
 * can report aggregate skip counts without leaking secrets.
 */
export function getSensitiveSkipReason(filePath: string): SensitiveSkipReason | null {
  const normalized = normalizePath(filePath);
  const base = path.posix.basename(normalized).toLowerCase();
  const ext = path.posix.extname(base);

  if (base === '.env' || base.startsWith('.env.')) {
    return 'env-file';
  }

  if (PRIVATE_KEY_BASENAMES.has(base) || KEY_FILE_EXTENSIONS.has(ext) || /\.(key|pem|p8|p12|pfx)\./i.test(base)) {
    return 'key-file';
  }

  if (isSourceFile(normalized) && SECRET_LIKE_SOURCE_BASENAME.test(base)) {
    return 'secret-like-source';
  }

  return null;
}

export function isSensitivePath(filePath: string): boolean {
  return getSensitiveSkipReason(filePath) !== null;
}

function isIgnoredByIgnoreFiles(rootDir: string, relativePath: string): boolean {
  const normalized = normalizePath(
    path.isAbsolute(relativePath)
      ? path.relative(rootDir, relativePath)
      : relativePath
  );
  const fullPath = path.resolve(rootDir, normalized);
  const parent = normalizePath(path.dirname(normalized));
  const dirs = [''];

  if (parent !== '.') {
    const parts = parent.split('/').filter(Boolean);
    let acc = '';
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      dirs.push(acc);
    }
  }

  const matchers: ScopedIgnore[] = [];
  for (const dirRel of dirs) {
    const dir = path.join(rootDir, dirRel);
    const matcher = loadScopedIgnore(dir);
    if (matcher) matchers.push(matcher);
  }

  const parentParts = parent === '.' ? [] : parent.split('/').filter(Boolean);
  let ancestor = '';
  for (const part of parentParts) {
    ancestor = ancestor ? `${ancestor}/${part}` : part;
    if (isIgnoredByScopedIgnores(path.resolve(rootDir, ancestor), true, matchers)) {
      return true;
    }
  }

  return isIgnoredByScopedIgnores(fullPath, false, matchers);
}

function getRealProjectRelativePath(rootDir: string, relativePath: string): string | null {
  const fullPath = validatePathWithinRoot(rootDir, relativePath);
  if (!fullPath) return null;

  try {
    const realRoot = fs.realpathSync(rootDir);
    const realPath = fs.realpathSync(fullPath);
    const rel = path.relative(realRoot, realPath);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return normalizePath(rel);
  } catch {
    return null;
  }
}

function getGitRootFromMarkers(rootDir: string, fullPath: string): string | null {
  const resolvedRoot = path.resolve(rootDir);
  let current: string;

  try {
    const stat = fs.statSync(fullPath);
    current = stat.isDirectory() ? fullPath : path.dirname(fullPath);
  } catch {
    current = path.dirname(fullPath);
  }

  current = path.resolve(current);
  while (current === resolvedRoot || current.startsWith(resolvedRoot + path.sep)) {
    if (fs.existsSync(path.join(current, '.git'))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

function hasGitRootMarker(rootDir: string): boolean {
  return fs.existsSync(path.join(rootDir, '.git'));
}

const visibleAncestorGitRootCache = new Map<string, { fingerprint: string; visible: boolean }>();

function getAncestorIgnoreFingerprint(rootDir: string, gitRoot: string): string {
  const paths = getAncestorGitIgnoreFilePaths(rootDir)
    .map((filePath) => path.resolve(rootDir, filePath));
  const gitInfoExclude = path.join(gitRoot, '.git', 'info', 'exclude');
  if (fs.existsSync(gitInfoExclude)) {
    paths.push(gitInfoExclude);
  }

  return paths
    .sort()
    .map((filePath) => {
      try {
        const content = fs.readFileSync(filePath);
        const hash = crypto.createHash('sha256').update(content).digest('hex');
        return `${filePath}:${hash}`;
      } catch {
        return `${filePath}:missing`;
      }
    })
    .join('|');
}

function hasVisibleAncestorGitRoot(rootDir: string): boolean {
  const resolvedRoot = path.resolve(rootDir);

  let result = false;
  try {
    const gitRoot = execFileSync(
      'git',
      ['rev-parse', '--show-toplevel'],
      { cwd: rootDir, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    const resolvedGitRoot = path.resolve(gitRoot);
    if (resolvedGitRoot === resolvedRoot || resolvedGitRoot.startsWith(resolvedRoot + path.sep)) {
      visibleAncestorGitRootCache.set(resolvedRoot, { fingerprint: '', visible: false });
      return false;
    }

    const fingerprint = getAncestorIgnoreFingerprint(rootDir, resolvedGitRoot);
    const cached = visibleAncestorGitRootCache.get(resolvedRoot);
    if (cached?.fingerprint === fingerprint) return cached.visible;

    try {
      execFileSync(
        'git',
        ['check-ignore', '-q', resolvedRoot],
        { cwd: rootDir, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
      );
      result = false;
    } catch {
      result = true;
    }
    visibleAncestorGitRootCache.set(resolvedRoot, { fingerprint, visible: result });
  } catch {
    result = false;
    visibleAncestorGitRootCache.set(resolvedRoot, { fingerprint: '', visible: result });
  }

  return result;
}

function getIgnoreContext(rootDir: string, relativePath: string): { rootDir: string; relativePath: string } {
  const fullPath = validatePathWithinRoot(rootDir, relativePath);
  if (!fullPath) return { rootDir, relativePath };

  const markerRoot = getGitRootFromMarkers(rootDir, fullPath);
  if (markerRoot) {
    return {
      rootDir: markerRoot,
      relativePath: normalizePath(path.relative(markerRoot, fullPath)),
    };
  }

  return { rootDir, relativePath };
}

function getIndexPathCandidates(rootDir: string, relativePath: string): string[] {
  const fullPath = validatePathWithinRoot(rootDir, relativePath);
  const projectRelativePath = fullPath
    ? normalizePath(path.relative(rootDir, fullPath))
    : normalizePath(relativePath);
  const realProjectRelativePath = getRealProjectRelativePath(rootDir, relativePath);
  const candidatePaths = [projectRelativePath];
  if (realProjectRelativePath && realProjectRelativePath !== projectRelativePath) {
    candidatePaths.push(realProjectRelativePath);
  }
  return candidatePaths;
}

export function getIndexPathSkipReason(rootDir: string, relativePath: string): IndexPathSkipReason | null {
  const candidatePaths = getIndexPathCandidates(rootDir, relativePath);
  for (const candidatePath of candidatePaths) {
    const sensitiveReason = getSensitiveSkipReason(candidatePath);
    if (sensitiveReason) return sensitiveReason;
  }

  for (const candidatePath of candidatePaths) {
    const ignoreContext = getIgnoreContext(rootDir, candidatePath);
    if (!hasGitRootMarker(ignoreContext.rootDir) && !hasVisibleAncestorGitRoot(ignoreContext.rootDir)) continue;

    try {
      execFileSync(
        'git',
        ['check-ignore', '--no-index', '-q', '--', ignoreContext.relativePath],
        { cwd: ignoreContext.rootDir, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
      );
      return 'gitignored';
    } catch {
      // Either not ignored, not a git repo, or git unavailable. Fall back to
      // parsing .gitignore files directly so non-git projects behave the same.
    }
  }

  return candidatePaths.some((candidatePath) => {
    const ignoreContext = getIgnoreContext(rootDir, candidatePath);
    return isIgnoredByIgnoreFiles(ignoreContext.rootDir, ignoreContext.relativePath);
  })
    ? 'gitignored'
    : null;
}

/**
 * Collect git-visible files (tracked + untracked, .gitignore-respected) from the
 * git repository rooted at `repoDir`, adding each to `files` with `prefix`
 * prepended so paths stay relative to the original scan root.
 *
 * Recurses into embedded git repositories — nested repos that are NOT submodules
 * (independent clones living inside the workspace, common in CMake "super-repo"
 * layouts). The parent repo's `git ls-files` cannot see into them: tracked output
 * skips them entirely, and untracked output reports them only as an opaque
 * "subdir/" entry (trailing slash) rather than expanding their files. Each
 * embedded repo is its own git boundary, so we re-run `git ls-files` inside it.
 * (See issue #193.)
 */
function collectGitFiles(repoDir: string, prefix: string, files: Set<string>, visitedRepos = new Set<string>()): void {
  let realRepoDir: string;
  try {
    realRepoDir = fs.realpathSync(repoDir);
  } catch {
    return;
  }
  if (visitedRepos.has(realRepoDir)) return;
  visitedRepos.add(realRepoDir);

  const gitOpts = { cwd: repoDir, encoding: 'utf-8' as const, timeout: 30000, maxBuffer: 50 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] };

  // Tracked files. --recurse-submodules pulls in files from active submodules,
  // which the index would otherwise represent only as a commit pointer.
  // Without this, monorepos using submodules index 0 files. (See issue #147.)
  // Note: --recurse-submodules only supports -c/--cached and --stage modes — it
  // can't be combined with -o, so untracked files are gathered separately below.
  const tracked = execFileSync('git', ['ls-files', '-c', '--recurse-submodules'], gitOpts);
  const trackedPaths = tracked.split('\n').map((line) => line.trim()).filter(Boolean);
  const trackedByIgnoreRoot = new Map<string, { originalPath: string; ignorePath: string }[]>();
  for (const trimmed of trackedPaths) {
    const context = getIgnoreContext(repoDir, trimmed);
    const entries = trackedByIgnoreRoot.get(context.rootDir) ?? [];
    entries.push({ originalPath: trimmed, ignorePath: context.relativePath });
    trackedByIgnoreRoot.set(context.rootDir, entries);
  }

  for (const [ignoreRoot, entries] of trackedByIgnoreRoot) {
    const ignoredTracked = getGitIgnoredPaths(ignoreRoot, entries.map((entry) => entry.ignorePath));
    for (const entry of entries) {
      if (ignoredTracked.has(normalizePath(entry.ignorePath))) continue;
      files.add(normalizePath(prefix + entry.originalPath));
    }
  }

  // Untracked files (submodules manage their own untracked state). Embedded git
  // repos surface here as a single "subdir/" entry that git refuses to descend
  // into — recurse into those as their own repos so their source gets indexed.
  const untracked = execFileSync('git', ['ls-files', '-o', '--exclude-standard'], gitOpts);
  for (const line of untracked.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.endsWith('/')) {
      // git only emits a trailing-slash directory entry for an embedded repo.
      // Guard with a .git check anyway, and skip anything else exactly as git
      // itself skips it (we never descend into a non-repo opaque dir).
      const childDir = path.join(repoDir, trimmed);
      if (fs.existsSync(path.join(childDir, '.git'))) {
        collectGitFiles(childDir, prefix + trimmed, files, visitedRepos);
      }
      continue;
    }
    files.add(normalizePath(prefix + trimmed));
  }

  // If a parent .gitignore excludes the embedded repo directory itself, git
  // reports it only through the ignored-directory listing. The child repo still
  // owns its own tracked files, so recurse into those git boundaries as well.
  const ignoredDirs = execFileSync('git', ['ls-files', '-o', '-i', '--exclude-standard', '--directory'], gitOpts);
  for (const line of ignoredDirs.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.endsWith('/')) continue;

    const childDir = path.join(repoDir, trimmed);
    if (fs.existsSync(path.join(childDir, '.git'))) {
      collectGitFiles(childDir, prefix + trimmed, files, visitedRepos);
    }
  }
}

/**
 * Get all files visible to git (tracked + untracked but not ignored).
 * Respects .gitignore at all levels (root, subdirectories) and descends into
 * embedded (nested, non-submodule) git repos. Returns null on failure
 * (non-git project) so callers can fall back to a filesystem walk.
 */
function getGitVisibleFiles(rootDir: string): Set<string> | null {
  try {
    // Check if the project directory is gitignored by a parent repo.
    // When rootDir lives inside a parent git repo that ignores it,
    // `git ls-files` returns nothing — fall back to filesystem walk.
    const gitRoot = execFileSync(
      'git',
      ['rev-parse', '--show-toplevel'],
      { cwd: rootDir, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();

    if (path.resolve(gitRoot) !== path.resolve(rootDir)) {
      try {
        // git check-ignore exits 0 if the path IS ignored, 1 if not
        execFileSync(
          'git',
          ['check-ignore', '-q', path.resolve(rootDir)],
          { cwd: rootDir, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
        );
        // Directory is gitignored by parent repo — fall back to filesystem walk
        return null;
      } catch {
        // Not ignored — safe to use git ls-files
      }
    }

    const files = new Set<string>();
    collectGitFiles(rootDir, '', files);
    return files;
  } catch {
    return null;
  }
}

/**
 * Result of git-based change detection.
 * Returns null when git is unavailable (non-git project or command failure),
 * signaling the caller to fall back to full filesystem scan.
 */
interface GitChanges {
  modified: string[];  // M, MM, AM — files to re-hash + re-index
  added: string[];     // ?? — new untracked files to index
  deleted: string[];   // D — files to remove from DB
  ignoreFilesChanged: boolean; // .gitignore changes require a full visibility rescan
}

function collectNestedGitChanges(
  rootDir: string,
  repoDir: string,
  prefix: string,
  changes: GitChanges,
  visitedRepos = new Set<string>()
): void {
  let realRepoDir: string;
  try {
    realRepoDir = fs.realpathSync(repoDir);
  } catch {
    return;
  }
  if (visitedRepos.has(realRepoDir)) return;
  visitedRepos.add(realRepoDir);

  const gitOpts = { cwd: repoDir, encoding: 'utf-8' as const, timeout: 10000, maxBuffer: 50 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] };
  const output = execFileSync('git', ['status', '--porcelain=v1', '-z', '--no-renames'], gitOpts);

  for (const entry of output.split('\0')) {
    if (entry.length < 4) continue; // Minimum: "XY file"

    const statusCode = entry.substring(0, 2);
    const filePath = normalizePath(entry.substring(3));
    const projectPath = normalizePath(prefix + filePath);

    if (filePath === '.gitignore' || filePath.endsWith('/.gitignore')) {
      changes.ignoreFilesChanged = true;
      continue;
    }

    if (statusCode.includes('D')) {
      changes.deleted.push(projectPath);
    } else if (!isPathWithinRootReal(projectPath, rootDir)) {
      continue;
    } else if (getIndexPathSkipReason(rootDir, projectPath) || !isSourceFile(projectPath)) {
      // Skip non-source, gitignored, and sensitive files. Deleted files are
      // handled first so previously indexed now-excluded files can be purged.
      continue;
    } else if (statusCode === '??') {
      changes.added.push(projectPath);
    } else {
      // M, MM, AM, A (staged), etc. — treat as modified
      changes.modified.push(projectPath);
    }
  }

  // Match the git boundary discovery used by collectGitFiles(): visible
  // embedded repos appear as untracked trailing-slash entries, while repos
  // hidden by a parent .gitignore appear only in the ignored-directory list.
  const untracked = execFileSync('git', ['ls-files', '-o', '--exclude-standard'], gitOpts);
  const ignoredDirs = execFileSync('git', ['ls-files', '-o', '-i', '--exclude-standard', '--directory'], gitOpts);
  for (const line of `${untracked}\n${ignoredDirs}`.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.endsWith('/')) continue;

    const childDir = path.join(repoDir, trimmed);
    if (fs.existsSync(path.join(childDir, '.git'))) {
      collectNestedGitChanges(rootDir, childDir, normalizePath(prefix + trimmed), changes, visitedRepos);
    }
  }
}

/**
 * Use `git status` to detect changed files instead of scanning every file.
 * Returns null on failure so callers fall back to full scan.
 */
function getGitChangedFiles(rootDir: string): GitChanges | null {
  try {
    const changes: GitChanges = {
      modified: [],
      added: [],
      deleted: [],
      ignoreFilesChanged: false,
    };
    collectNestedGitChanges(rootDir, rootDir, '', changes);
    return changes;
  } catch {
    return null;
  }
}

/**
 * Recursively scan a directory for source files.
 *
 * In git repos, uses `git ls-files` (inherently respects .gitignore at all
 * levels), then keeps files with a supported source extension. For non-git
 * projects, falls back to a filesystem walk that parses .gitignore itself.
 */
export function scanDirectory(
  rootDir: string,
  onProgress?: (current: number, file: string) => void
): string[] {
  return scanDirectoryWithStats(rootDir, onProgress).files;
}

export function scanDirectoryWithStats(
  rootDir: string,
  onProgress?: (current: number, file: string) => void
): ScanDirectoryResult {
  const safety = emptyScanSafetyStats();

  // Fast path: use git to get all visible files (respects .gitignore everywhere)
  const gitFiles = getGitVisibleFiles(rootDir);
  if (gitFiles) {
    const files: string[] = [];
    let count = 0;
    const candidatePathsByFile = new Map<string, string[]>();
    for (const filePath of gitFiles) {
      if (!isPathWithinRootReal(filePath, rootDir)) continue;
      const candidatePaths = getIndexPathCandidates(rootDir, filePath);
      candidatePathsByFile.set(filePath, candidatePaths);
    }
    for (const filePath of gitFiles) {
      const candidatePaths = candidatePathsByFile.get(filePath) ?? [filePath];
      if (!candidatePathsByFile.has(filePath)) continue;
      const sensitiveReason = candidatePaths
        .map((candidatePath) => getSensitiveSkipReason(candidatePath))
        .find((reason): reason is SensitiveSkipReason => reason !== null);
      if (sensitiveReason) {
        recordSensitiveSkip(safety, sensitiveReason);
        continue;
      }
      if (candidatePaths.slice(1).some((candidatePath) => getIndexPathSkipReason(rootDir, candidatePath) === 'gitignored')) {
        continue;
      }
      if (isSourceFile(filePath)) {
        files.push(filePath);
        count++;
        onProgress?.(count, filePath);
      }
    }
    return { files, safety };
  }

  // Fallback: walk filesystem for non-git projects
  return scanDirectoryWalk(rootDir, onProgress, safety);
}

/**
 * Async variant of scanDirectory that yields to the event loop periodically,
 * allowing worker threads to receive and render progress messages.
 */
export async function scanDirectoryAsync(
  rootDir: string,
  onProgress?: (current: number, file: string) => void
): Promise<string[]> {
  return (await scanDirectoryAsyncWithStats(rootDir, onProgress)).files;
}

export async function scanDirectoryAsyncWithStats(
  rootDir: string,
  onProgress?: (current: number, file: string) => void
): Promise<ScanDirectoryResult> {
  const safety = emptyScanSafetyStats();
  const gitFiles = getGitVisibleFiles(rootDir);
  if (gitFiles) {
    const files: string[] = [];
    let count = 0;
    const candidatePathsByFile = new Map<string, string[]>();
    for (const filePath of gitFiles) {
      if (!isPathWithinRootReal(filePath, rootDir)) continue;
      const candidatePaths = getIndexPathCandidates(rootDir, filePath);
      candidatePathsByFile.set(filePath, candidatePaths);
    }
    for (const filePath of gitFiles) {
      const candidatePaths = candidatePathsByFile.get(filePath) ?? [filePath];
      if (!candidatePathsByFile.has(filePath)) continue;
      const sensitiveReason = candidatePaths
        .map((candidatePath) => getSensitiveSkipReason(candidatePath))
        .find((reason): reason is SensitiveSkipReason => reason !== null);
      if (sensitiveReason) {
        recordSensitiveSkip(safety, sensitiveReason);
        continue;
      }
      if (candidatePaths.slice(1).some((candidatePath) => getIndexPathSkipReason(rootDir, candidatePath) === 'gitignored')) {
        continue;
      }
      if (isSourceFile(filePath)) {
        files.push(filePath);
        count++;
        onProgress?.(count, filePath);
        // Yield every 100 files so worker threads can render progress
        if (count % 100 === 0) {
          await new Promise<void>(r => setImmediate(r));
        }
      }
    }
    return { files, safety };
  }

  return scanDirectoryWalk(rootDir, onProgress, safety);
}

export function getScanSafetyStats(rootDir: string): ScanSafetyStats {
  return scanDirectoryWithStats(rootDir).safety;
}

/**
 * Filesystem walk fallback for non-git projects.
 */
function scanDirectoryWalk(
  rootDir: string,
  onProgress: ((current: number, file: string) => void) | undefined,
  safety: ScanSafetyStats
): ScanDirectoryResult {
  const files: string[] = [];
  let count = 0;
  const visitedDirs = new Set<string>();
  let realRoot: string;

  try {
    realRoot = fs.realpathSync(rootDir);
  } catch {
    logDebug('Skipping unresolvable scan root', { rootDir });
    return { files, safety };
  }

  const isWithinRealRoot = (realPath: string): boolean => {
    const rel = path.relative(realRoot, realPath);
    return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
  };

  function walk(dir: string, matchers: ScopedIgnore[]): void {
    let realDir: string;
    try {
      realDir = fs.realpathSync(dir);
    } catch {
      logDebug('Skipping unresolvable directory', { dir });
      return;
    }

    if (visitedDirs.has(realDir)) {
      logDebug('Skipping already-visited directory (symlink cycle)', { dir, realDir });
      return;
    }
    if (!isWithinRealRoot(realDir)) {
      logDebug('Skipping directory outside scan root', { dir, realDir });
      return;
    }
    visitedDirs.add(realDir);

    // This directory's own .gitignore (if present) applies to everything below it.
    const own = loadScopedIgnore(dir);
    const active = own ? [...matchers, own] : matchers;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      logDebug('Skipping unreadable directory', { dir, error: String(error) });
      return;
    }

    for (const entry of entries) {
      // Never descend into git internals or our own data directory.
      if (entry.name === '.git' || entry.name === '.codegraph') continue;

      const fullPath = path.join(dir, entry.name);
      const relativePath = normalizePath(path.relative(rootDir, fullPath));

      if (entry.isSymbolicLink()) {
        try {
          const realTarget = fs.realpathSync(fullPath);
          if (!isWithinRealRoot(realTarget)) {
            logDebug('Skipping symlink outside scan root', { path: fullPath, realTarget });
            continue;
          }
          const stat = fs.statSync(realTarget);
          if (stat.isDirectory()) {
            if (!isIgnoredByScopedIgnores(fullPath, true, active) && !isIgnoredByScopedIgnores(realTarget, true, active)) {
              walk(fullPath, active);
            }
          } else if (stat.isFile()) {
            const skipReason = getIndexPathSkipReason(rootDir, relativePath);
            if (!isIgnoredByScopedIgnores(fullPath, false, active) && skipReason && skipReason !== 'gitignored') {
              recordSensitiveSkip(safety, skipReason);
            } else if (!isIgnoredByScopedIgnores(fullPath, false, active) && !skipReason && isSourceFile(relativePath)) {
              files.push(relativePath);
              count++;
              onProgress?.(count, relativePath);
            }
          }
        } catch {
          logDebug('Skipping broken symlink', { path: fullPath });
        }
        continue;
      }

      if (entry.isDirectory()) {
        if (!isIgnoredByScopedIgnores(fullPath, true, active)) {
          walk(fullPath, active);
        }
      } else if (entry.isFile()) {
        const skipReason = getIndexPathSkipReason(rootDir, relativePath);
        if (!isIgnoredByScopedIgnores(fullPath, false, active) && skipReason && skipReason !== 'gitignored') {
          recordSensitiveSkip(safety, skipReason);
        } else if (!isIgnoredByScopedIgnores(fullPath, false, active) && !skipReason && isSourceFile(relativePath)) {
          files.push(relativePath);
          count++;
          onProgress?.(count, relativePath);
        }
      }
    }
  }

  walk(rootDir, []);
  return { files, safety };
}

/**
 * Extraction orchestrator
 */
export class ExtractionOrchestrator {
  private rootDir: string;
  private queries: QueryBuilder;
  private ignoreFingerprint: string;
  private scanSafetyStats: ScanSafetyStats;
  /**
   * Names of frameworks detected for this project, populated by indexAll().
   * Passed to extractFromSource so framework-specific extractors (route nodes,
   * middleware, etc.) run after the tree-sitter pass. Cleared if detection
   * hasn't run yet so single-file re-index paths can detect on the spot.
   */
  private detectedFrameworkNames: string[] | null = null;

  constructor(rootDir: string, queries: QueryBuilder) {
    this.rootDir = rootDir;
    this.queries = queries;
    this.ignoreFingerprint = readStoredIgnoreFingerprint(rootDir);
    this.scanSafetyStats = parseStoredScanSafetyStats(this.queries.getMetadata(INDEX_SAFETY_STATS_METADATA_KEY));
  }

  private hasIgnoreRulesChanged(): boolean {
    return getIgnoreFingerprint(this.rootDir) !== this.ignoreFingerprint;
  }

  private refreshIgnoreFingerprint(): void {
    this.ignoreFingerprint = getIgnoreFingerprint(this.rootDir);
    writeStoredIgnoreFingerprint(this.rootDir, this.ignoreFingerprint);
  }

  private persistScanSafetyStats(stats: ScanSafetyStats): void {
    this.scanSafetyStats = cloneScanSafetyStats(stats);
    this.queries.setMetadata(INDEX_SAFETY_STATS_METADATA_KEY, JSON.stringify(this.scanSafetyStats));
  }

  getIndexSafetyStats(): ScanSafetyStats {
    return cloneScanSafetyStats(this.scanSafetyStats);
  }

  private getReadableProjectFilePath(relativePath: string): string | null {
    const fullPath = validatePathWithinRoot(this.rootDir, relativePath);
    if (!fullPath) return null;
    return isPathWithinRootReal(relativePath, this.rootDir) ? fullPath : null;
  }

  /**
   * Build a filesystem-backed ResolutionContext sufficient for framework
   * detection. Graph-query methods (getNodesByName etc.) return empty because
   * the DB hasn't been populated yet, but detect() only uses readFile,
   * fileExists, and getAllFiles, so that's fine.
   */
  private buildDetectionContext(files: string[]): ResolutionContext {
    const rootDir = this.rootDir;
    return {
      getNodesInFile: () => [],
      getNodesByName: () => [],
      getNodesByQualifiedName: () => [],
      getNodesByKind: () => [],
      getNodesByLowerName: () => [],
      getImportMappings: () => [],
      getAllFiles: () => files,
      getProjectRoot: () => rootDir,
      fileExists: (relativePath: string) => {
        const full = validatePathWithinRoot(rootDir, relativePath);
        if (!full) return false;
        if (!isPathWithinRootReal(relativePath, rootDir)) return false;
        try {
          return fs.existsSync(full);
        } catch {
          return false;
        }
      },
      readFile: (relativePath: string) => {
        const full = validatePathWithinRoot(rootDir, relativePath);
        if (!full) return null;
        if (!isPathWithinRootReal(relativePath, rootDir)) return null;
        try {
          return fs.readFileSync(full, 'utf-8');
        } catch {
          return null;
        }
      },
    };
  }

  /**
   * Detect frameworks on demand using the current scanned files (or a fresh
   * scan if none are provided). Cached on the orchestrator so repeat calls
   * inside a single run don't re-scan.
   */
  private ensureDetectedFrameworks(files?: string[]): string[] {
    if (this.detectedFrameworkNames !== null) return this.detectedFrameworkNames;
    const fileList = files ?? scanDirectory(this.rootDir);
    const context = this.buildDetectionContext(fileList);
    this.detectedFrameworkNames = detectFrameworks(context).map((r) => r.name);
    return this.detectedFrameworkNames;
  }

  private purgeExcludedTrackedFiles(): number {
    let removed = 0;
    const trackedFiles = this.queries.getAllFiles();
    const ignoreContexts = new Map<string, { context: { rootDir: string; relativePath: string }; trackedPath: string; realPathChanged: boolean }>();
    const pathsByIgnoreRoot = new Map<string, string[]>();

    for (const tracked of trackedFiles) {
      const normalized = normalizePath(tracked.path);
      const context = getIgnoreContext(this.rootDir, normalized);
      const realProjectRelativePath = getRealProjectRelativePath(this.rootDir, normalized);
      const realPathChanged = !!realProjectRelativePath && realProjectRelativePath !== normalized;
      ignoreContexts.set(normalized, { context, trackedPath: tracked.path, realPathChanged });
      const paths = pathsByIgnoreRoot.get(context.rootDir) ?? [];
      paths.push(context.relativePath);
      pathsByIgnoreRoot.set(context.rootDir, paths);
    }

    const ignoredByGitByRoot = new Map<string, Set<string>>();
    for (const [ignoreRoot, filePaths] of pathsByIgnoreRoot) {
      ignoredByGitByRoot.set(ignoreRoot, getGitIgnoredPaths(ignoreRoot, filePaths));
    }

    for (const tracked of trackedFiles) {
      const normalized = normalizePath(tracked.path);
      const entry = ignoreContexts.get(normalized);
      const context = entry?.context ?? getIgnoreContext(this.rootDir, normalized);
      const ignoredByGit = ignoredByGitByRoot.get(context.rootDir) ?? new Set<string>();
      if (
        !isPathWithinRootReal(normalized, this.rootDir) ||
        (entry?.realPathChanged && getIndexPathSkipReason(this.rootDir, normalized)) ||
        getSensitiveSkipReason(normalized) ||
        ignoredByGit.has(context.relativePath) ||
        isIgnoredByIgnoreFiles(context.rootDir, context.relativePath)
      ) {
        this.queries.deleteFile(tracked.path);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Index all files in the project
   */
  async indexAll(
    onProgress?: (progress: IndexProgress) => void,
    signal?: AbortSignal,
    verbose?: boolean
  ): Promise<IndexResult> {
    await initGrammars();
    const startTime = Date.now();
    const errors: ExtractionError[] = [];
    let filesIndexed = 0;
    let filesSkipped = 0;
    let filesErrored = 0;
    let totalNodes = 0;
    let totalEdges = 0;

    const log = verbose
      ? (msg: string) => { console.log(`[worker] ${msg}`); }
      : (_msg: string) => {};

    // Phase 1: Scan for files
    onProgress?.({
      phase: 'scanning',
      current: 0,
      total: 0,
    });

    const scanResult = await scanDirectoryAsyncWithStats(this.rootDir, (current, file) => {
      onProgress?.({
        phase: 'scanning',
        current,
        total: 0,
        currentFile: file,
      });
    });
    const files = scanResult.files;
    filesSkipped += scanResult.safety.sensitiveFilesSkipped;
    this.persistScanSafetyStats(scanResult.safety);
    this.purgeExcludedTrackedFiles();
    this.refreshIgnoreFingerprint();

    // Detect frameworks once per indexAll run using the scanned file list.
    // Names are passed to each parse call so framework-specific extractors
    // (route nodes, middleware, etc.) run after the tree-sitter pass.
    // Framework detection is reset each run so adding e.g. requirements.txt
    // between runs is picked up without restarting the process.
    this.detectedFrameworkNames = null;
    const frameworkNames = this.ensureDetectedFrameworks(files);

    if (signal?.aborted) {
      return {
        success: false,
        filesIndexed: 0,
        filesSkipped: 0,
        filesErrored: 0,
        nodesCreated: 0,
        edgesCreated: 0,
        errors: [{ message: 'Aborted', severity: 'error' }],
        durationMs: Date.now() - startTime,
      };
    }

    // Phase 2: Parse files in a worker thread (keeps main thread unblocked for UI)
    const total = files.length;
    let processed = 0;

    // Emit parsing phase immediately so the progress bar appears during worker setup.
    // The yield lets the shimmer worker flush the phase transition to stdout before
    // the main thread starts synchronous grammar detection work.
    onProgress?.({
      phase: 'parsing',
      current: 0,
      total,
    });
    await new Promise(resolve => setImmediate(resolve));

    // Detect needed languages and load grammars in the parse worker
    const neededLanguages = [...new Set(files.map((f) => detectLanguage(f)))];
    // .h files default to 'c' but may be C++ — ensure cpp grammar is loaded when c is needed
    if (neededLanguages.includes('c') && !neededLanguages.includes('cpp')) {
      neededLanguages.push('cpp');
    }

    // Try to use a worker thread for parsing (keeps main thread unblocked for UI).
    // Falls back to in-process parsing if the compiled worker is unavailable (e.g. tests).
    const parseWorkerPath = path.join(__dirname, 'parse-worker.js');
    const useWorker = fs.existsSync(parseWorkerPath);
    let WorkerClass: typeof import('worker_threads').Worker | null = null;

    if (useWorker) {
      const { Worker } = await import('worker_threads');
      WorkerClass = Worker;
    } else {
      // In-process fallback: load grammars locally
      await loadGrammarsForLanguages(neededLanguages);
    }

    // --- Worker lifecycle management ---
    // The worker can crash (OOM in WASM) or hang on pathological files.
    // We track pending parse promises and handle both cases:
    //   - Timeout: terminate + restart the worker, reject the timed-out request
    //   - Crash: reject all pending promises, restart for remaining files
    let parseWorker: import('worker_threads').Worker | null = null;
    let nextId = 0;
    let workerParseCount = 0;
    const pendingParses = new Map<number, {
      resolve: (result: ExtractionResult) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }>();

    function rejectAllPending(reason: string): void {
      for (const [id, pending] of pendingParses) {
        clearTimeout(pending.timer);
        pendingParses.delete(id);
        pending.reject(new Error(reason));
      }
    }

    function attachWorkerHandlers(w: import('worker_threads').Worker): void {
      w.on('message', (msg: { type: string; id?: number; result?: ExtractionResult }) => {
        if (msg.type === 'parse-result' && msg.id !== undefined) {
          const pending = pendingParses.get(msg.id);
          if (pending) {
            clearTimeout(pending.timer);
            pendingParses.delete(msg.id);
            pending.resolve(msg.result!);
          }
        }
      });

      w.on('error', (err) => {
        logWarn('Parse worker error', { error: err.message });
        rejectAllPending(`Worker error: ${err.message}`);
      });

      w.on('exit', (code) => {
        if (code !== 0 && pendingParses.size > 0) {
          logWarn('Parse worker exited unexpectedly', { code });
          rejectAllPending(`Worker exited with code ${code}`);
        }
        // Clear reference so we know to respawn, reset count so
        // the fresh worker gets a full cycle before recycling.
        if (parseWorker === w) {
          parseWorker = null;
          workerParseCount = 0;
        }
      });
    }

    async function ensureWorker(): Promise<import('worker_threads').Worker> {
      if (parseWorker) return parseWorker;
      log('Spawning new parse worker...');
      parseWorker = new WorkerClass!(parseWorkerPath);
      attachWorkerHandlers(parseWorker);

      // Load grammars in the new worker
      await new Promise<void>((resolve, reject) => {
        parseWorker!.once('message', (msg: { type: string }) => {
          if (msg.type === 'grammars-loaded') resolve();
          else reject(new Error(`Unexpected message: ${msg.type}`));
        });
        parseWorker!.postMessage({ type: 'load-grammars', languages: neededLanguages });
      });

      return parseWorker;
    }

    if (WorkerClass) {
      await ensureWorker();
    }

    /**
     * Recycle the worker thread to reclaim WASM memory.
     * Terminates the current worker and clears the reference so
     * ensureWorker() will spawn a fresh one on the next call.
     */
    function recycleWorker(): void {
      if (!parseWorker) return;
      log(`Recycling worker after ${workerParseCount} parses (heap: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB RSS)`);
      const w = parseWorker;
      parseWorker = null;
      workerParseCount = 0;
      // Fire-and-forget: worker.terminate() can hang if WASM is stuck
      w.terminate().catch(() => {});
    }

    async function requestParse(filePath: string, content: string): Promise<ExtractionResult> {
      if (!WorkerClass) {
        // In-process fallback
        return extractFromSource(
          filePath,
          content,
          detectLanguage(filePath, content),
          frameworkNames
        );
      }

      // Recycle the worker before the next parse if we've hit the threshold.
      // This destroys the WASM linear memory (which can grow but never shrink)
      // and starts a fresh worker with a clean heap.
      if (workerParseCount >= WORKER_RECYCLE_INTERVAL) {
        await recycleWorker();
      }

      const worker = await ensureWorker();
      const id = nextId++;
      workerParseCount++;

      // Scale timeout for large files: base 10s + 10s per 100KB
      const timeoutMs = PARSE_TIMEOUT_MS + Math.floor(content.length / 100_000) * 10_000;

      return new Promise<ExtractionResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingParses.delete(id);
          log(`TIMEOUT: ${filePath} exceeded ${timeoutMs}ms — killing worker`);
          // Reject FIRST — worker.terminate() can hang if WASM is stuck
          parseWorker = null;
          workerParseCount = 0;
          reject(new Error(`Parse timed out after ${timeoutMs}ms`));
          // Fire-and-forget: kill the stuck worker in the background
          worker.terminate().catch(() => {});
        }, timeoutMs);

        pendingParses.set(id, { resolve, reject, timer });
        worker.postMessage({ type: 'parse', id, filePath, content, frameworkNames });
      });
    }

    for (let i = 0; i < files.length; i += FILE_IO_BATCH_SIZE) {
      if (signal?.aborted) {
        if (parseWorker) (parseWorker as import('worker_threads').Worker).terminate().catch(() => {});
        return {
          success: false,
          filesIndexed,
          filesSkipped,
          filesErrored,
          nodesCreated: totalNodes,
          edgesCreated: totalEdges,
          errors: [{ message: 'Aborted', severity: 'error' }, ...errors],
          durationMs: Date.now() - startTime,
        };
      }

      const batch = files.slice(i, i + FILE_IO_BATCH_SIZE);

      // Read files in parallel (with path validation before any I/O)
      const fileContents = await Promise.all(
        batch.map(async (fp) => {
          try {
            const fullPath = this.getReadableProjectFilePath(fp);
            if (!fullPath) {
              logWarn('Path traversal blocked in batch reader', { filePath: fp });
              return { filePath: fp, content: null as string | null, stats: null as fs.Stats | null, error: new Error('Path traversal blocked') };
            }
            const content = await fsp.readFile(fullPath, 'utf-8');
            const stats = await fsp.stat(fullPath);
            return { filePath: fp, content, stats, error: null as Error | null };
          } catch (err) {
            return { filePath: fp, content: null as string | null, stats: null as fs.Stats | null, error: err as Error };
          }
        })
      );

      // Send to worker for parsing, store results on main thread
      for (const { filePath, content, stats, error } of fileContents) {
        if (signal?.aborted) {
          if (parseWorker) (parseWorker as import('worker_threads').Worker).terminate().catch(() => {});
          return {
            success: false,
            filesIndexed,
            filesSkipped,
            filesErrored,
            nodesCreated: totalNodes,
            edgesCreated: totalEdges,
            errors: [{ message: 'Aborted', severity: 'error' }, ...errors],
            durationMs: Date.now() - startTime,
          };
        }

        // Report progress before parsing (show current file being worked on)
        onProgress?.({
          phase: 'parsing',
          current: processed,
          total,
          currentFile: filePath,
        });

        if (error || content === null || stats === null) {
          processed++;
          filesErrored++;
          errors.push({
            message: `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
            filePath,
            severity: 'error',
            code: 'read_error',
          });
          continue;
        }

        // Honour MAX_FILE_SIZE. Without this check, vendored generated
        // headers, minified bundles, and other multi-MB files get indexed,
        // wasting WASM heap and the worker recycle budget on inputs with no
        // useful symbols. The single-file extractFile path already enforces
        // this; the bulk path used to silently skip the check.
        if (stats.size > MAX_FILE_SIZE) {
          processed++;
          filesSkipped++;
          errors.push({
            message: `File exceeds max size (${stats.size} > ${MAX_FILE_SIZE})`,
            filePath,
            severity: 'warning',
            code: 'size_exceeded',
          });
          onProgress?.({ phase: 'parsing', current: processed, total });
          continue;
        }

        // Parse in worker thread (main thread stays unblocked).
        // Wrapped in try/catch to handle worker timeouts and crashes gracefully.
        let result: ExtractionResult;
        try {
          result = await requestParse(filePath, content);
        } catch (parseErr) {
          processed++;
          filesErrored++;
          errors.push({
            message: parseErr instanceof Error ? parseErr.message : String(parseErr),
            filePath,
            severity: 'error',
            code: 'parse_error',
          });
          continue;
        }

        processed++;

        // Store in database on main thread (SQLite is not thread-safe)
        if (result.nodes.length > 0 || result.errors.length === 0) {
          const language = detectLanguage(filePath, content);
          this.storeExtractionResult(filePath, content, language, stats, result);
        }

        if (result.errors.length > 0) {
          for (const err of result.errors) {
            if (!err.filePath) err.filePath = filePath;
          }
          errors.push(...result.errors);
        }

        if (result.nodes.length > 0) {
          filesIndexed++;
          totalNodes += result.nodes.length;
          totalEdges += result.edges.length;
        } else if (result.errors.some((e) => e.severity === 'error')) {
          filesErrored++;
        } else {
          filesSkipped++;
        }
      }
    }

    // Report 100% so the progress bar doesn't hang at 99%
    onProgress?.({
      phase: 'parsing',
      current: total,
      total,
    });

    // Yield so the shimmer worker's buffered stdout writes can flush.
    // Worker thread stdout is proxied through the main thread's event loop,
    // so synchronous work here blocks the animation from rendering.
    await new Promise(resolve => setImmediate(resolve));

    // Retry pass: files that failed due to WASM memory corruption may succeed
    // on a fresh worker with a clean heap. Recycle before each attempt so
    // every file gets the absolute cleanest WASM state possible.
    const retryableErrors = errors.filter(
      (e) => e.code === 'parse_error' && e.filePath &&
        (e.message.includes('Worker exited') || e.message.includes('memory access out of bounds'))
    );

    if (retryableErrors.length > 0 && WorkerClass) {
      log(`Retrying ${retryableErrors.length} files that failed due to WASM memory errors...`);

      const stillFailing: typeof retryableErrors = [];

      for (const errEntry of retryableErrors) {
        const filePath = errEntry.filePath!;
        if (signal?.aborted) break;

        // Fresh worker for every retry — maximum WASM headroom
        recycleWorker();

        let content: string;
        try {
          const fullPath = this.getReadableProjectFilePath(filePath);
          if (!fullPath) continue;
          content = await fsp.readFile(fullPath, 'utf-8');
        } catch {
          continue;
        }

        let result: ExtractionResult;
        try {
          result = await requestParse(filePath, content);
        } catch {
          stillFailing.push(errEntry);
          continue;
        }

        if (result.nodes.length > 0 || result.errors.length === 0) {
            const language = detectLanguage(filePath, content);
            const fullPath = this.getReadableProjectFilePath(filePath);
            if (!fullPath) continue;
            const stats = await fsp.stat(fullPath);
            this.storeExtractionResult(filePath, content, language, stats, result);

          const idx = errors.indexOf(errEntry);
          if (idx >= 0) errors.splice(idx, 1);
          filesErrored--;
          filesIndexed++;
          totalNodes += result.nodes.length;
          totalEdges += result.edges.length;
          log(`Retry OK: ${filePath} (${result.nodes.length} nodes)`);
        }
      }

      // Last resort: for files that still crash on a clean worker, strip
      // comment-only lines to reduce WASM memory pressure. Many compiler
      // test files are 90%+ comments (CHECK directives) that don't contribute
      // code nodes but consume parser memory.
      if (stillFailing.length > 0) {
        log(`${stillFailing.length} files still failing — retrying with comments stripped...`);

        for (const errEntry of stillFailing) {
          const filePath = errEntry.filePath!;
          if (signal?.aborted) break;

          recycleWorker();

          let fullContent: string;
          try {
            const fullPath = this.getReadableProjectFilePath(filePath);
            if (!fullPath) continue;
            fullContent = await fsp.readFile(fullPath, 'utf-8');
          } catch {
            continue;
          }

          // Strip lines that are entirely comments (preserving line numbers
          // by replacing with empty lines so node positions stay correct)
          const stripped = fullContent
            .split('\n')
            .map(line => /^\s*\/\//.test(line) ? '' : line)
            .join('\n');

          let result: ExtractionResult;
          try {
            result = await requestParse(filePath, stripped);
          } catch {
            continue;
          }

          if (result.nodes.length > 0 || result.errors.length === 0) {
            const language = detectLanguage(filePath, fullContent);
            const fullPath = this.getReadableProjectFilePath(filePath);
            if (!fullPath) continue;
            const stats = await fsp.stat(fullPath);
            this.storeExtractionResult(filePath, fullContent, language, stats, result);

            const idx = errors.indexOf(errEntry);
            if (idx >= 0) errors.splice(idx, 1);
            filesErrored--;
            filesIndexed++;
            totalNodes += result.nodes.length;
            totalEdges += result.edges.length;
            log(`Retry (stripped) OK: ${filePath} (${result.nodes.length} nodes)`);
          }
        }
      }
    }

    // Shut down parse worker and clear any pending timers
    rejectAllPending('Indexing complete');
    if (parseWorker) {
      (parseWorker as import('worker_threads').Worker).terminate().catch(() => {});
    }

    return {
      success: filesIndexed > 0 || errors.filter((e) => e.severity === 'error').length === 0,
      filesIndexed,
      filesSkipped,
      filesErrored,
      nodesCreated: totalNodes,
      edgesCreated: totalEdges,
      errors,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Index specific files
   */
  async indexFiles(filePaths: string[]): Promise<IndexResult> {
    const startTime = Date.now();
    const errors: ExtractionError[] = [];
    let filesIndexed = 0;
    let filesSkipped = 0;
    let filesErrored = 0;
    let totalNodes = 0;
    let totalEdges = 0;

    for (const filePath of filePaths) {
      const result = await this.indexFile(filePath);

      if (result.errors.length > 0) {
        errors.push(...result.errors);
      }

      if (result.nodes.length > 0) {
        filesIndexed++;
        totalNodes += result.nodes.length;
        totalEdges += result.edges.length;
      } else if (result.errors.some((e) => e.severity === 'error')) {
        filesErrored++;
      } else {
        filesSkipped++;
      }
    }

    return {
      success: filesIndexed > 0 || errors.filter((e) => e.severity === 'error').length === 0,
      filesIndexed,
      filesSkipped,
      filesErrored,
      nodesCreated: totalNodes,
      edgesCreated: totalEdges,
      errors,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Index a single file
   */
  async indexFile(relativePath: string): Promise<ExtractionResult> {
    const fullPath = this.getReadableProjectFilePath(relativePath);

    if (!fullPath) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [{ message: `Path traversal blocked: ${relativePath}`, filePath: relativePath, severity: 'error', code: 'path_traversal' }],
        durationMs: 0,
      };
    }

    const projectRelativePath = normalizePath(path.relative(this.rootDir, fullPath));
    const skipReason = getIndexPathSkipReason(this.rootDir, projectRelativePath);
    if (skipReason) {
      this.queries.deleteFile(projectRelativePath);
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [
          {
            message: `Skipped excluded file path (${skipReason})`,
            severity: 'warning',
            code: skipReason === 'gitignored' ? 'gitignored_path_skipped' : 'sensitive_path_skipped',
          },
        ],
        durationMs: 0,
      };
    }

    // Read file content and stats
    let content: string;
    let stats: fs.Stats;
    try {
      stats = await fsp.stat(fullPath);
      content = await fsp.readFile(fullPath, 'utf-8');
    } catch (error) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [
          {
            message: `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
            filePath: relativePath,
            severity: 'error',
            code: 'read_error',
          },
        ],
        durationMs: 0,
      };
    }

    return this.indexFileWithContent(projectRelativePath, content, stats);
  }

  /**
   * Index a single file with pre-read content and stats.
   * Used by the parallel batch reader to avoid redundant file I/O.
   */
  async indexFileWithContent(
    relativePath: string,
    content: string,
    stats: fs.Stats
  ): Promise<ExtractionResult> {
    // Prevent path traversal
    const fullPath = this.getReadableProjectFilePath(relativePath);
    if (!fullPath) {
      logWarn('Path traversal blocked in indexFileWithContent', { relativePath });
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [{ message: 'Path traversal blocked', filePath: relativePath, severity: 'error', code: 'path_traversal' }],
        durationMs: 0,
      };
    }

    const projectRelativePath = normalizePath(path.relative(this.rootDir, fullPath));
    const skipReason = getIndexPathSkipReason(this.rootDir, projectRelativePath);
    if (skipReason) {
      this.queries.deleteFile(projectRelativePath);
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [
          {
            message: `Skipped excluded file path (${skipReason})`,
            severity: 'warning',
            code: skipReason === 'gitignored' ? 'gitignored_path_skipped' : 'sensitive_path_skipped',
          },
        ],
        durationMs: 0,
      };
    }

    // Check file size
    if (stats.size > MAX_FILE_SIZE) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [
          {
            message: `File exceeds max size (${stats.size} > ${MAX_FILE_SIZE})`,
            filePath: projectRelativePath,
            severity: 'warning',
            code: 'size_exceeded',
          },
        ],
        durationMs: 0,
      };
    }

    // Detect language
    const language = detectLanguage(projectRelativePath, content);
    if (!isLanguageSupported(language)) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [],
        durationMs: 0,
      };
    }

    // Extract from source. Use cached framework names if indexAll has run,
    // otherwise detect on the spot so single-file re-index paths still emit
    // route nodes / middleware / etc.
    const frameworkNames = this.ensureDetectedFrameworks();
    const result = extractFromSource(projectRelativePath, content, language, frameworkNames);

    // Store in database
    if (result.nodes.length > 0 || result.errors.length === 0) {
      this.storeExtractionResult(projectRelativePath, content, language, stats, result);
    }

    return result;
  }

  /**
   * Store extraction result in database
   */
  private storeExtractionResult(
    filePath: string,
    content: string,
    language: Language,
    stats: fs.Stats,
    result: ExtractionResult
  ): void {
    const contentHash = hashContent(content);

    // Check if file already exists and hasn't changed
    const existingFile = this.queries.getFileByPath(filePath);
    if (existingFile && existingFile.contentHash === contentHash) {
      return; // No changes
    }

    // Delete existing data for this file
    if (existingFile) {
      this.queries.deleteFile(filePath);
    }

    // Filter out nodes with missing required fields before insertion.
    // This prevents FK violations when edges reference nodes that would
    // be silently skipped by insertNode() (see issue #42).
    const validNodes = result.nodes.filter((n) => n.id && n.kind && n.name && n.filePath && n.language);

    // Insert nodes
    if (validNodes.length > 0) {
      this.queries.insertNodes(validNodes);
    }

    // Filter edges to only reference nodes that were actually inserted
    if (result.edges.length > 0) {
      const insertedIds = new Set(validNodes.map((n) => n.id));
      const validEdges = result.edges.filter(
        (e) => insertedIds.has(e.source) && insertedIds.has(e.target)
      );
      if (validEdges.length > 0) {
        this.queries.insertEdges(validEdges);
      }
    }

    // Insert unresolved references in batch with denormalized filePath/language
    if (result.unresolvedReferences.length > 0) {
      const insertedIds = new Set(validNodes.map((n) => n.id));
      const refsWithContext = result.unresolvedReferences
        .filter((ref) => insertedIds.has(ref.fromNodeId))
        .map((ref) => ({
          ...ref,
          filePath: ref.filePath ?? filePath,
          language: ref.language ?? language,
        }));
      if (refsWithContext.length > 0) {
        this.queries.insertUnresolvedRefsBatch(refsWithContext);
      }
    }

    // Insert file record
    const fileRecord: FileRecord = {
      path: filePath,
      contentHash,
      language,
      size: stats.size,
      modifiedAt: stats.mtimeMs,
      indexedAt: Date.now(),
      nodeCount: result.nodes.length,
      errors: result.errors.length > 0 ? result.errors : undefined,
    };
    this.queries.upsertFile(fileRecord);
  }

  /**
   * Sync with current file state.
   * Uses git status as a fast path when available, falling back to full scan.
   */
  async sync(onProgress?: (progress: IndexProgress) => void): Promise<SyncResult> {
    await initGrammars(); // Initialize WASM runtime (grammars loaded lazily below)
    const startTime = Date.now();
    let filesChecked = 0;
    let filesAdded = 0;
    let filesModified = 0;
    let filesRemoved = 0;
    let nodesUpdated = 0;
    const changedFilePaths: string[] = [];

    onProgress?.({
      phase: 'scanning',
      current: 0,
      total: 0,
    });

    const filesToIndex: string[] = [];
    filesRemoved += this.purgeExcludedTrackedFiles();
    const gitChanges = getGitChangedFiles(this.rootDir);

    if (gitChanges && !gitChanges.ignoreFilesChanged && !this.hasIgnoreRulesChanged()) {
      // === Git fast path ===
      // Only inspect the files git reports as changed instead of scanning everything.
      filesChecked = gitChanges.modified.length + gitChanges.added.length + gitChanges.deleted.length;

      // Handle deleted files
      for (const filePath of gitChanges.deleted) {
        const tracked = this.queries.getFileByPath(filePath);
        if (tracked) {
          this.queries.deleteFile(filePath);
          filesRemoved++;
        }
      }

      // Handle modified + added files — read + hash only these. Untracked
      // (`??`) files stay untracked in git even after we index them, so they
      // can't be trusted as "new": re-hash and compare against the DB exactly
      // like modified files. Otherwise every sync re-indexes them and status
      // reports them as pending forever. (See issue #206.)
      for (const filePath of [...gitChanges.modified, ...gitChanges.added]) {
        const fullPath = this.getReadableProjectFilePath(filePath);
        if (!fullPath) {
          logDebug('Skipping path outside project root during sync', { filePath });
          continue;
        }
        let content: string;
        try {
          content = fs.readFileSync(fullPath, 'utf-8');
        } catch (error) {
          logDebug('Skipping unreadable file during sync', { filePath, error: String(error) });
          continue;
        }

        const contentHash = hashContent(content);
        const tracked = this.queries.getFileByPath(filePath);

        if (!tracked) {
          filesToIndex.push(filePath);
          changedFilePaths.push(filePath);
          filesAdded++;
        } else if (tracked.contentHash !== contentHash) {
          filesToIndex.push(filePath);
          changedFilePaths.push(filePath);
          filesModified++;
        }
      }
    } else {
      // === Fallback: full scan (non-git project or git failure) ===
      const scanResult = scanDirectoryWithStats(this.rootDir);
      this.persistScanSafetyStats(scanResult.safety);
      const currentFiles = new Set(scanResult.files);
      filesChecked = currentFiles.size;

      // Build Map for O(1) lookups instead of .find() per file
      const trackedFiles = this.queries.getAllFiles();
      const trackedMap = new Map<string, FileRecord>();
      for (const f of trackedFiles) {
        trackedMap.set(f.path, f);
      }

      // Find files to remove (in DB but not on disk)
      for (const tracked of trackedFiles) {
        if (!currentFiles.has(tracked.path)) {
          this.queries.deleteFile(tracked.path);
          filesRemoved++;
        }
      }

      // Find files to add or update
      for (const filePath of currentFiles) {
        const fullPath = this.getReadableProjectFilePath(filePath);
        if (!fullPath) {
          logDebug('Skipping path outside project root during sync', { filePath });
          continue;
        }
        let content: string;
        try {
          content = fs.readFileSync(fullPath, 'utf-8');
        } catch (error) {
          logDebug('Skipping unreadable file during sync', { filePath, error: String(error) });
          continue;
        }

        const contentHash = hashContent(content);
        const tracked = trackedMap.get(filePath);

        if (!tracked) {
          filesToIndex.push(filePath);
          changedFilePaths.push(filePath);
          filesAdded++;
        } else if (tracked.contentHash !== contentHash) {
          filesToIndex.push(filePath);
          changedFilePaths.push(filePath);
          filesModified++;
        }
      }
    }
    this.refreshIgnoreFingerprint();

    // Load only grammars needed for changed files
    if (filesToIndex.length > 0) {
      const neededLanguages = [...new Set(filesToIndex.map((f) => detectLanguage(f)))];
      // .h files default to 'c' but may be C++ — ensure cpp grammar is loaded
      if (neededLanguages.includes('c') && !neededLanguages.includes('cpp')) {
        neededLanguages.push('cpp');
      }
      await loadGrammarsForLanguages(neededLanguages);
    }

    // Index changed files
    const total = filesToIndex.length;
    for (let i = 0; i < filesToIndex.length; i++) {
      const filePath = filesToIndex[i]!;
      onProgress?.({
        phase: 'parsing',
        current: i + 1,
        total,
        currentFile: filePath,
      });

      const result = await this.indexFile(filePath);
      nodesUpdated += result.nodes.length;
    }

    return {
      filesChecked,
      filesAdded,
      filesModified,
      filesRemoved,
      nodesUpdated,
      durationMs: Date.now() - startTime,
      changedFilePaths: changedFilePaths.length > 0 ? changedFilePaths : undefined,
    };
  }

  /**
   * Get files that have changed since last index.
   * Uses git status as a fast path when available, falling back to full scan.
   */
  getChangedFiles(): { added: string[]; modified: string[]; removed: string[] } {
    const gitChanges = getGitChangedFiles(this.rootDir);

    if (gitChanges && !gitChanges.ignoreFilesChanged && !this.hasIgnoreRulesChanged()) {
      // === Git fast path ===
      const added: string[] = [];
      const modified: string[] = [];
      const removed: string[] = [];

      // Deleted files — only report if tracked in DB
      for (const filePath of gitChanges.deleted) {
        const tracked = this.queries.getFileByPath(filePath);
        if (tracked) {
          removed.push(filePath);
        }
      }

      // Modified + added files — read + hash, compare with DB. Untracked (`??`)
      // files stay untracked in git even after indexing, so they must be
      // hash-compared like modified files instead of always counting as added —
      // otherwise status reports them as pending forever. (See issue #206.)
      for (const filePath of [...gitChanges.modified, ...gitChanges.added]) {
        const fullPath = this.getReadableProjectFilePath(filePath);
        if (!fullPath) {
          logDebug('Skipping path outside project root while detecting changes', { filePath });
          continue;
        }
        let content: string;
        try {
          content = fs.readFileSync(fullPath, 'utf-8');
        } catch (error) {
          logDebug('Skipping unreadable file while detecting changes', { filePath, error: String(error) });
          continue;
        }

        const contentHash = hashContent(content);
        const tracked = this.queries.getFileByPath(filePath);

        if (!tracked) {
          added.push(filePath);
        } else if (tracked.contentHash !== contentHash) {
          modified.push(filePath);
        }
      }

      return { added, modified, removed };
    }

    // === Fallback: full scan (non-git project or git failure) ===
    const currentFiles = new Set(scanDirectory(this.rootDir));
    const trackedFiles = this.queries.getAllFiles();

    // Build Map for O(1) lookups
    const trackedMap = new Map<string, FileRecord>();
    for (const f of trackedFiles) {
      trackedMap.set(f.path, f);
    }

    const added: string[] = [];
    const modified: string[] = [];
    const removed: string[] = [];

    // Find removed files
    for (const tracked of trackedFiles) {
      if (!currentFiles.has(tracked.path)) {
        removed.push(tracked.path);
      }
    }

    // Find added and modified files
    for (const filePath of currentFiles) {
      const fullPath = this.getReadableProjectFilePath(filePath);
      if (!fullPath) {
        logDebug('Skipping path outside project root while detecting changes', { filePath });
        continue;
      }
      let content: string;
      try {
        content = fs.readFileSync(fullPath, 'utf-8');
      } catch (error) {
        logDebug('Skipping unreadable file while detecting changes', { filePath, error: String(error) });
        continue;
      }

      const contentHash = hashContent(content);
      const tracked = trackedMap.get(filePath);

      if (!tracked) {
        added.push(filePath);
      } else if (tracked.contentHash !== contentHash) {
        modified.push(filePath);
      }
    }

    return { added, modified, removed };
  }
}

// Re-export useful types and functions
export { extractFromSource } from './tree-sitter';
export { detectLanguage, isSourceFile, isLanguageSupported, isGrammarLoaded, getSupportedLanguages, initGrammars, loadGrammarsForLanguages, loadAllGrammars } from './grammars';
