#!/usr/bin/env node
/**
 * CodeGraph CLI
 *
 * Command-line interface for CodeGraph code intelligence.
 *
 * Usage:
 *   codegraph                    Run interactive installer (when no args)
 *   codegraph install            Run interactive installer
 *   codegraph uninstall          Remove CodeGraph from your agents
 *   codegraph init [path]        Initialize CodeGraph in a project
 *   codegraph uninit [path]      Remove CodeGraph from a project
 *   codegraph index [path]       Index all files in the project
 *   codegraph sync [path]        Sync changes since last index
 *   codegraph status [path]      Show index status
 *   codegraph inventory [path]   Summarize rewrite-relevant repo artifacts
 *   codegraph benchmark [path]   Measure index and query latency
 *   codegraph query <search>     Search for symbols
 *   codegraph files [options]    Show project file structure
 *   codegraph context <task>     Build context for a task
 *   codegraph callers <symbol>   Find what calls a function/method
 *   codegraph callees <symbol>   Find what a function/method calls
 *   codegraph impact <symbol>    Analyze what code is affected by changing a symbol
 *   codegraph affected [files]   Find test files affected by changes
 *   codegraph diff <old> <new>   Structural diff between two indexed DBs
 */

import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import { getCodeGraphDir, isInitialized } from '../directory';
import { cliJsonEnvelope } from '../cli-json-envelope';
import {
  extractEdgeProvenance,
  formatEdgeProvenance,
  summarizeLowConfidenceEdges,
  type LowConfidenceSummary,
} from '../edge-provenance';
import type { Edge } from '../types';
import { createShimmerProgress } from '../ui/shimmer-progress';
import { getGlyphs } from '../ui/glyphs';

import {
  buildNode25BlockBanner,
  buildNodeTooOldBanner,
  isNodeVersionBelowMinimum,
} from './node-version-check';
import {
  RELAUNCH_GUARD_ENV,
  relaunchWithWasmRuntimeFlagsIfNeeded,
} from '../extraction/wasm-runtime-flags';

// Lazy-load heavy modules (CodeGraph, runInstaller) to keep CLI startup fast.
async function loadCodeGraph(): Promise<typeof import('../index')> {
  try {
    return await import('../index');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\x1b[31m${getGlyphs().err}\x1b[0m Failed to load CodeGraph modules.`);
    console.error(`\n  Node: ${process.version}  Platform: ${process.platform} ${process.arch}`);
    console.error(`\n  Error: ${msg}`);
    console.error('\n  Try reinstalling with: npm install -g @colbymchenry/codegraph\n');
    process.exit(1);
  }
}

// Dynamic import helper — tsc compiles import() to require() in CJS mode,
// which fails for ESM-only packages. This bypasses the transformation.
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const importESM = new Function('specifier', 'return import(specifier)') as
  (specifier: string) => Promise<typeof import('@clack/prompts')>;

// Block CodeGraph on Node.js 25.x — V8's turboshaft WASM JIT has a Zone
// allocator bug that reliably crashes when compiling tree-sitter
// grammars (see #54, #81, #140). The previous behaviour was a soft
// console.warn that scrolls off-screen before the OOM crash 30 seconds
// later, leading to a steady stream of "what is this OOM" reports.
// Hard-exit before any WASM work; allow override via env var for users
// who patched V8 themselves or want to test a future fix.
const nodeVersion = process.versions.node;
const nodeMajor = parseInt(nodeVersion.split('.')[0] ?? '0', 10);
const hasUnsafeNodeOverride = Boolean(process.env.CODEGRAPH_ALLOW_UNSAFE_NODE);
const shouldShowCompatibilityBanner = !process.env[RELAUNCH_GUARD_ENV] || !hasUnsafeNodeOverride;
if (nodeMajor >= 25) {
  if (shouldShowCompatibilityBanner) {
    process.stderr.write(buildNode25BlockBanner(nodeVersion) + '\n');
  }
  if (!hasUnsafeNodeOverride) {
    process.exit(1);
  }
  // Override active; continue after showing the banner on the direct launch path.
}
// Enforce the supported Node floor. `engines` in package.json only *warns* on
// install (unless engine-strict), so hard-block here to actually keep users off
// unsupported versions. Mirrors the 25+ block above. See package.json `engines`.
if (isNodeVersionBelowMinimum(nodeVersion)) {
  if (shouldShowCompatibilityBanner) {
    process.stderr.write(buildNodeTooOldBanner(nodeVersion) + '\n');
  }
  if (!hasUnsafeNodeOverride) {
    process.exit(1);
  }
  // Override active; continue after showing the banner on the direct launch path.
}

// Re-exec with V8's `--liftoff-only` if it isn't already set, so tree-sitter's
// large WASM grammars never hit the turboshaft Zone OOM (`Fatal process out of
// memory: Zone`) on Node >= 22. No-op under the bundled launcher, which already
// passes the flag. Must run before any grammar (in the parse worker, which
// inherits this process's flags) is compiled. See ../extraction/wasm-runtime-flags.
relaunchWithWasmRuntimeFlagsIfNeeded(__filename);

// Check if running with no arguments - run installer
if (process.argv.length === 2) {
  import('../installer').then(({ runInstaller }) =>
    runInstaller()
  ).catch((err) => {
    console.error('Installation failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
} else {
  // Normal CLI flow
  main();
}

process.on('uncaughtException', (error) => {
  console.error('[CodeGraph] Uncaught exception:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('[CodeGraph] Unhandled rejection:', reason);
});

function main() {

const program = new Command();

// Version from package.json
const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf-8')
);

// =============================================================================
// ANSI Color Helpers (avoid chalk ESM issues)
// =============================================================================

const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
};

const chalk = {
  bold: (s: string) => `${colors.bold}${s}${colors.reset}`,
  dim: (s: string) => `${colors.dim}${s}${colors.reset}`,
  red: (s: string) => `${colors.red}${s}${colors.reset}`,
  green: (s: string) => `${colors.green}${s}${colors.reset}`,
  yellow: (s: string) => `${colors.yellow}${s}${colors.reset}`,
  blue: (s: string) => `${colors.blue}${s}${colors.reset}`,
  cyan: (s: string) => `${colors.cyan}${s}${colors.reset}`,
  white: (s: string) => `${colors.white}${s}${colors.reset}`,
  gray: (s: string) => `${colors.gray}${s}${colors.reset}`,
};

program
  .name('codegraph')
  .description('Code intelligence and knowledge graph for any codebase')
  .version(packageJson.version);

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Resolve project path from argument or current directory
 * Walks up parent directories to find nearest initialized CodeGraph project
 * (must have .codegraph/codegraph.db, not just .codegraph/lessons.db)
 */
function resolveProjectPath(pathArg?: string): string {
  const absolutePath = path.resolve(pathArg || process.cwd());

  // If exact path is initialized (has codegraph.db), use it
  if (isInitialized(absolutePath)) {
    return absolutePath;
  }

  // Walk up to find nearest parent with CodeGraph initialized
  // Note: findNearestCodeGraphRoot finds any .codegraph folder, but we need one with codegraph.db
  let current = absolutePath;
  const root = path.parse(current).root;

  while (current !== root) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;

    if (isInitialized(current)) {
      return current;
    }
  }

  // Not found - return original path (will fail later with helpful error)
  return absolutePath;
}

/**
 * Format a number with commas
 */
function formatNumber(n: number): string {
  return n.toLocaleString();
}

/**
 * Shared collector for the CLI `callers` / `callees` subcommands. Walks the
 * search matches, applies the exact-match-when-multiple filter, and
 * deduplicates by node id keeping the highest-confidence edge for each
 * neighbour. Returns plain JSON-serializable entries (resolver metadata is
 * flattened to `confidence` / `resolvedBy`) plus a private `_edge` carrying
 * the raw edge for terminal rendering.
 */
type GraphRelationEntry = {
  name: string;
  kind: string;
  filePath: string;
  startLine?: number;
  confidence?: number;
  resolvedBy?: string;
  /**
   * Edge primary key — index-local, not stable across rebuilds.
   * Exposed (PF-693) so users can pass it to `codegraph explain
   * <edgeId>` without having to spell out the full canonical
   * identity. Omitted when the edge row has no id (synthesized
   * or pre-insert edges).
   */
  edgeId?: number;
  /** Raw edge — internal; stripped from JSON via the toJSON hook below. */
  _edge?: Edge;
  toJSON?: () => unknown;
};

function collectGraphRelations(
  matches: ReadonlyArray<{ node: { id: string; name: string } }>,
  symbol: string,
  fetch: (nodeId: string) => Array<{ node: { id: string; name: string; kind: string; filePath: string; startLine?: number }; edge: Edge }>
): GraphRelationEntry[] {
  const byId = new Map<string, { entry: GraphRelationEntry; confidence: number }>();

  const ingest = (results: ReturnType<typeof fetch>) => {
    for (const { node, edge } of results) {
      const prov = extractEdgeProvenance(edge);
      const confidence = prov.confidence ?? -Infinity;
      const existing = byId.get(node.id);
      if (existing && existing.confidence >= confidence) continue;
      const entry: GraphRelationEntry = {
        name: node.name,
        kind: node.kind,
        filePath: node.filePath,
        ...(node.startLine !== undefined ? { startLine: node.startLine } : {}),
        ...(prov.confidence !== undefined ? { confidence: prov.confidence } : {}),
        ...(prov.resolvedBy ? { resolvedBy: prov.resolvedBy } : {}),
        ...(edge.id !== undefined ? { edgeId: edge.id } : {}),
        _edge: edge,
      };
      // Hide _edge from JSON output without losing it for terminal rendering.
      Object.defineProperty(entry, 'toJSON', {
        value: () => {
          const { _edge, toJSON, ...rest } = entry;
          void _edge; void toJSON;
          return rest;
        },
        enumerable: false,
      });
      byId.set(node.id, { entry, confidence });
    }
  };

  for (const match of matches) {
    const exactMatch =
      match.node.name === symbol ||
      match.node.name.endsWith(`.${symbol}`) ||
      match.node.name.endsWith(`::${symbol}`);
    if (!exactMatch && matches.length > 1) continue;
    ingest(fetch(match.node.id));
  }

  // Fallback: if exact filter removed everything, use the top match.
  if (byId.size === 0 && matches[0]) {
    ingest(fetch(matches[0].node.id));
  }

  return [...byId.values()].map((v) => v.entry);
}


/**
 * Format duration in milliseconds to human readable
 */
function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds.toFixed(0)}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function parsePositiveIntOption(value: string, optionName: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${optionName} must be a positive integer`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${optionName} must be a positive integer`);
  }
  return parsed;
}

function collectOption(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

// Shimmer progress renderer (runs in a worker thread for smooth animation)
// Imported at top of file from '../ui/shimmer-progress'

/**
 * Create a plain-text progress callback for --verbose mode.
 * No animations, no ANSI tricks — just timestamped lines to stdout.
 */
function createVerboseProgress(): (progress: { phase: string; current: number; total: number; currentFile?: string }) => void {
  let lastPhase = '';
  let lastPct = -1;
  const startTime = Date.now();

  return (progress) => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    if (progress.phase !== lastPhase) {
      lastPhase = progress.phase;
      lastPct = -1;
      console.log(`[${elapsed}s] Phase: ${progress.phase}`);
    }

    if (progress.total > 0) {
      const pct = Math.floor((progress.current / progress.total) * 100);
      // Log every 5% to keep output manageable
      if (pct >= lastPct + 5 || progress.current === progress.total) {
        lastPct = pct;
        console.log(`[${elapsed}s]   ${progress.current}/${progress.total} (${pct}%)${progress.currentFile ? ` ${getGlyphs().dash} ${progress.currentFile}` : ''}`);
      }
    } else if (progress.current > 0) {
      // Scanning phase (no total yet) — log periodically
      if (progress.current % 1000 === 0 || progress.current === 1) {
        console.log(`[${elapsed}s]   ${formatNumber(progress.current)} files found`);
      }
    }
  };
}

/**
 * Print success message
 */
function success(message: string): void {
  console.log(chalk.green(getGlyphs().ok) + ' ' + message);
}

/**
 * Print error message
 */
function error(message: string): void {
  console.error(chalk.red(getGlyphs().err) + ' ' + message);
}

/**
 * Print info message
 */
function info(message: string): void {
  console.log(chalk.blue(getGlyphs().info) + ' ' + message);
}

/**
 * Print warning message
 */
function warn(message: string): void {
  console.log(chalk.yellow(getGlyphs().warn) + ' ' + message);
}

type IndexResult = {
  success: boolean;
  filesIndexed: number;
  filesSkipped: number;
  filesErrored: number;
  nodesCreated: number;
  edgesCreated: number;
  errors: Array<{ message: string; filePath?: string; severity: string; code?: string }>;
  durationMs: number;
};

/**
 * Print indexing results using clack log methods
 */
function printIndexResult(clack: typeof import('@clack/prompts'), result: IndexResult, projectPath?: string): void {
  const hasErrors = result.filesErrored > 0;

  // Surface non-file-level failures (e.g. lock-acquisition failure
  // when another indexer is running) before the file-count branches.
  // Without this the CLI falls through to "No files found to index",
  // which is actively misleading — the index DID run, it just couldn't
  // get the lock.
  //
  // If success is false but no severity:'error' entry exists in
  // `result.errors` (degenerate case — shouldn't happen in practice
  // but worth guarding because the result shape is plumbed through
  // multiple call sites), fall back to a generic message rather than
  // continuing to the misleading "No files found" branch or throwing.
  if (!result.success && !hasErrors && result.filesIndexed === 0) {
    const generic = result.errors.find((e) => e.severity === 'error');
    clack.log.error(generic?.message ?? `Indexing failed ${getGlyphs().dash} no further details available`);
    return;
  }

  if (result.filesIndexed > 0) {
    if (hasErrors) {
      clack.log.success(`Indexed ${formatNumber(result.filesIndexed)} files (${formatNumber(result.filesErrored)} could not be parsed)`);
    } else {
      clack.log.success(`Indexed ${formatNumber(result.filesIndexed)} files`);
    }
    clack.log.info(`${formatNumber(result.nodesCreated)} nodes, ${formatNumber(result.edgesCreated)} edges in ${formatDuration(result.durationMs)}`);
  } else if (hasErrors) {
    clack.log.error(`Indexing failed ${getGlyphs().dash} all ${formatNumber(result.filesErrored)} files had errors`);
  } else {
    clack.log.warn('No files found to index');
  }

  if (hasErrors) {
    const errorsByCode = new Map<string, number>();
    for (const err of result.errors) {
      if (err.severity === 'error') {
        const code = err.code || 'unknown';
        errorsByCode.set(code, (errorsByCode.get(code) || 0) + 1);
      }
    }

    const codeLabels: Record<string, string> = {
      parse_error: 'files failed to parse',
      read_error: 'files could not be read',
      size_exceeded: 'files exceeded size limit',
      path_traversal: 'blocked paths',
      unsupported_language: 'unsupported language',
      parser_error: 'parser initialization failures',
    };

    const breakdown = Array.from(errorsByCode)
      .map(([code, count]) => `${formatNumber(count)} ${codeLabels[code] || code}`)
      .join('\n');
    clack.note(breakdown, 'Error breakdown');

    if (projectPath) {
      writeErrorLog(projectPath, result.errors);
      clack.log.info('See .codegraph/errors.log for details');
    }

    if (result.filesIndexed > 0) {
      clack.log.info(`The index is fully usable ${getGlyphs().dash} only the failed files are missing.`);
    }
  } else if (projectPath) {
    const logPath = path.join(projectPath, '.codegraph', 'errors.log');
    if (fs.existsSync(logPath)) {
      fs.unlinkSync(logPath);
    }
  }
}

type BenchmarkReport = Awaited<ReturnType<typeof import('../benchmark').runBenchmark>>;

function printBenchmarkReport(report: BenchmarkReport): void {
  console.log(chalk.bold('\nCodeGraph Benchmark\n'));
  console.log(chalk.cyan('Project:'), report.projectPath);
  console.log(chalk.cyan('Mode:'), [
    report.mode.cold ? 'cold' : 'warm',
    report.mode.reindexed ? 'reindexed' : undefined,
    report.mode.cleanedUp ? 'cleaned up' : undefined,
  ].filter(Boolean).join(', '));
  console.log();

  console.log(chalk.bold('Timings:'));
  console.log(`  Total:     ${formatDuration(report.timings.totalMs)}`);
  if (report.timings.indexMs !== undefined) {
    console.log(`  Index:     ${formatDuration(report.timings.indexMs)}`);
  } else {
    console.log('  Index:     reused existing index');
  }
  console.log(`  Status:    ${formatDuration(report.timings.statusMs)}`);
  console.log();

  console.log(chalk.bold('Index Statistics:'));
  console.log(`  Files:     ${formatNumber(report.stats.fileCount)}`);
  console.log(`  Nodes:     ${formatNumber(report.stats.nodeCount)}`);
  console.log(`  Edges:     ${formatNumber(report.stats.edgeCount)}`);
  console.log(`  DB Size:   ${formatBytes(report.stats.dbSizeBytes)}`);
  console.log(`  Peak RSS:  ${formatBytes(report.memory.peakRssBytes)}`);
  if (report.indexResult) {
    console.log(`  Created:   ${formatNumber(report.indexResult.nodesCreated)} nodes, ${formatNumber(report.indexResult.edgesCreated)} edges`);
    if (report.indexResult.filesErrored > 0) {
      console.log(chalk.yellow(`  Errors:    ${formatNumber(report.indexResult.filesErrored)} files could not be parsed`));
    }
  }
  console.log();

  if (report.queries.length > 0) {
    console.log(chalk.bold('Queries:'));
    for (const query of report.queries) {
      const counts = [
        query.resultCount !== undefined ? `${formatNumber(query.resultCount)} results` : undefined,
        query.nodeCount !== undefined ? `${formatNumber(query.nodeCount)} nodes` : undefined,
        query.edgeCount !== undefined ? `${formatNumber(query.edgeCount)} edges` : undefined,
        query.outputBytes !== undefined ? `${formatBytes(query.outputBytes)}` : undefined,
      ].filter(Boolean).join(', ');
      const suffix = counts ? ` ${getGlyphs().dash} ${counts}` : '';
      const status = query.ok ? chalk.green(getGlyphs().ok) : chalk.red(getGlyphs().err);
      console.log(`  ${status} ${query.spec}: ${formatDuration(query.durationMs)}${suffix}`);
      if (query.error) {
        console.log(chalk.dim(`    ${query.error}`));
      }
    }
    console.log();
  }

  success('Benchmark complete');
}

/**
 * Write detailed error log to .codegraph/errors.log
 */
function writeErrorLog(projectPath: string, errors: Array<{ message: string; filePath?: string; severity: string; code?: string }>): void {
  const cgDir = path.join(projectPath, '.codegraph');
  if (!fs.existsSync(cgDir)) return;

  const logPath = path.join(cgDir, 'errors.log');

  // Group errors by file path
  const errorsByFile = new Map<string, Array<{ message: string; code?: string }>>();
  const noFileErrors: Array<{ message: string; code?: string }> = [];

  for (const err of errors) {
    if (err.severity !== 'error') continue;
    if (err.filePath) {
      let list = errorsByFile.get(err.filePath);
      if (!list) {
        list = [];
        errorsByFile.set(err.filePath, list);
      }
      list.push({ message: err.message, code: err.code });
    } else {
      noFileErrors.push({ message: err.message, code: err.code });
    }
  }

  const lines: string[] = [
    `CodeGraph Error Log - ${new Date().toISOString()}`,
    `${errorsByFile.size} files with errors`,
    '',
  ];

  for (const [filePath, fileErrors] of errorsByFile) {
    for (const err of fileErrors) {
      lines.push(`${filePath}: ${err.message}`);
    }
  }

  for (const err of noFileErrors) {
    lines.push(err.message);
  }

  fs.writeFileSync(logPath, lines.join('\n') + '\n');
}

// =============================================================================
// Commands
// =============================================================================

/**
 * codegraph init [path]
 */
program
  .command('init [path]')
  .description('Initialize CodeGraph in a project directory')
  .option('-i, --index', 'Run initial indexing after initialization')
  .option('-v, --verbose', 'Show detailed worker lifecycle and memory info')
  .action(async (pathArg: string | undefined, options: { index?: boolean; verbose?: boolean }) => {
    const projectPath = path.resolve(pathArg || process.cwd());
    const clack = await importESM('@clack/prompts');

    clack.intro('Initializing CodeGraph');

    try {
      if (isInitialized(projectPath)) {
        clack.log.warn(`Already initialized in ${projectPath}`);
        clack.log.info('Use "codegraph index" to re-index or "codegraph sync" to update');
        // Re-run agent surface wiring so re-running `init` is the
        // documented way to recover a project that's missing its
        // Cursor rules file (or future per-agent project surfaces).
        try {
          const { wireProjectSurfacesForGlobalAgents } = await import('../installer');
          for (const { target, file } of wireProjectSurfacesForGlobalAgents()) {
            clack.log.success(`${target.displayName}: ${file.action} ${file.path}`);
          }
        } catch { /* non-fatal */ }
        try {
          const { offerWatchFallback } = await import('../installer');
          await offerWatchFallback(clack, projectPath);
        } catch { /* non-fatal */ }
        clack.outro('');
        return;
      }

      const { default: CodeGraph } = await loadCodeGraph();
      const cg = await CodeGraph.init(projectPath, { index: false });
      clack.log.success(`Initialized in ${projectPath}`);

      // Bootstrap project-local surfaces for any agent that's
      // configured globally (Cursor needs ./.cursor/rules/codegraph.mdc
      // to actually prefer codegraph over native grep). Silent when
      // there's nothing to write.
      try {
        const { wireProjectSurfacesForGlobalAgents } = await import('../installer');
        for (const { target, file } of wireProjectSurfacesForGlobalAgents()) {
          clack.log.success(`${target.displayName}: ${file.action} ${file.path}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        clack.log.warn(`Skipped wiring project-local agent surfaces: ${msg}`);
      }

      if (options.index) {
        let result: IndexResult;

        if (options.verbose) {
          result = await cg.indexAll({
            onProgress: createVerboseProgress(),
            verbose: true,
          });
        } else {
          process.stdout.write(`${colors.dim}${getGlyphs().rail}${colors.reset}\n`);
          const progress = createShimmerProgress();
          result = await cg.indexAll({
            onProgress: progress.onProgress,
          });
          await progress.stop();
        }

        printIndexResult(clack, result, projectPath);
      } else {
        clack.log.info('Run "codegraph index" to index the project');
      }

      try {
        const { offerWatchFallback } = await import('../installer');
        await offerWatchFallback(clack, projectPath);
      } catch { /* non-fatal */ }

      clack.outro('Done');
      cg.destroy();
    } catch (err) {
      clack.log.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * codegraph uninit [path]
 */
program
  .command('uninit [path]')
  .description('Remove CodeGraph from a project (deletes .codegraph/ directory)')
  .option('-f, --force', 'Skip confirmation prompt')
  .action(async (pathArg: string | undefined, options: { force?: boolean }) => {
    const projectPath = resolveProjectPath(pathArg);

    try {
      if (!isInitialized(projectPath)) {
        warn(`CodeGraph is not initialized in ${projectPath}`);
        return;
      }

      if (!options.force) {
        // Confirm with user
        const readline = await import('readline');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) => {
          rl.question(
            chalk.yellow(`${getGlyphs().warn} This will permanently delete all CodeGraph data. Continue? (y/N) `),
            resolve
          );
        });
        rl.close();

        if (answer.toLowerCase() !== 'y') {
          info('Cancelled');
          return;
        }
      }

      const { default: CodeGraph } = await loadCodeGraph();
      const cg = CodeGraph.openSync(projectPath);
      cg.uninitialize();

      // Clean up any git sync hooks we installed (no-op if none / not a repo).
      try {
        const { removeGitSyncHook } = await import('../sync/git-hooks');
        const removed = removeGitSyncHook(projectPath);
        if (removed.installed.length > 0) {
          info(`Removed git ${removed.installed.join(', ')} sync hook${removed.installed.length > 1 ? 's' : ''}`);
        }
      } catch { /* non-fatal */ }

      success(`Removed CodeGraph from ${projectPath}`);
    } catch (err) {
      error(`Failed to uninitialize: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * codegraph index [path]
 */
program
  .command('index [path]')
  .description('Index all files in the project')
  .option('-f, --force', 'Force full re-index even if already indexed')
  .option('-q, --quiet', 'Suppress progress output')
  .option('-v, --verbose', 'Show detailed worker lifecycle and memory info')
  .action(async (pathArg: string | undefined, options: { force?: boolean; quiet?: boolean; verbose?: boolean }) => {
    const projectPath = resolveProjectPath(pathArg);

    try {
      if (!isInitialized(projectPath)) {
        error(`CodeGraph not initialized in ${projectPath}`);
        info('Run "codegraph init" first');
        process.exit(1);
      }

      const { default: CodeGraph } = await loadCodeGraph();
      const cg = await CodeGraph.open(projectPath);

      if (options.quiet) {
        // Quiet mode: no UI, just run
        if (options.force) cg.clear();
        const result = await cg.indexAll();
        if (!result.success) process.exit(1);
        cg.destroy();
        return;
      }

      const clack = await importESM('@clack/prompts');
      clack.intro('Indexing project');

      if (options.force) {
        cg.clear();
        clack.log.info('Cleared existing index');
      }

      let result: IndexResult;

      if (options.verbose) {
        result = await cg.indexAll({
          onProgress: createVerboseProgress(),
          verbose: true,
        });
      } else {
        process.stdout.write(`${colors.dim}${getGlyphs().rail}${colors.reset}\n`);
        const progress = createShimmerProgress();
        result = await cg.indexAll({
          onProgress: progress.onProgress,
        });
        await progress.stop();
      }

      printIndexResult(clack, result, projectPath);

      if (!result.success) {
        process.exit(1);
      }

      clack.outro('Done');
      cg.destroy();
    } catch (err) {
      error(`Failed to index: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * codegraph sync [path]
 */
program
  .command('sync [path]')
  .description('Sync changes since last index')
  .option('-q, --quiet', 'Suppress output (for git hooks)')
  .action(async (pathArg: string | undefined, options: { quiet?: boolean }) => {
    const projectPath = resolveProjectPath(pathArg);

    try {
      if (!isInitialized(projectPath)) {
        if (!options.quiet) {
          error(`CodeGraph not initialized in ${projectPath}`);
        }
        process.exit(1);
      }

      const { default: CodeGraph } = await loadCodeGraph();
      const cg = await CodeGraph.open(projectPath);

      if (options.quiet) {
        await cg.sync();
        cg.destroy();
        return;
      }

      const clack = await importESM('@clack/prompts');
      clack.intro('Syncing CodeGraph');

      process.stdout.write(`${colors.dim}${getGlyphs().rail}${colors.reset}\n`);
      const progress = createShimmerProgress();

      const result = await cg.sync({
        onProgress: progress.onProgress,
      });

      await progress.stop();

      const totalChanges = result.filesAdded + result.filesModified + result.filesRemoved;

      if (totalChanges === 0) {
        clack.log.info('Already up to date');
      } else {
        clack.log.success(`Synced ${formatNumber(totalChanges)} changed files`);
        const details: string[] = [];
        if (result.filesAdded > 0) details.push(`Added: ${result.filesAdded}`);
        if (result.filesModified > 0) details.push(`Modified: ${result.filesModified}`);
        if (result.filesRemoved > 0) details.push(`Removed: ${result.filesRemoved}`);
        clack.log.info(`${details.join(', ')} ${getGlyphs().dash} ${formatNumber(result.nodesUpdated)} nodes in ${formatDuration(result.durationMs)}`);
      }

      clack.outro('Done');
      cg.destroy();
    } catch (err) {
      if (!options.quiet) {
        error(`Failed to sync: ${err instanceof Error ? err.message : String(err)}`);
      }
      process.exit(1);
    }
  });

/**
 * codegraph status [path]
 */
program
  .command('status [path]')
  .description('Show index status and statistics')
  .option('-j, --json', 'Output as JSON')
  .action(async (pathArg: string | undefined, options: { json?: boolean }) => {
    const projectPath = resolveProjectPath(pathArg);

    try {
      if (!isInitialized(projectPath)) {
        if (options.json) {
          console.log(JSON.stringify(cliJsonEnvelope('status', { initialized: false, projectPath })));
          return;
        }
        console.log(chalk.bold('\nCodeGraph Status\n'));
        info(`Project: ${projectPath}`);
        warn('Not initialized');
        info('Run "codegraph init" to initialize');
        return;
      }

      const { default: CodeGraph } = await loadCodeGraph();
      const cg = await CodeGraph.open(projectPath);
      const stats = cg.getStats();
      const changes = cg.getChangedFiles();
      const backend = cg.getBackend();
      const journalMode = cg.getJournalMode();
      const safety = cg.getIndexSafetyStats();

      // JSON output mode
      if (options.json) {
        console.log(JSON.stringify(cliJsonEnvelope('status', {
          initialized: true,
          projectPath,
          fileCount: stats.fileCount,
          nodeCount: stats.nodeCount,
          edgeCount: stats.edgeCount,
          dbSizeBytes: stats.dbSizeBytes,
          backend,
          journalMode,
          indexSafety: {
            sensitiveFilesSkipped: safety.sensitiveFilesSkipped,
            sensitiveFilesByReason: safety.sensitiveFilesByReason,
            gitignoredFiles: 'excluded by git/.gitignore and not enumerated',
          },
          nodesByKind: stats.nodesByKind,
          languages: Object.entries(stats.filesByLanguage).filter(([, count]) => count > 0).map(([lang]) => lang),
          pendingChanges: {
            added: changes.added.length,
            modified: changes.modified.length,
            removed: changes.removed.length,
          },
        })));
        cg.destroy();
        return;
      }

      console.log(chalk.bold('\nCodeGraph Status\n'));

      // Project info
      console.log(chalk.cyan('Project:'), projectPath);
      console.log();

      // Index stats
      console.log(chalk.bold('Index Statistics:'));
      console.log(`  Files:     ${formatNumber(stats.fileCount)}`);
      console.log(`  Nodes:     ${formatNumber(stats.nodeCount)}`);
      console.log(`  Edges:     ${formatNumber(stats.edgeCount)}`);
      console.log(`  DB Size:   ${(stats.dbSizeBytes / 1024 / 1024).toFixed(2)} MB`);
      // Surface the active SQLite backend (node:sqlite — Node's built-in real
      // SQLite, full WAL + FTS5, no native build).
      const backendLabel = chalk.green(`node:sqlite ${getGlyphs().dash} built-in (full WAL)`);
      console.log(`  Backend:   ${backendLabel}`);
      // Effective journal mode: 'wal' means concurrent reads never block on a
      // writer; anything else means they can ("database is locked"). node:sqlite
      // supports WAL everywhere, so a non-wal mode means the filesystem can't
      // (network mounts, WSL2 /mnt). See issue #238.
      const journalLabel = journalMode === 'wal'
        ? chalk.green('wal')
        : chalk.yellow(`${journalMode || 'unknown'} ${getGlyphs().dash} WAL inactive; reads can block on writes`);
      console.log(`  Journal:   ${journalLabel}`);
      console.log();

      console.log(chalk.bold('Index Safety:'));
      console.log(`  Sensitive files skipped: ${formatNumber(safety.sensitiveFilesSkipped)}`);
      if (safety.sensitiveFilesSkipped > 0) {
        for (const [reason, count] of Object.entries(safety.sensitiveFilesByReason).sort()) {
          console.log(`  ${reason.padEnd(20)} ${formatNumber(count)}`);
        }
      }
      console.log('  Gitignored files: excluded by git/.gitignore and not enumerated');
      console.log();

      // Node breakdown
      console.log(chalk.bold('Nodes by Kind:'));
      const nodesByKind = Object.entries(stats.nodesByKind)
        .filter(([, count]) => count > 0)
        .sort((a, b) => b[1] - a[1]);
      for (const [kind, count] of nodesByKind) {
        console.log(`  ${kind.padEnd(15)} ${formatNumber(count)}`);
      }
      console.log();

      // Language breakdown
      console.log(chalk.bold('Files by Language:'));
      const filesByLang = Object.entries(stats.filesByLanguage)
        .filter(([, count]) => count > 0)
        .sort((a, b) => b[1] - a[1]);
      for (const [lang, count] of filesByLang) {
        console.log(`  ${lang.padEnd(15)} ${formatNumber(count)}`);
      }
      console.log();

      // Pending changes
      const totalChanges = changes.added.length + changes.modified.length + changes.removed.length;
      if (totalChanges > 0) {
        console.log(chalk.bold('Pending Changes:'));
        if (changes.added.length > 0) {
          console.log(`  Added:     ${changes.added.length} files`);
        }
        if (changes.modified.length > 0) {
          console.log(`  Modified:  ${changes.modified.length} files`);
        }
        if (changes.removed.length > 0) {
          console.log(`  Removed:   ${changes.removed.length} files`);
        }
        info('Run "codegraph sync" to update the index');
      } else {
        success('Index is up to date');
      }
      console.log();

      cg.destroy();
    } catch (err) {
      error(`Failed to get status: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * codegraph benchmark [path]
 */
program
  .command('benchmark [path]')
  .alias('bench')
  .description('Benchmark indexing and graph query latency for a project')
  .option('--cold', 'Delete any existing index before benchmarking (requires --force when an index exists)')
  .option('--reindex', 'Clear and rebuild an existing index before query benchmarks (requires --force when an index exists)')
  .option('--force', 'Allow destructive benchmark setup such as deleting an existing .codegraph index')
  .option('--cleanup', 'Remove the benchmark-created index after the run')
  .option('--query <spec>', 'Query to benchmark; repeatable. Formats: search:x, context:x, callers:x, callees:x, impact:x', collectOption, [] as string[])
  .option('--query-limit <number>', 'Maximum search matches used by query benchmarks', '20')
  .option('--context-max-nodes <number>', 'Maximum nodes for context query benchmarks', '50')
  .option('--include-context-code', 'Include source code blocks in context query benchmarks')
  .option('-j, --json', 'Output the full benchmark report as JSON')
  .option('-o, --output <file>', 'Write the full benchmark report JSON to a file')
  .action(async (pathArg: string | undefined, options: {
    cold?: boolean;
    reindex?: boolean;
    force?: boolean;
    cleanup?: boolean;
    query?: string[];
    queryLimit?: string;
    contextMaxNodes?: string;
    includeContextCode?: boolean;
    json?: boolean;
    output?: string;
  }) => {
    const projectPath = path.resolve(pathArg || process.cwd());

    try {
      const { runBenchmark } = await import('../benchmark');
      const report = await runBenchmark(projectPath, {
        cold: options.cold,
        reindex: options.reindex,
        force: options.force,
        cleanup: options.cleanup,
        queries: options.query,
        queryLimit: parsePositiveIntOption(options.queryLimit || '20', '--query-limit'),
        contextMaxNodes: parsePositiveIntOption(options.contextMaxNodes || '50', '--context-max-nodes'),
        includeContextCode: options.includeContextCode,
      });

      const json = JSON.stringify(report, null, 2);
      if (options.output) {
        fs.writeFileSync(path.resolve(options.output), `${json}\n`, 'utf8');
      }

      if (options.json) {
        console.log(json);
      } else {
        printBenchmarkReport(report);
        if (options.output) {
          info(`Wrote JSON report to ${path.resolve(options.output)}`);
        }
      }

      if (report.indexResult && !report.indexResult.success) {
        process.exit(1);
      }
      if (report.queries.some((query) => !query.ok)) {
        process.exit(1);
      }
    } catch (err) {
      error(`Benchmark failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * codegraph query <search>
 */
program
  .command('query <search>')
  .description('Search for symbols in the codebase')
  .option('-p, --path <path>', 'Project path')
  .option('-l, --limit <number>', 'Maximum results', '10')
  .option('-k, --kind <kind>', 'Filter by node kind (function, class, etc.)')
  .option('-j, --json', 'Output as JSON')
  .action(async (search: string, options: { path?: string; limit?: string; kind?: string; json?: boolean }) => {
    const projectPath = resolveProjectPath(options.path);

    try {
      if (!isInitialized(projectPath)) {
        error(`CodeGraph not initialized in ${projectPath}`);
        process.exit(1);
      }

      const { default: CodeGraph } = await loadCodeGraph();
      const cg = await CodeGraph.open(projectPath);

      const limit = parseInt(options.limit || '10', 10);
      const results = cg.searchNodes(search, {
        limit,
        kinds: options.kind ? [options.kind as any] : undefined,
      });

      if (options.json) {
        console.log(JSON.stringify(cliJsonEnvelope('search', { query: search, results }), null, 2));
      } else {
        if (results.length === 0) {
          info(`No results found for "${search}"`);
        } else {
          console.log(chalk.bold(`\nSearch Results for "${search}":\n`));

          for (const result of results) {
            const node = result.node;
            const location = `${node.filePath}:${node.startLine}`;
            const score = chalk.dim(`(${(result.score * 100).toFixed(0)}%)`);

            console.log(
              chalk.cyan(node.kind.padEnd(12)) +
              chalk.white(node.name) +
              ' ' + score
            );
            console.log(chalk.dim(`  ${location}`));
            if (node.signature) {
              console.log(chalk.dim(`  ${node.signature}`));
            }
            console.log();
          }
        }
      }

      cg.destroy();
    } catch (err) {
      error(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * codegraph diff <oldDb> <newDb>
 *
 * PF-691: DB-vs-DB structural diff. Operates on already-built
 * `.codegraph/codegraph.db` files — the caller handles git
 * checkouts. Output enumerates added/removed/changed nodes (with
 * field-level change lists) and added/removed edges.
 */
program
  .command('diff <oldDb> <newDb>')
  .description('Structural diff between two .codegraph/codegraph.db files')
  .option('-j, --json', 'Output as JSON')
  .action(async (oldDbPath: string, newDbPath: string, options: { json?: boolean }) => {
    try {
      if (!fs.existsSync(oldDbPath)) {
        error(`Old database not found: ${oldDbPath}`);
        process.exit(1);
      }
      if (!fs.existsSync(newDbPath)) {
        error(`New database not found: ${newDbPath}`);
        process.exit(1);
      }

      const { diffDatabases } = await import('../diff');
      const result = diffDatabases(oldDbPath, newDbPath);

      if (options.json) {
        // DiffResult is a structured object the envelope schema
        // describes via per-tool docs; cast through unknown so the
        // envelope helper's `Record<string, unknown>` signature
        // accepts the typed shape without losing the structure.
        console.log(
          JSON.stringify(
            cliJsonEnvelope('diff', result as unknown as Record<string, unknown>),
            null,
            2,
          ),
        );
        return;
      }

      const s = result.summary;
      console.log(chalk.bold('\nCodeGraph Diff\n'));
      console.log(chalk.cyan('Old:'), oldDbPath);
      console.log(chalk.cyan('New:'), newDbPath);
      console.log();
      console.log(chalk.bold('Summary:'));
      console.log(`  Files added:     ${formatNumber(s.addedFiles)}`);
      console.log(`  Files removed:   ${formatNumber(s.removedFiles)}`);
      console.log(`  Files changed:   ${formatNumber(s.changedFiles)}`);
      console.log(`  Nodes added:     ${formatNumber(s.addedNodes)}`);
      console.log(`  Nodes removed:   ${formatNumber(s.removedNodes)}`);
      console.log(`  Nodes changed:   ${formatNumber(s.changedNodes)}`);
      console.log(`  Edges added:     ${formatNumber(s.addedEdges)}`);
      console.log(`  Edges removed:   ${formatNumber(s.removedEdges)}`);
      console.log(`  Edges changed:   ${formatNumber(s.changedEdges)}`);
      console.log();

      // Warn loudly when fingerprint coverage is partial — body-only
      // changes inside Liquid/Vue/Svelte/YAML files will silently NOT
      // show up in `changedNodes` because those extractors emit NULL
      // fingerprints (Codex round 3 finding).
      const cov = result.fingerprintCoverage;
      const oldGap = cov.old.totalNodes - cov.old.nodesWithAstHash;
      const newGap = cov.new.totalNodes - cov.new.nodesWithAstHash;
      if (oldGap > 0 || newGap > 0) {
        console.log(
          chalk.yellow(
            `Note: fingerprint coverage is partial. Body-level changes inside synthesized-extractor files (Liquid/Vue/Svelte/YAML) won't surface in changedNodes.`,
          ),
        );
        console.log(
          chalk.dim(
            `  Old DB: ${cov.old.nodesWithAstHash}/${cov.old.totalNodes} nodes with fingerprints`,
          ),
        );
        console.log(
          chalk.dim(
            `  New DB: ${cov.new.nodesWithAstHash}/${cov.new.totalNodes} nodes with fingerprints`,
          ),
        );
        console.log();
      }

      if (result.changedNodes.length > 0) {
        const shown = result.changedNodes.slice(0, 20);
        console.log(chalk.bold(`Changed nodes (first ${shown.length} of ${result.changedNodes.length}):`));
        for (const c of shown) {
          console.log(
            chalk.cyan(c.kind.padEnd(12)) +
              chalk.white(c.name) +
              ' ' +
              chalk.dim(`(${c.changedFields.join(', ')})`),
          );
          console.log(chalk.dim(`  ${c.filePath}`));
        }
        if (result.changedNodes.length > shown.length) {
          console.log(chalk.dim(`  …+${result.changedNodes.length - shown.length} more (use --json for full output)`));
        }
        console.log();
      }
    } catch (err) {
      error(`Diff failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * codegraph duplicates [path]
 *
 * PF-692: clone detection over PF-690 fingerprint columns.
 * Reports Type-1 (exact) and Type-2 (shape) clone groups under
 * the council-locked defaults: function+method kinds, ≥10 lines,
 * shape groups whose members already form an exact group are
 * suppressed.
 */
program
  .command('duplicates [path]')
  .description('Find clone groups in the index using PF-690 fingerprint columns')
  .option(
    '--kind <kinds>',
    'Comma-separated symbol kinds to include (default: function,method)',
  )
  .option(
    '--min-lines <number>',
    'Minimum endLine-startLine+1 to keep a symbol (default: 10)',
  )
  .option('-j, --json', 'Output as JSON')
  .action(
    async (
      projectPathArg: string | undefined,
      options: { kind?: string; minLines?: string; json?: boolean },
    ) => {
      try {
        // Match `status` / `index` / `sync`: walk up from the supplied
        // path to find an initialized project. A user running
        // `codegraph duplicates` from a subdirectory should resolve
        // to the repo root, not look for `subdir/.codegraph/`.
        const projectPath = resolveProjectPath(projectPathArg);
        const dbPath = path.join(getCodeGraphDir(projectPath), 'codegraph.db');
        if (!fs.existsSync(dbPath)) {
          error(
            `CodeGraph index not found at ${dbPath}. Run \`codegraph init -i\` in this directory first.`,
          );
          process.exit(1);
        }

        const kinds = options.kind
          ? options.kind
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s.length > 0)
          : undefined;
        let minLines: number | undefined;
        if (options.minLines !== undefined) {
          // Strict positive-integer match — `parseInt` would happily
          // accept `10abc` / `1.5` / `+10`, hiding typos.
          if (!/^[1-9]\d*$/.test(options.minLines)) {
            error(`--min-lines must be a positive integer, got: ${options.minLines}`);
            process.exit(1);
          }
          minLines = Number.parseInt(options.minLines, 10);
        }

        const { findDuplicates, DEFAULT_DUPLICATE_KINDS, DEFAULT_MIN_LINES } =
          await import('../duplicates');
        const result = findDuplicates(dbPath, { kinds, minLines });

        if (options.json) {
          console.log(
            JSON.stringify(
              cliJsonEnvelope('duplicates', result as unknown as Record<string, unknown>),
              null,
              2,
            ),
          );
          return;
        }

        const s = result.summary;
        const usedKinds = kinds ?? DEFAULT_DUPLICATE_KINDS;
        const usedMinLines = minLines ?? DEFAULT_MIN_LINES;
        const cov = s.fingerprintCoverage;

        console.log(chalk.bold('\nCodeGraph Duplicates\n'));
        console.log(chalk.cyan('Database:'), dbPath);
        console.log(
          chalk.dim(
            `  kinds=${usedKinds.join(',')}  min-lines=${usedMinLines}  ` +
              `coverage=${cov.withAstHash}/${cov.eligible} eligible nodes have fingerprints`,
          ),
        );
        console.log();
        console.log(chalk.bold('Summary:'));
        console.log(`  Exact clone groups (Type-1):  ${formatNumber(s.exactGroups)}`);
        console.log(`  Shape clone groups (Type-2):  ${formatNumber(s.shapeGroups)}`);
        console.log(`  Exact-duplicate nodes:        ${formatNumber(s.exactNodes)}`);
        console.log(`  Shape-only duplicate nodes:   ${formatNumber(s.shapeNodes)}`);
        console.log();

        if (result.groups.length === 0) {
          console.log(
            chalk.dim(
              `No duplicate groups found with kinds=${usedKinds.join(',')}, ` +
                `min-lines=${usedMinLines}, ${cov.withAstHash}/${cov.eligible} ` +
                `eligible nodes have fingerprints.`,
            ),
          );
          return;
        }

        const shown = result.groups.slice(0, 20);
        const totalHiddenMembers = result.groups
          .reduce((acc, g) => acc + Math.max(0, g.members.length - 5), 0);
        console.log(chalk.bold(`Groups (first ${shown.length} of ${result.groups.length}):`));
        for (const g of shown) {
          const tag = g.kind === 'shape' && g.coveredByExactGroup ? ' [contains exact subset]' : '';
          console.log(
            chalk.cyan(g.kind.padEnd(6)) +
              chalk.dim(g.fingerprint.slice(0, 12)) +
              ' ' +
              chalk.white(`${g.members.length} members in ${g.fileCount} file(s)`) +
              chalk.yellow(tag),
          );
          for (const m of g.members.slice(0, 5)) {
            console.log(
              chalk.dim(`  ${m.filePath}:${m.startLine}`) +
                ' ' +
                chalk.white(m.qualifiedName),
            );
          }
          if (g.members.length > 5) {
            console.log(chalk.dim(`  …+${g.members.length - 5} more members`));
          }
        }
        if (result.groups.length > shown.length || totalHiddenMembers > 0) {
          console.log();
          console.log(
            chalk.yellow(
              `Output truncated: ${result.groups.length - shown.length} more group(s) ` +
                `and ${totalHiddenMembers} more member(s) hidden. Use --json for full output.`,
            ),
          );
        }
        console.log();
      } catch (err) {
        error(`Duplicates failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    },
  );

/**
 * codegraph explain [edgeId]
 *
 * PF-693: surface the full resolution trace of a single edge.
 * Accepts either a positional integer edge id (happy path —
 * users copy it out of `codegraph callers --json` output) or
 * the canonical `--source <id> --target <id> --kind <k>
 * [--line N] [--col N]` identity (rebuild-stable; required when
 * the edge id has been invalidated by a re-index).
 */
program
  .command('explain [edgeId]')
  .description('Show why CodeGraph resolved a single edge — extractor + resolver provenance')
  .option('-p, --path <path>', 'Project path (defaults to cwd)')
  .option('--source <id>', 'Canonical lookup: source node id')
  .option('--target <id>', 'Canonical lookup: target node id')
  .option('--kind <kind>', 'Canonical lookup: edge kind (e.g. calls)')
  .option('--line <number>', 'Canonical lookup: line number for disambiguation')
  .option('--col <number>', 'Canonical lookup: column number for disambiguation')
  .option('-j, --json', 'Output as JSON')
  .action(
    async (
      edgeIdArg: string | undefined,
      options: {
        path?: string;
        source?: string;
        target?: string;
        kind?: string;
        line?: string;
        col?: string;
        json?: boolean;
      },
    ) => {
      try {
        const projectPath = resolveProjectPath(options.path);
        const dbPath = path.join(getCodeGraphDir(projectPath), 'codegraph.db');
        if (!fs.existsSync(dbPath)) {
          error(
            `CodeGraph index not found at ${dbPath}. Run \`codegraph init -i\` in this directory first.`,
          );
          process.exit(1);
        }

        const { explainEdgeById, explainEdgeByCanonical, formatExplainNarrative } =
          await import('../explain');

        let result;
        if (edgeIdArg !== undefined) {
          if (!/^[1-9]\d*$/.test(edgeIdArg)) {
            error(`edgeId must be a positive integer, got: ${edgeIdArg}`);
            process.exit(1);
          }
          result = explainEdgeById(dbPath, Number.parseInt(edgeIdArg, 10));
        } else if (options.source && options.target) {
          if (!options.kind) {
            error(
              'Canonical lookup requires --kind (e.g. `--kind calls`). The same source/target pair can be connected by multiple edge kinds.',
            );
            process.exit(1);
            return;
          }
          const parseOptNum = (raw: string | undefined, label: string): number | undefined => {
            if (raw === undefined) return undefined;
            if (!/^\d+$/.test(raw)) {
              error(`--${label} must be a non-negative integer, got: ${raw}`);
              process.exit(1);
            }
            return Number.parseInt(raw, 10);
          };
          result = explainEdgeByCanonical(dbPath, {
            source: options.source,
            target: options.target,
            kind: options.kind,
            line: parseOptNum(options.line, 'line'),
            col: parseOptNum(options.col, 'col'),
          });
        } else {
          error(
            'Provide either a positional <edgeId> (e.g. `codegraph explain 42`) or `--source <id> --target <id> --kind <k>`.',
          );
          process.exit(1);
          return; // unreachable, but TS needs it
        }

        if (options.json) {
          console.log(
            JSON.stringify(
              cliJsonEnvelope('explain', result as unknown as Record<string, unknown>),
              null,
              2,
            ),
          );
          return;
        }

        console.log(chalk.bold('\nCodeGraph Edge Explanation\n'));
        console.log(formatExplainNarrative(result));
        console.log();
      } catch (err) {
        error(`Explain failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    },
  );

/**
 * codegraph files [path]
 */
program
  .command('files')
  .description('Show project file structure from the index')
  .option('-p, --path <path>', 'Project path')
  .option('--filter <dir>', 'Filter to files under this directory')
  .option('--pattern <glob>', 'Filter files matching this glob pattern')
  .option('--format <format>', 'Output format (tree, flat, grouped)', 'tree')
  .option('--max-depth <number>', 'Maximum directory depth for tree format')
  .option('--no-metadata', 'Hide file metadata (language, symbol count)')
  .option('-j, --json', 'Output as JSON')
  .action(async (options: {
    path?: string;
    filter?: string;
    pattern?: string;
    format?: string;
    maxDepth?: string;
    metadata?: boolean;
    json?: boolean;
  }) => {
    const projectPath = resolveProjectPath(options.path);

    try {
      if (!isInitialized(projectPath)) {
        error(`CodeGraph not initialized in ${projectPath}`);
        process.exit(1);
      }

      const { default: CodeGraph } = await loadCodeGraph();
      const cg = await CodeGraph.open(projectPath);
      let files = cg.getFiles();

      if (files.length === 0) {
        // --json must always emit the envelope. reason=not_indexed fires
        // when the project is initialized but `cg.getFiles()` returns
        // nothing — typically before `codegraph index` has populated the
        // file table. Fully uninitialized projects already exit(1) above.
        if (options.json) {
          console.log(
            JSON.stringify(cliJsonEnvelope('files', { files: [], reason: 'not_indexed' }), null, 2),
          );
        } else {
          info('No files indexed. Run "codegraph index" first.');
        }
        cg.destroy();
        return;
      }

      // Filter by path prefix
      if (options.filter) {
        const filter = options.filter;
        files = files.filter(f => f.path.startsWith(filter) || f.path.startsWith('./' + filter));
      }

      // Filter by glob pattern
      if (options.pattern) {
        const regex = globToRegex(options.pattern);
        files = files.filter(f => regex.test(f.path));
      }

      if (files.length === 0) {
        if (options.json) {
          console.log(
            JSON.stringify(cliJsonEnvelope('files', { files: [], reason: 'no_matches' }), null, 2),
          );
        } else {
          info('No files found matching the criteria.');
        }
        cg.destroy();
        return;
      }

      // JSON output
      if (options.json) {
        const output = files.map(f => ({
          path: f.path,
          language: f.language,
          nodeCount: f.nodeCount,
          size: f.size,
        }));
        console.log(JSON.stringify(cliJsonEnvelope('files', { files: output }), null, 2));
        cg.destroy();
        return;
      }

      const includeMetadata = options.metadata !== false;
      const format = options.format || 'tree';
      const maxDepth = options.maxDepth ? parseInt(options.maxDepth, 10) : undefined;

      // Format output
      switch (format) {
        case 'flat':
          console.log(chalk.bold(`\nFiles (${files.length}):\n`));
          for (const file of files.sort((a, b) => a.path.localeCompare(b.path))) {
            if (includeMetadata) {
              console.log(`  ${file.path} ${chalk.dim(`(${file.language}, ${file.nodeCount} symbols)`)}`);
            } else {
              console.log(`  ${file.path}`);
            }
          }
          break;

        case 'grouped':
          console.log(chalk.bold(`\nFiles by Language (${files.length} total):\n`));
          const byLang = new Map<string, typeof files>();
          for (const file of files) {
            const existing = byLang.get(file.language) || [];
            existing.push(file);
            byLang.set(file.language, existing);
          }
          const sortedLangs = [...byLang.entries()].sort((a, b) => b[1].length - a[1].length);
          for (const [lang, langFiles] of sortedLangs) {
            console.log(chalk.cyan(`${lang} (${langFiles.length}):`));
            for (const file of langFiles.sort((a, b) => a.path.localeCompare(b.path))) {
              if (includeMetadata) {
                console.log(`  ${file.path} ${chalk.dim(`(${file.nodeCount} symbols)`)}`);
              } else {
                console.log(`  ${file.path}`);
              }
            }
            console.log();
          }
          break;

        case 'tree':
        default:
          console.log(chalk.bold(`\nProject Structure (${files.length} files):\n`));
          printFileTree(files, includeMetadata, maxDepth, chalk);
          break;
      }

      console.log();
      cg.destroy();
    } catch (err) {
      error(`Failed to list files: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * Convert glob pattern to regex
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');
  return new RegExp(escaped);
}

/**
 * Print files as a tree
 */
function printFileTree(
  files: { path: string; language: string; nodeCount: number }[],
  includeMetadata: boolean,
  maxDepth: number | undefined,
  chalk: { dim: (s: string) => string; cyan: (s: string) => string }
): void {
  interface TreeNode {
    name: string;
    children: Map<string, TreeNode>;
    file?: { language: string; nodeCount: number };
  }

  const root: TreeNode = { name: '', children: new Map() };

  for (const file of files) {
    const parts = file.path.split('/');
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue;

      if (!current.children.has(part)) {
        current.children.set(part, { name: part, children: new Map() });
      }
      current = current.children.get(part)!;

      if (i === parts.length - 1) {
        current.file = { language: file.language, nodeCount: file.nodeCount };
      }
    }
  }

  const renderNode = (node: TreeNode, prefix: string, isLast: boolean, depth: number): void => {
    if (maxDepth !== undefined && depth > maxDepth) return;

    const glyphs = getGlyphs();
    const connector = isLast ? glyphs.treeLast : glyphs.treeBranch;
    const childPrefix = isLast ? '    ' : glyphs.treePipe;

    if (node.name) {
      let line = prefix + connector + node.name;
      if (node.file && includeMetadata) {
        line += chalk.dim(` (${node.file.language}, ${node.file.nodeCount} symbols)`);
      }
      console.log(line);
    }

    const children = [...node.children.values()];
    children.sort((a, b) => {
      const aIsDir = a.children.size > 0 && !a.file;
      const bIsDir = b.children.size > 0 && !b.file;
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      const nextPrefix = node.name ? prefix + childPrefix : prefix;
      renderNode(child, nextPrefix, i === children.length - 1, depth + 1);
    }
  };

  renderNode(root, '', true, 0);
}

/**
 * codegraph inventory [path]
 */
program
  .command('inventory [path]')
  .description('Summarize rewrite-relevant repository artifacts')
  .option('-j, --json', 'Output as JSON')
  .option('-n, --max-artifacts <number>', 'Maximum artifacts to print in text mode', '50')
  .action(async (pathArg: string | undefined, options: { json?: boolean; maxArtifacts?: string }) => {
    const projectPath = resolveProjectPath(pathArg);
    const maxArtifactsRaw = options.maxArtifacts ?? '50';
    const maxArtifactsParsed = Number.parseInt(maxArtifactsRaw, 10);
    if (!Number.isFinite(maxArtifactsParsed) || maxArtifactsParsed < 0 || String(maxArtifactsParsed) !== maxArtifactsRaw.trim()) {
      error(`Invalid --max-artifacts: ${maxArtifactsRaw}`);
      process.exit(1);
    }
    const maxArtifacts = maxArtifactsParsed;

    if (!isInitialized(projectPath)) {
      error(`CodeGraph not initialized in ${projectPath}`);
      info('Run "codegraph init --index" first');
      process.exit(1);
    }

    const { default: CodeGraph, buildRepositoryInventory } = await loadCodeGraph();
    const cg = await CodeGraph.open(projectPath);
    try {
      const inventory = buildRepositoryInventory(cg, projectPath);

      if (options.json) {
        // PF-613: wrap with the shared CLI JSON envelope. The
        // inventory's own `schemaVersion: 1` is preserved inside the
        // payload (its semantics describe the inventory shape, not
        // the CLI envelope shape — they're independent contracts).
        console.log(JSON.stringify(cliJsonEnvelope('inventory', { inventory }), null, 2));
        return;
      }
      console.log(chalk.bold('\nRepository Inventory\n'));
      console.log(chalk.cyan('Project:'), inventory.projectPath);
      console.log();
      console.log(chalk.bold('Summary:'));
      console.log(`  Files:             ${formatNumber(inventory.summary.files)}`);
      console.log(`  Nodes:             ${formatNumber(inventory.summary.nodes)}`);
      console.log(`  Edges:             ${formatNumber(inventory.summary.edges)}`);
      console.log(`  Packages:          ${formatNumber(inventory.summary.packages)}`);
      console.log(`  Config files:      ${formatNumber(inventory.summary.configs)}`);
      console.log(`  Routes:            ${formatNumber(inventory.summary.routes)}`);
      console.log(`  Components:        ${formatNumber(inventory.summary.components)}`);
      console.log(`  Exported symbols:  ${formatNumber(inventory.summary.exportedSymbols)}`);
      console.log(`  Test files:        ${formatNumber(inventory.summary.testFiles)}`);
      console.log();

      if (inventory.packages.length > 0) {
        console.log(chalk.bold('Packages:'));
        for (const pkg of inventory.packages) {
          const label = pkg.name ? `${pkg.name} ` : '';
          console.log(`  ${label}${chalk.dim(pkg.path)}`);
        }
        console.log();
      }

      if (maxArtifacts > 0) {
        console.log(chalk.bold(`Artifacts (${Math.min(maxArtifacts, inventory.artifacts.length)} of ${inventory.artifacts.length}):`));
        for (const artifact of inventory.artifacts.slice(0, maxArtifacts)) {
          const loc = artifact.startLine ? `:${artifact.startLine}` : '';
          console.log(`  ${artifact.kind.padEnd(15)} ${artifact.name} ${chalk.dim(`${artifact.path}${loc}`)}`);
        }
        if (inventory.artifacts.length > maxArtifacts) {
          info('Use --json for the full inventory, or increase --max-artifacts');
        }
        console.log();
      }
    } catch (err) {
      error(`Failed to build inventory: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    } finally {
      cg.destroy();
    }
  });

/**
 * codegraph context <task>
 */
program
  .command('context <task>')
  .description('Build context for a task (outputs markdown)')
  .option('-p, --path <path>', 'Project path')
  .option('-n, --max-nodes <number>', 'Maximum nodes to include', '50')
  .option('-c, --max-code <number>', 'Maximum code blocks', '10')
  .option('--no-code', 'Exclude code blocks')
  .option('-f, --format <format>', 'Output format (markdown, json)', 'markdown')
  .action(async (task: string, options: {
    path?: string;
    maxNodes?: string;
    maxCode?: string;
    code?: boolean;
    format?: string;
  }) => {
    const projectPath = resolveProjectPath(options.path);

    try {
      if (!isInitialized(projectPath)) {
        error(`CodeGraph not initialized in ${projectPath}`);
        process.exit(1);
      }

      const { default: CodeGraph } = await loadCodeGraph();
      const cg = await CodeGraph.open(projectPath);

      const context = await cg.buildContext(task, {
        maxNodes: parseInt(options.maxNodes || '50', 10),
        maxCodeBlocks: parseInt(options.maxCode || '10', 10),
        includeCode: options.code !== false,
        format: options.format as 'markdown' | 'json',
      });

      // Output the context
      console.log(context);

      cg.destroy();
    } catch (err) {
      error(`Failed to build context: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * codegraph serve
 */
program
  .command('serve')
  .description('Start CodeGraph as an MCP server for AI assistants')
  .option('-p, --path <path>', 'Project path (optional for MCP mode, uses rootUri from client)')
  .option('--mcp', 'Run as MCP server (stdio transport)')
  .option('--no-watch', 'Disable the file watcher (no auto-sync; useful on slow filesystems like WSL2 /mnt drives)')
  .option(
    '--allow-root <path>',
    'Additional project root to allow for cross-project MCP tool calls (repeatable). ' +
      'The default --path root is always allowed.',
    collectOption,
    [] as string[],
  )
  .option(
    '--allow-any',
    'Allow MCP tool calls to open any reachable project (pre-PF-619 behavior). Off by default.',
  )
  .action(async (options: { path?: string; mcp?: boolean; watch?: boolean; allowRoot?: string[]; allowAny?: boolean }) => {
    const projectPath = options.path ? resolveProjectPath(options.path) : undefined;

    // Commander sets watch=false when --no-watch is passed. Route it through
    // the same env-var chokepoint the watcher and MCP server already honor.
    if (options.watch === false) {
      process.env.CODEGRAPH_NO_WATCH = '1';
    }

    try {
      if (options.mcp) {
        // Start MCP server - it handles initialization lazily based on rootUri from client
        const { MCPServer } = await import('../mcp/index');
        const { parseAllowRootsEnv, parseAllowAnyEnv } = await import('../mcp/project-access');
        const flagRoots = options.allowRoot ?? [];
        const envRoots = parseAllowRootsEnv(process.env.CODEGRAPH_MCP_ALLOW_ROOTS);
        const extraAllowRoots = [...flagRoots, ...envRoots]
          .map((p) => resolveProjectPath(p));
        const allowAny = Boolean(options.allowAny) || parseAllowAnyEnv(process.env.CODEGRAPH_MCP_ALLOW_ANY);
        const server = new MCPServer({ projectPath, extraAllowRoots, allowAny });
        await server.start();
        // Server will run until terminated
      } else {
        // Default: show info about MCP mode.
        // Use stderr so stdout stays clean for any piped/stdio usage.
        console.error(chalk.bold('\nCodeGraph MCP Server\n'));
        console.error(chalk.blue(getGlyphs().info) + ' Use --mcp flag to start the MCP server');
        console.error('\nTo use with Claude Code, add to your MCP configuration:');
        console.error(chalk.dim(`
{
  "mcpServers": {
    "codegraph": {
      "command": "codegraph",
      "args": ["serve", "--mcp"]
    }
  }
}
`));
        console.error('Available tools:');
        console.error(chalk.cyan('  codegraph_search') + '    - Search for code symbols');
        console.error(chalk.cyan('  codegraph_context') + '   - Build context for a task');
        console.error(chalk.cyan('  codegraph_callers') + '   - Find callers of a symbol');
        console.error(chalk.cyan('  codegraph_callees') + '   - Find what a symbol calls');
        console.error(chalk.cyan('  codegraph_impact') + '    - Analyze impact of changes');
        console.error(chalk.cyan('  codegraph_node') + '      - Get symbol details');
        console.error(chalk.cyan('  codegraph_files') + '     - Get project file structure');
        console.error(chalk.cyan('  codegraph_status') + '    - Get index status');
      }
    } catch (err) {
      error(`Failed to start server: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * codegraph unlock [path]
 */
program
  .command('unlock [path]')
  .description('Remove a stale lock file that is blocking indexing')
  .action(async (pathArg: string | undefined) => {
    const projectPath = resolveProjectPath(pathArg);

    try {
      if (!isInitialized(projectPath)) {
        error(`CodeGraph not initialized in ${projectPath}`);
        return;
      }

      const lockPath = path.join(getCodeGraphDir(projectPath), 'codegraph.lock');

      if (!fs.existsSync(lockPath)) {
        info(`No lock file found ${getGlyphs().dash} nothing to do`);
        return;
      }

      fs.unlinkSync(lockPath);
      success('Removed lock file. You can now run indexing again.');
    } catch (err) {
      error(`Failed to remove lock: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * codegraph callers <symbol>
 *
 * CLI parity with the MCP graph tools (codegraph_callers/callees/impact) so the
 * traversal queries work in scripts, CI, and git hooks without a running MCP
 * server.
 */
program
  .command('callers <symbol>')
  .description('Find all functions/methods that call a specific symbol')
  .option('-p, --path <path>', 'Project path')
  .option('-l, --limit <number>', 'Maximum results', '20')
  .option('-j, --json', 'Output as JSON')
  .action(async (symbol: string, options: { path?: string; limit?: string; json?: boolean }) => {
    const projectPath = resolveProjectPath(options.path);

    try {
      if (!isInitialized(projectPath)) {
        error(`CodeGraph not initialized in ${projectPath}`);
        process.exit(1);
      }

      const { default: CodeGraph } = await loadCodeGraph();
      const cg = await CodeGraph.open(projectPath);
      const limit = parseInt(options.limit || '20', 10);

      const matches = cg.searchNodes(symbol, { limit: 50 });
      if (matches.length === 0) {
        if (options.json) {
          console.log(
            JSON.stringify(
              cliJsonEnvelope('callers', { symbol, callers: [], notFound: true }),
              null,
              2,
            ),
          );
        } else {
          info(`Symbol "${symbol}" not found`);
        }
        cg.destroy();
        return;
      }

      const grouped = collectGraphRelations(
        matches,
        symbol,
        (id) => cg.getCallers(id)
      );

      const limited = grouped.slice(0, limit);

      if (options.json) {
        console.log(JSON.stringify(cliJsonEnvelope('callers', { symbol, callers: limited }), null, 2));
      } else if (limited.length === 0) {
        info(`No callers found for "${symbol}"`);
      } else {
        console.log(chalk.bold(`\nCallers of "${symbol}" (${limited.length}):\n`));
        for (const entry of limited) {
          const loc = entry.startLine ? `:${entry.startLine}` : '';
          const provenance = formatEdgeProvenance(entry._edge);
          console.log(
            chalk.cyan(entry.kind.padEnd(12)) +
            chalk.white(entry.name) +
            (provenance ? '  ' + chalk.dim(provenance) : '')
          );
          console.log(chalk.dim(`  ${entry.filePath}${loc}`));
          console.log();
        }
      }

      cg.destroy();
    } catch (err) {
      error(`callers failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * codegraph callees <symbol>
 */
program
  .command('callees <symbol>')
  .description('Find all functions/methods that a specific symbol calls')
  .option('-p, --path <path>', 'Project path')
  .option('-l, --limit <number>', 'Maximum results', '20')
  .option('-j, --json', 'Output as JSON')
  .action(async (symbol: string, options: { path?: string; limit?: string; json?: boolean }) => {
    const projectPath = resolveProjectPath(options.path);

    try {
      if (!isInitialized(projectPath)) {
        error(`CodeGraph not initialized in ${projectPath}`);
        process.exit(1);
      }

      const { default: CodeGraph } = await loadCodeGraph();
      const cg = await CodeGraph.open(projectPath);
      const limit = parseInt(options.limit || '20', 10);

      const matches = cg.searchNodes(symbol, { limit: 50 });
      if (matches.length === 0) {
        if (options.json) {
          console.log(
            JSON.stringify(
              cliJsonEnvelope('callees', { symbol, callees: [], notFound: true }),
              null,
              2,
            ),
          );
        } else {
          info(`Symbol "${symbol}" not found`);
        }
        cg.destroy();
        return;
      }

      const grouped = collectGraphRelations(
        matches,
        symbol,
        (id) => cg.getCallees(id)
      );

      const limited = grouped.slice(0, limit);

      if (options.json) {
        console.log(JSON.stringify(cliJsonEnvelope('callees', { symbol, callees: limited }), null, 2));
      } else if (limited.length === 0) {
        info(`No callees found for "${symbol}"`);
      } else {
        console.log(chalk.bold(`\nCallees of "${symbol}" (${limited.length}):\n`));
        for (const entry of limited) {
          const loc = entry.startLine ? `:${entry.startLine}` : '';
          const provenance = formatEdgeProvenance(entry._edge);
          console.log(
            chalk.cyan(entry.kind.padEnd(12)) +
            chalk.white(entry.name) +
            (provenance ? '  ' + chalk.dim(provenance) : '')
          );
          console.log(chalk.dim(`  ${entry.filePath}${loc}`));
          console.log();
        }
      }

      cg.destroy();
    } catch (err) {
      error(`callees failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * codegraph impact <symbol>
 */
program
  .command('impact <symbol>')
  .description('Analyze what code is affected by changing a symbol')
  .option('-p, --path <path>', 'Project path')
  .option('-d, --depth <number>', 'Traversal depth', '2')
  .option('-j, --json', 'Output as JSON')
  .action(async (symbol: string, options: { path?: string; depth?: string; json?: boolean }) => {
    const projectPath = resolveProjectPath(options.path);

    try {
      if (!isInitialized(projectPath)) {
        error(`CodeGraph not initialized in ${projectPath}`);
        process.exit(1);
      }

      const { default: CodeGraph } = await loadCodeGraph();
      const cg = await CodeGraph.open(projectPath);
      // Validate --depth early so the not-found JSON branch can never emit
      // depth=NaN (which would serialize as null and violate impact.json's
      // schema). NaN propagates through Math.min/max, so check up front.
      const depthRaw = options.depth ?? '2';
      const depthParsed = parseInt(depthRaw, 10);
      if (!Number.isFinite(depthParsed)) {
        error(`Invalid --depth: ${depthRaw}`);
        process.exit(1);
      }
      const depth = Math.min(Math.max(depthParsed, 1), 10);

      const matches = cg.searchNodes(symbol, { limit: 50 });
      if (matches.length === 0) {
        if (options.json) {
          console.log(
            JSON.stringify(
              cliJsonEnvelope('impact', {
                symbol,
                depth,
                nodeCount: 0,
                edgeCount: 0,
                affected: [],
                notFound: true,
              }),
              null,
              2,
            ),
          );
        } else {
          info(`Symbol "${symbol}" not found`);
        }
        cg.destroy();
        return;
      }

      // Merge impact subgraphs across all exact-matching symbols
      const mergedNodes = new Map<string, { name: string; kind: string; filePath: string; startLine?: number }>();
      const dedupedEdges = new Map<string, Edge>();

      for (const match of matches) {
        const exactMatch = match.node.name === symbol || match.node.name.endsWith(`.${symbol}`) || match.node.name.endsWith(`::${symbol}`);
        if (!exactMatch && matches.length > 1) continue;
        const impact = cg.getImpactRadius(match.node.id, depth);
        for (const [id, n] of impact.nodes) {
          mergedNodes.set(id, { name: n.name, kind: n.kind, filePath: n.filePath, startLine: n.startLine });
        }
        for (const e of impact.edges) {
          const key = `${e.source}->${e.target}:${e.kind}`;
          if (!dedupedEdges.has(key)) {
            dedupedEdges.set(key, e);
          }
        }
      }

      // Fallback to top match if exact filter removed everything
      if (mergedNodes.size === 0 && matches[0]) {
        const impact = cg.getImpactRadius(matches[0].node.id, depth);
        for (const [id, n] of impact.nodes) {
          mergedNodes.set(id, { name: n.name, kind: n.kind, filePath: n.filePath, startLine: n.startLine });
        }
        for (const e of impact.edges) {
          const key = `${e.source}->${e.target}:${e.kind}`;
          if (!dedupedEdges.has(key)) {
            dedupedEdges.set(key, e);
          }
        }
      }

      const edges = [...dedupedEdges.values()];
      const lowConf: LowConfidenceSummary = summarizeLowConfidenceEdges(edges);

      // Resolve example node IDs to filePath:startLine for human-readable
      // text output. Raw IDs are useless for verifying against source.
      const formatExampleEndpoint = (nodeId: string, edgeLine?: number): string => {
        const node = mergedNodes.get(nodeId);
        if (!node) return nodeId;
        const loc = edgeLine ?? node.startLine;
        return loc ? `${node.filePath}:${loc}` : node.filePath;
      };

      // Enrich JSON examples with sourceLocation / targetLocation so
      // programmatic consumers see source-verifiable paths next to the
      // raw IDs (raw IDs preserved for callers that key off them).
      const lowConfJson = {
        ...lowConf,
        examples: lowConf.examples.map((ex) => ({
          ...ex,
          sourceLocation: formatExampleEndpoint(ex.source, ex.line),
          targetLocation: formatExampleEndpoint(ex.target),
        })),
      };

      if (options.json) {
        console.log(JSON.stringify(cliJsonEnvelope('impact', {
          symbol,
          depth,
          nodeCount: mergedNodes.size,
          edgeCount: edges.length,
          affected: Array.from(mergedNodes.values()),
          lowConfidenceEdges: lowConfJson,
        }), null, 2));
      } else if (mergedNodes.size === 0) {
        info(`No affected symbols found for "${symbol}"`);
      } else {
        console.log(chalk.bold(`\nImpact of changing "${symbol}" — ${mergedNodes.size} affected symbols:\n`));

        // Group by file
        const byFile = new Map<string, Array<{ name: string; kind: string; startLine?: number }>>();
        for (const node of mergedNodes.values()) {
          const list = byFile.get(node.filePath) || [];
          list.push({ name: node.name, kind: node.kind, startLine: node.startLine });
          byFile.set(node.filePath, list);
        }

        for (const [file, nodes] of byFile) {
          console.log(chalk.cyan(file));
          for (const node of nodes) {
            const loc = node.startLine ? `:${node.startLine}` : '';
            console.log(`  ${chalk.dim(node.kind.padEnd(12))}${node.name}${chalk.dim(loc)}`);
          }
          console.log();
        }

        if (lowConf.count > 0) {
          console.log(
            chalk.yellow(`⚠ ${lowConf.count} of ${edges.length} edges have confidence < ${lowConf.threshold.toFixed(2)} — verify against source.`),
          );
          for (const ex of lowConf.examples) {
            const reason = ex.resolvedBy ? `${ex.resolvedBy} ${ex.confidence.toFixed(2)}` : ex.confidence.toFixed(2);
            const sourceLoc = formatExampleEndpoint(ex.source, ex.line);
            const targetLoc = formatExampleEndpoint(ex.target);
            console.log(chalk.dim(`  - [${reason}] ${ex.kind}: ${sourceLoc} → ${targetLoc}`));
          }
          console.log();
        }
      }

      cg.destroy();
    } catch (err) {
      error(`impact failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * codegraph affected [files...]
 *
 * Find test files affected by the given source files.
 * Traces dependency edges transitively to find test files that depend on changed code.
 *
 * Usage:
 *   git diff --name-only | codegraph affected --stdin
 *   codegraph affected src/lib/components/Editor.svelte src/routes/+page.svelte
 */
program
  .command('affected [files...]')
  .description('Find test files affected by changed source files')
  .option('-p, --path <path>', 'Project path')
  .option('--stdin', 'Read file list from stdin (one per line)')
  .option('-d, --depth <number>', 'Max dependency traversal depth', '5')
  .option('-f, --filter <glob>', 'Custom glob filter for test files (e.g. "e2e/*.spec.ts")')
  .option('-j, --json', 'Output as JSON')
  .option('-q, --quiet', 'Only output file paths, no decoration')
  .action(async (fileArgs: string[], options: { path?: string; stdin?: boolean; depth?: string; filter?: string; json?: boolean; quiet?: boolean }) => {
    const projectPath = resolveProjectPath(options.path);

    try {
      if (!isInitialized(projectPath)) {
        error(`CodeGraph not initialized in ${projectPath}`);
        process.exit(1);
      }

      // Collect changed files from args or stdin
      let changedFiles: string[] = [...(fileArgs || [])];

      if (options.stdin) {
        const stdinData = fs.readFileSync(0, 'utf-8');
        const stdinFiles = stdinData.split('\n').map(f => f.trim()).filter(Boolean);
        changedFiles.push(...stdinFiles);
      }

      if (changedFiles.length === 0) {
        if (options.json) {
          console.log(
            JSON.stringify(
              cliJsonEnvelope('affected', {
                changedFiles: [],
                affectedTests: [],
                totalDependentsTraversed: 0,
              }),
              null,
              2,
            ),
          );
        } else if (!options.quiet) {
          info('No files provided. Use file arguments or --stdin.');
        }
        process.exit(0);
      }

      const { default: CodeGraph } = await loadCodeGraph();
      const cg = await CodeGraph.open(projectPath);
      // Same NaN guard as `impact --depth`: NaN >= NaN is always false,
      // which silently disables the BFS depth cap. Reject early instead.
      const maxDepthRaw = options.depth ?? '5';
      const maxDepth = parseInt(maxDepthRaw, 10);
      if (!Number.isFinite(maxDepth)) {
        error(`Invalid --depth: ${maxDepthRaw}`);
        process.exit(1);
      }

      // Common test file patterns
      const defaultTestPatterns = [
        /\.spec\./,
        /\.test\./,
        /\/__tests__\//,
        /\/tests?\//,
        /\/e2e\//,
        /\/spec\//,
      ];

      // Custom filter pattern
      let customFilter: RegExp | null = null;
      if (options.filter) {
        // Convert glob to regex: ** → .+, * → [^/]*, . → \.
        const regex = options.filter
          .replace(/[+[\]{}()^$|\\]/g, '\\$&')
          .replace(/\./g, '\\.')
          .replace(/\*\*/g, '.+')
          .replace(/\*/g, '[^/]*');
        customFilter = new RegExp(regex);
      }

      function isTestFile(filePath: string): boolean {
        if (customFilter) return customFilter.test(filePath);
        return defaultTestPatterns.some(p => p.test(filePath));
      }

      // BFS to find all transitive dependents of changed files, filtered to test files
      const affectedTests = new Set<string>();
      const allDependents = new Set<string>();

      for (const file of changedFiles) {
        // If the changed file is itself a test file, include it
        if (isTestFile(file)) {
          affectedTests.add(file);
          continue;
        }

        // BFS through dependents
        const queue: Array<{ file: string; depth: number }> = [{ file, depth: 0 }];
        const visited = new Set<string>();
        visited.add(file);

        while (queue.length > 0) {
          const current = queue.shift()!;
          if (current.depth >= maxDepth) continue;

          const dependents = cg.getAffectedFileDependents(current.file);
          for (const dep of dependents) {
            if (visited.has(dep)) continue;
            visited.add(dep);
            allDependents.add(dep);

            if (isTestFile(dep)) {
              affectedTests.add(dep);
            } else {
              queue.push({ file: dep, depth: current.depth + 1 });
            }
          }
        }
      }

      const sortedTests = Array.from(affectedTests).sort();

      // Output
      if (options.json) {
        console.log(JSON.stringify(cliJsonEnvelope('affected', {
          changedFiles,
          affectedTests: sortedTests,
          totalDependentsTraversed: allDependents.size,
        }), null, 2));
      } else if (options.quiet) {
        for (const t of sortedTests) console.log(t);
      } else {
        if (sortedTests.length === 0) {
          info('No test files affected by the changed files.');
        } else {
          console.log(chalk.bold(`\nAffected test files (${sortedTests.length}):\n`));
          for (const t of sortedTests) {
            console.log('  ' + chalk.cyan(t));
          }
          console.log();
        }
      }

      cg.destroy();
    } catch (err) {
      error(`Affected analysis failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * codegraph install
 */
program
  .command('install')
  .description('Install codegraph MCP server into one or more agents (Claude Code, Cursor, Codex CLI, opencode, Hermes Agent)')
  .option('-t, --target <ids>', 'Target agent(s): comma-separated ids, or "auto"|"all"|"none". Default: prompt')
  .option('-l, --location <where>', 'Install location: "global" or "local". Default: prompt')
  .option('-y, --yes', 'Non-interactive: defaults to --location=global --target=auto, auto-allow on')
  .option('--no-permissions', 'Skip writing the auto-allow permissions list (Claude Code only)')
  .option('--print-config <id>', 'Print MCP config snippet for the named agent and exit (no file writes)')
  .action(async (opts: {
    target?: string;
    location?: string;
    yes?: boolean;
    permissions?: boolean;
    printConfig?: string;
  }) => {
    if (opts.printConfig) {
      const { getTarget, listTargetIds } = await import('../installer/targets/registry');
      const target = getTarget(opts.printConfig);
      if (!target) {
        const known = listTargetIds().join(', ');
        error(`Unknown target "${opts.printConfig}". Known: ${known}.`);
        process.exit(1);
      }
      const loc = (opts.location === 'local' ? 'local' : 'global') as 'global' | 'local';
      process.stdout.write(target.printConfig(loc));
      return;
    }

    const { runInstallerWithOptions } = await import('../installer');
    if (opts.location && opts.location !== 'global' && opts.location !== 'local') {
      error(`--location must be "global" or "local" (got "${opts.location}").`);
      process.exit(1);
    }
    try {
      // Commander's `--no-permissions` makes `opts.permissions === false`;
      // omitting the flag leaves it `true` (the positive-form default).
      // We MUST treat the default-true as "user did not override — let
      // the orchestrator prompt" and only forward an explicit `false`
      // (or `true` when --yes implies it). Otherwise the auto-allow
      // prompt is silently skipped on every interactive run.
      const explicitNoPermissions = opts.permissions === false;
      const autoAllow: boolean | undefined = explicitNoPermissions
        ? false
        : opts.yes
          ? true
          : undefined;

      await runInstallerWithOptions({
        target: opts.target,
        location: opts.location as 'global' | 'local' | undefined,
        autoAllow,
        yes: opts.yes,
      });
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

/**
 * codegraph uninstall
 *
 * Inverse of `install`. Removes the codegraph MCP server entry,
 * instructions block, and permissions from every agent (or a
 * `--target` subset). Prompts global-vs-local when not given. Does NOT
 * delete the `.codegraph/` index — that's `codegraph uninit`.
 */
program
  .command('uninstall')
  .description('Remove codegraph from your agents (Claude Code, Cursor, Codex CLI, opencode, Hermes Agent)')
  .option('-t, --target <ids>', 'Target agent(s): comma-separated ids, or "all". Default: all')
  .option('-l, --location <where>', 'Uninstall location: "global" or "local". Default: prompt')
  .option('-y, --yes', 'Non-interactive: defaults to --location=global --target=all')
  .action(async (opts: {
    target?: string;
    location?: string;
    yes?: boolean;
  }) => {
    const { runUninstaller } = await import('../installer');
    if (opts.location && opts.location !== 'global' && opts.location !== 'local') {
      error(`--location must be "global" or "local" (got "${opts.location}").`);
      process.exit(1);
    }
    try {
      await runUninstaller({
        target: opts.target,
        location: opts.location as 'global' | 'local' | undefined,
        yes: opts.yes,
      });
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// Parse and run
program.parse();

} // end main()
