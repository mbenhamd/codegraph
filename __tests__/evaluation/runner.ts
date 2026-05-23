import { execSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { findLiteralMatches, prepareStructuralFixture } from './fixtures.js';
import {
  scoreCandidates,
  scoreFindRelevantContext,
  scoreSearchNodes,
} from './scoring.js';
import { printResults, saveReport } from './reporting.js';
import { externalTestCases, structuralTestCases } from './test-cases.js';
import type { EvalEdge, EvalNode, EvalResult, EvalTestCase } from './types.js';

const evaluationDir = path.join(process.cwd(), '__tests__', 'evaluation');
const { CodeGraph } = require(path.join(process.cwd(), 'dist', 'index.js')) as {
  CodeGraph: {
    init(projectRoot: string, options: { index: boolean }): Promise<CodeGraphInstance>;
    openSync(projectRoot: string): CodeGraphInstance;
  };
};

interface CodeGraphInstance {
  close(): void;
  getProjectRoot(): string;
  searchNodes(
    query: string,
    options?: { limit?: number; kinds?: string[] } & Record<string, unknown>
  ): Array<{ node: EvalNode; score: number }>;
  findRelevantContext(
    query: string,
    options?: Record<string, unknown>
  ): Promise<{ nodes: Map<string, EvalNode>; edges: EvalEdge[]; roots: string[] }>;
  getCallers(nodeId: string, maxDepth?: number): Array<{ node: EvalNode; edge: EvalEdge }>;
  getCallees(nodeId: string, maxDepth?: number): Array<{ node: EvalNode; edge: EvalEdge }>;
  getImpactRadius(
    nodeId: string,
    maxDepth?: number
  ): { nodes: Map<string, EvalNode>; edges: EvalEdge[]; roots: string[] };
}

interface RunnerConfig {
  codebasePath: string;
  suiteName: 'external' | 'structural';
  testCases: EvalTestCase[];
  cleanupPath?: string;
  fixtureHash?: string;
  strictTracked: boolean;
}

async function resolveConfig(): Promise<RunnerConfig> {
  const fixtureName = getArgValue('--fixture');
  if (fixtureName) {
    if (fixtureName !== 'structural') {
      console.error(`Unknown fixture suite: ${fixtureName}`);
      process.exit(1);
    }
    const codebasePath = await prepareStructuralFixture(evaluationDir, CodeGraph);
    return {
      codebasePath,
      suiteName: 'structural',
      testCases: structuralTestCases,
      cleanupPath: codebasePath,
      fixtureHash: hashDirectory(codebasePath),
      strictTracked: hasFlag('--strict-tracked'),
    };
  }

  const codebasePath = process.env.EVAL_CODEBASE || getPositionalCodebasePath();
  if (!codebasePath) {
    console.error('Usage: EVAL_CODEBASE=/path/to/codebase npm run test:eval');
    console.error('   or: npm run test:eval -- /path/to/codebase');
    console.error('   or: npm run test:eval:structural');
    process.exit(1);
  }

  const resolvedPath = path.resolve(codebasePath);
  if (!fs.existsSync(path.join(resolvedPath, '.codegraph', 'codegraph.db'))) {
    console.error(`No .codegraph/codegraph.db found at ${resolvedPath}`);
    process.exit(1);
  }

  return {
    codebasePath: resolvedPath,
    suiteName: 'external',
    testCases: externalTestCases,
    strictTracked: hasFlag('--strict-tracked'),
  };
}

async function run() {
  const config = await resolveConfig();
  const resolvedPath = path.resolve(config.codebasePath);
  const codegraphSha = currentSha();

  console.log(`\nCodeGraph Eval — ${path.basename(resolvedPath)}`);
  console.log(`Codebase: ${resolvedPath}`);
  console.log(`Commit:   ${codegraphSha}`);
  console.log(`Suite:    ${config.suiteName}`);
  console.log(`Cases:    ${config.testCases.length}`);
  console.log('');

  let cg: CodeGraphInstance | null = null;
  const results: EvalResult[] = [];

  try {
    cg = CodeGraph.openSync(resolvedPath);
    for (const tc of config.testCases) {
      results.push(await runCase(cg, tc));
    }

    printResults(results);
    const reportPath = saveReport(
      results,
      reportCodebasePath(config, resolvedPath),
      codegraphSha,
      evaluationDir,
      commandLine(),
      config.fixtureHash
    );
    console.log(`\nReport saved: ${reportPath}`);
  } finally {
    cg?.close();
    if (config.cleanupPath && process.env.EVAL_KEEP_FIXTURE !== '1') {
      fs.rmSync(config.cleanupPath, { recursive: true, force: true });
    } else if (config.cleanupPath) {
      console.log(`Fixture retained: ${config.cleanupPath}`);
    }
  }

  const blockingFailures = results.filter((r) => r.blocking).length;
  const trackedFailures = config.strictTracked ? results.filter((r) => !r.required && !r.pass).length : 0;
  process.exit(blockingFailures > 0 || trackedFailures > 0 ? 1 : 0);
}

async function runCase(cg: CodeGraphInstance, tc: EvalTestCase): Promise<EvalResult> {
  const start = performance.now();

  if (tc.api === 'searchNodes') {
    const searchResults = cg.searchNodes(requiredQuery(tc), {
      limit: 10,
      kinds: tc.kinds,
      ...(tc.options as Record<string, unknown>),
    });
    return scoreSearchNodes(tc.id, tc.suite, tc.expectedSymbols, searchResults, performance.now() - start, {
      required: tc.required,
      strictPrecision: isStrictPrecisionCase(tc),
      expectedMatches: tc.expectedMatches,
      forbiddenSymbols: tc.forbiddenSymbols,
      noisePathPatterns: tc.noisePathPatterns,
      minRecall: tc.minRecall,
      maxLatencyMs: tc.maxLatencyMs,
    });
  }

  if (tc.api === 'findRelevantContext') {
    const subgraph = await cg.findRelevantContext(requiredQuery(tc), {
      searchLimit: 8,
      traversalDepth: 3,
      maxNodes: 80,
      minScore: 0.2,
      ...(tc.options as Record<string, unknown>),
    });
    return scoreFindRelevantContext(
      tc.id,
      tc.suite,
      tc.expectedSymbols,
      subgraph,
      performance.now() - start,
      {
        required: tc.required,
        strictPrecision: isStrictPrecisionCase(tc),
        expectedMatches: tc.expectedMatches,
        forbiddenSymbols: tc.forbiddenSymbols,
        noisePathPatterns: tc.noisePathPatterns,
        minRecall: tc.minRecall,
        maxLatencyMs: tc.maxLatencyMs,
      }
    );
  }

  if (tc.api === 'literalBypass') {
    const literalText = tc.literalText ?? requiredQuery(tc);
    const matches = findLiteralMatches(cg.getProjectRoot(), literalText);
    return scoreCandidates({
      caseId: tc.id,
      suite: tc.suite,
      api: tc.api,
      expectedSymbols: tc.expectedSymbols,
      expectedMatches: tc.expectedMatches,
      candidates: matches.map((filePath) => ({ name: filePath, filePath })),
      latencyMs: performance.now() - start,
      required: tc.required,
      strictPrecision: isStrictPrecisionCase(tc),
      minRecall: tc.minRecall,
      notes: ['literal task: use native text search instead of semantic graph lookup'],
    });
  }

  const target = findTargetNode(cg, tc);
  if (!target) {
    return scoreCandidates({
      caseId: tc.id,
      suite: tc.suite,
      api: tc.api,
      expectedSymbols: tc.expectedSymbols,
      expectedMatches: tc.expectedMatches,
      candidates: [],
      latencyMs: performance.now() - start,
      required: tc.required,
      strictPrecision: isStrictPrecisionCase(tc),
      targetSymbol: tc.targetSymbol,
      targetFilePath: tc.targetFilePath,
      minRecall: tc.minRecall,
      notes: [`target symbol not found: ${tc.targetSymbol ?? '<missing>'}`],
    });
  }

  const maxDepth = tc.maxDepth ?? 1;
  if (tc.api === 'callers') {
    const callers = cg.getCallers(target.id, maxDepth);
    return scoreGraphPairs(tc, target, callers, performance.now() - start);
  }

  if (tc.api === 'callees') {
    const callees = cg.getCallees(target.id, maxDepth);
    return scoreGraphPairs(tc, target, callees, performance.now() - start);
  }

  const impact = cg.getImpactRadius(target.id, maxDepth);
  return scoreCandidates({
    caseId: tc.id,
    suite: tc.suite,
    api: tc.api,
    expectedSymbols: tc.expectedSymbols,
    expectedMatches: tc.expectedMatches,
    candidates: [...impact.nodes.values()].filter(
      (node) => node.id !== target.id && node.kind !== 'file'
    ),
    edges: impact.edges,
    latencyMs: performance.now() - start,
    required: tc.required,
    strictPrecision: isStrictPrecisionCase(tc),
    forbiddenSymbols: tc.forbiddenSymbols,
    noisePathPatterns: tc.noisePathPatterns,
    targetSymbol: target.name,
    targetFilePath: target.filePath,
    minRecall: tc.minRecall,
    maxLatencyMs: tc.maxLatencyMs,
  });
}

function scoreGraphPairs(
  tc: EvalTestCase,
  target: EvalNode,
  pairs: Array<{ node: EvalNode; edge: EvalEdge }>,
  latencyMs: number
): EvalResult {
  return scoreCandidates({
    caseId: tc.id,
    suite: tc.suite,
    api: tc.api,
    expectedSymbols: tc.expectedSymbols,
    expectedMatches: tc.expectedMatches,
    candidates: pairs.map((pair) => pair.node),
    edges: pairs.map((pair) => pair.edge),
    latencyMs,
    required: tc.required,
    strictPrecision: isStrictPrecisionCase(tc),
    forbiddenSymbols: tc.forbiddenSymbols,
    noisePathPatterns: tc.noisePathPatterns,
    targetSymbol: target.name,
    targetFilePath: target.filePath,
    minRecall: tc.minRecall,
    maxLatencyMs: tc.maxLatencyMs,
  });
}

function findTargetNode(cg: CodeGraphInstance, tc: EvalTestCase): EvalNode | null {
  if (!tc.targetSymbol) return null;
  const results = cg.searchNodes(tc.targetSymbol, {
    limit: 50,
    kinds: tc.targetKinds,
  });
  if (tc.targetFilePath) {
    const exact = results.find(
      (result) => result.node.name === tc.targetSymbol && result.node.filePath === tc.targetFilePath
    );
    return exact?.node ?? null;
  }
  const exactName = results.find((result) => result.node.name === tc.targetSymbol);
  return exactName?.node ?? results[0]?.node ?? null;
}

function reportCodebasePath(config: RunnerConfig, resolvedPath: string): string {
  return config.suiteName === 'structural' ? 'structural-fixture' : resolvedPath;
}

function isStrictPrecisionCase(tc: EvalTestCase): boolean {
  return tc.suite === 'structural';
}

function requiredQuery(tc: EvalTestCase): string {
  if (!tc.query) {
    throw new Error(`${tc.id} requires a query`);
  }
  return tc.query;
}

function getArgValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function getPositionalCodebasePath(): string | undefined {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--fixture') {
      i += 1;
      continue;
    }
    if (arg === '--strict-tracked') continue;
    if (!arg.startsWith('-')) {
      return arg;
    }
  }
  return undefined;
}

function commandLine(): string {
  return process.argv.map((arg) => JSON.stringify(arg)).join(' ');
}

function hashDirectory(root: string): string {
  const hash = createHash('sha256');
  for (const filePath of listFiles(root)) {
    const relativePath = path.relative(root, filePath);
    if (relativePath.startsWith(`.codegraph${path.sep}`)) continue;
    hash.update(relativePath);
    hash.update('\0');
    hash.update(fs.readFileSync(filePath));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function listFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

function currentSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
  } catch {
    return 'unknown';
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
