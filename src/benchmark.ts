import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { performance } from 'perf_hooks';
import CodeGraph from './index';
import { getCodeGraphDir, isInitialized, removeDirectory } from './directory';
import { IndexResult } from './extraction';
import { Node, SearchResult } from './types';

export type BenchmarkQueryKind = 'search' | 'context' | 'callers' | 'callees' | 'impact';

export interface ParsedBenchmarkQuery {
  kind: BenchmarkQueryKind;
  input: string;
}

export interface BenchmarkOptions {
  cold?: boolean;
  reindex?: boolean;
  force?: boolean;
  cleanup?: boolean;
  queries?: string[];
  queryLimit?: number;
  contextMaxNodes?: number;
  includeContextCode?: boolean;
}

export interface BenchmarkQueryResult {
  spec: string;
  kind: BenchmarkQueryKind;
  input: string;
  durationMs: number;
  ok: boolean;
  resultCount?: number;
  nodeCount?: number;
  edgeCount?: number;
  outputBytes?: number;
  error?: string;
}

export interface BenchmarkReport {
  schemaVersion: 1;
  projectPath: string;
  startedAt: string;
  environment: {
    node: string;
    platform: NodeJS.Platform;
    arch: string;
    cpuCount: number;
  };
  mode: {
    hadIndexBefore: boolean;
    hadCodeGraphDirBefore: boolean;
    createdIndex: boolean;
    cold: boolean;
    reindexed: boolean;
    cleanupRequested: boolean;
    cleanedUp: boolean;
  };
  timings: {
    totalMs: number;
    indexMs?: number;
    statusMs: number;
  };
  memory: {
    startRssBytes: number;
    peakRssBytes: number;
    endRssBytes: number;
  };
  indexResult?: IndexResult;
  stats: {
    fileCount: number;
    nodeCount: number;
    edgeCount: number;
    dbSizeBytes: number;
    nodesByKind: Record<string, number>;
    languages: string[];
  };
  indexSafety: {
    sensitiveFilesSkipped: number;
    sensitiveFilesByReason: Record<string, number>;
  };
  queries: BenchmarkQueryResult[];
}

const QUERY_KINDS = new Set<BenchmarkQueryKind>(['search', 'context', 'callers', 'callees', 'impact']);

class MemorySampler {
  private peak = process.memoryUsage().rss;
  private readonly timer: NodeJS.Timeout;

  constructor() {
    this.timer = setInterval(() => {
      this.peak = Math.max(this.peak, process.memoryUsage().rss);
    }, 50);
    this.timer.unref();
  }

  stop(): number {
    clearInterval(this.timer);
    this.peak = Math.max(this.peak, process.memoryUsage().rss);
    return this.peak;
  }
}

export function parseBenchmarkQuerySpec(spec: string): ParsedBenchmarkQuery {
  const separator = spec.indexOf(':');
  if (separator === -1) {
    const input = spec.trim();
    if (!input) {
      throw new Error('Benchmark query is empty.');
    }
    return { kind: 'search', input };
  }

  const kind = spec.slice(0, separator).trim().toLowerCase() as BenchmarkQueryKind;
  const input = spec.slice(separator + 1).trim();
  if (!QUERY_KINDS.has(kind)) {
    throw new Error(`Unsupported benchmark query kind "${kind}". Use search, context, callers, callees, or impact.`);
  }
  if (!input) {
    throw new Error(`Benchmark query "${spec}" is missing input after "${kind}:".`);
  }

  return { kind, input };
}

export async function runBenchmark(projectPath: string, options: BenchmarkOptions = {}): Promise<BenchmarkReport> {
  const resolvedPath = path.resolve(projectPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Benchmark project path does not exist: ${resolvedPath}`);
  }
  if (!fs.statSync(resolvedPath).isDirectory()) {
    throw new Error(`Benchmark project path is not a directory: ${resolvedPath}`);
  }

  const parsedQueries = (options.queries ?? []).map((spec) => ({
    spec,
    parsed: parseBenchmarkQuerySpec(spec),
  }));

  const codeGraphDir = getCodeGraphDir(resolvedPath);
  const startedAt = new Date().toISOString();
  const startRssBytes = process.memoryUsage().rss;
  const memory = new MemorySampler();
  const totalStart = performance.now();
  const hadCodeGraphDirBefore = fs.existsSync(codeGraphDir);
  const hadIndexBefore = isInitialized(resolvedPath);
  let createdIndex = false;
  let reindexed = false;
  let cleanedUp = false;
  let cleanupEligible = false;
  let cg: CodeGraph | null = null;
  let indexResult: IndexResult | undefined;

  const cleanupBenchmarkIndex = (): void => {
    if (!options.cleanup || !cleanupEligible || cleanedUp) return;
    removeDirectory(resolvedPath);
    cleanedUp = true;
  };

  try {
    if (options.cleanup && hadCodeGraphDirBefore && !hadIndexBefore && !options.force) {
      throw new Error('Cleanup is unsafe because .codegraph/ already exists without codegraph.db. Re-run with --force to allow removing it, or omit --cleanup.');
    }

    if (options.cold && hadIndexBefore) {
      if (!options.force) {
        throw new Error('Cold benchmark would remove an existing .codegraph index. Re-run with --force to allow it.');
      }
      removeDirectory(resolvedPath);
      cleanupEligible = true;
    }

    if (options.reindex && hadIndexBefore && !options.force) {
      throw new Error('Reindex benchmark would clear an existing .codegraph index. Re-run with --force to allow it.');
    }

    const indexStart = performance.now();
    const needsIndex = options.cold || options.reindex || !hadIndexBefore;
    if (needsIndex) {
      if (isInitialized(resolvedPath)) {
        cg = await CodeGraph.open(resolvedPath);
        cg.clear();
        reindexed = true;
      } else {
        cg = await CodeGraph.init(resolvedPath);
        createdIndex = true;
        cleanupEligible = !hadCodeGraphDirBefore || Boolean(options.force);
      }
      indexResult = await cg.indexAll();
    } else {
      cg = await CodeGraph.open(resolvedPath);
    }
    const indexMs = needsIndex ? performance.now() - indexStart : undefined;

    const statusStart = performance.now();
    const stats = cg.getStats();
    const safety = cg.getIndexSafetyStats();
    const statusMs = performance.now() - statusStart;

    const queries = [];
    for (const query of parsedQueries) {
      queries.push(await runBenchmarkQuery(cg, query.spec, query.parsed, options));
    }

    cg.destroy();
    cg = null;

    cleanupBenchmarkIndex();

    const endRssBytes = process.memoryUsage().rss;
    const peakRssBytes = memory.stop();

    return {
      schemaVersion: 1,
      projectPath: resolvedPath,
      startedAt,
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpuCount: os.cpus().length,
      },
      mode: {
        hadIndexBefore,
        hadCodeGraphDirBefore,
        createdIndex,
        cold: Boolean(options.cold || !hadIndexBefore),
        reindexed,
        cleanupRequested: Boolean(options.cleanup),
        cleanedUp,
      },
      timings: {
        totalMs: performance.now() - totalStart,
        indexMs,
        statusMs,
      },
      memory: {
        startRssBytes,
        peakRssBytes,
        endRssBytes,
      },
      indexResult,
      stats: {
        fileCount: stats.fileCount,
        nodeCount: stats.nodeCount,
        edgeCount: stats.edgeCount,
        dbSizeBytes: stats.dbSizeBytes,
        nodesByKind: stats.nodesByKind,
        languages: Object.entries(stats.filesByLanguage)
          .filter(([, count]) => count > 0)
          .map(([language]) => language),
      },
      indexSafety: {
        sensitiveFilesSkipped: safety.sensitiveFilesSkipped,
        sensitiveFilesByReason: { ...safety.sensitiveFilesByReason },
      },
      queries,
    };
  } finally {
    memory.stop();
    if (cg) {
      cg.destroy();
      cg = null;
    }
    cleanupBenchmarkIndex();
  }
}

async function runBenchmarkQuery(
  cg: CodeGraph,
  spec: string,
  parsed: ParsedBenchmarkQuery,
  options: BenchmarkOptions
): Promise<BenchmarkQueryResult> {
  const started = performance.now();

  try {
    switch (parsed.kind) {
      case 'search': {
        const results = cg.searchNodes(parsed.input, { limit: options.queryLimit ?? 20 });
        return queryResult(spec, parsed, started, { resultCount: results.length });
      }
      case 'context': {
        const context = await cg.buildContext(parsed.input, {
          maxNodes: options.contextMaxNodes ?? 50,
          includeCode: Boolean(options.includeContextCode),
          format: 'markdown',
        });
        const text = typeof context === 'string' ? context : JSON.stringify(context);
        return queryResult(spec, parsed, started, { outputBytes: Buffer.byteLength(text, 'utf8') });
      }
      case 'callers': {
        const nodes = findMatchingNodes(cg, parsed.input, options.queryLimit ?? 20);
        const callers = dedupeNodes(nodes.flatMap((node) => cg.getCallers(node.id).map((result) => result.node)));
        return queryResult(spec, parsed, started, { resultCount: callers.length });
      }
      case 'callees': {
        const nodes = findMatchingNodes(cg, parsed.input, options.queryLimit ?? 20);
        const callees = dedupeNodes(nodes.flatMap((node) => cg.getCallees(node.id).map((result) => result.node)));
        return queryResult(spec, parsed, started, { resultCount: callees.length });
      }
      case 'impact': {
        const nodes = findMatchingNodes(cg, parsed.input, options.queryLimit ?? 20);
        const mergedNodes = new Map<string, Node>();
        const mergedEdges = new Set<string>();
        for (const node of nodes) {
          const impact = cg.getImpactRadius(node.id, 2);
          for (const edge of impact.edges) {
            mergedEdges.add(`${edge.source}->${edge.target}:${edge.kind}:${edge.line ?? ''}:${edge.column ?? ''}`);
          }
          for (const [id, impactedNode] of impact.nodes) {
            mergedNodes.set(id, impactedNode);
          }
        }
        return queryResult(spec, parsed, started, { nodeCount: mergedNodes.size, edgeCount: mergedEdges.size });
      }
    }
  } catch (err) {
    return {
      spec,
      kind: parsed.kind,
      input: parsed.input,
      durationMs: performance.now() - started,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function queryResult(
  spec: string,
  parsed: ParsedBenchmarkQuery,
  started: number,
  counts: Pick<BenchmarkQueryResult, 'resultCount' | 'nodeCount' | 'edgeCount' | 'outputBytes'>
): BenchmarkQueryResult {
  return {
    spec,
    kind: parsed.kind,
    input: parsed.input,
    durationMs: performance.now() - started,
    ok: true,
    ...counts,
  };
}

function findMatchingNodes(cg: CodeGraph, symbol: string, limit: number): Node[] {
  const matches = cg.searchNodes(symbol, { limit });
  const exactMatches = matches.filter((match) => isExactSymbolMatch(match, symbol));
  return (exactMatches.length > 0 ? exactMatches.slice(0, limit) : matches.slice(0, 1)).map((match) => match.node);
}

function isExactSymbolMatch(match: SearchResult, symbol: string): boolean {
  return match.node.name === symbol
    || match.node.name.endsWith(`.${symbol}`)
    || match.node.name.endsWith(`::${symbol}`);
}

function dedupeNodes(nodes: Node[]): Node[] {
  const seen = new Set<string>();
  const deduped = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    deduped.push(node);
  }
  return deduped;
}
