import type { EvalApi, EvalEdge, EvalNode, EvalResult, EvalSuite } from './types.js';

// Structural evals measure several API families with different result shapes.
// Keep the historical 50% recall gate here; individual cases should use
// forbidden/noise checks when one missing symbol is unacceptable.
export const PASS_THRESHOLD = 0.5;

export interface CandidateNode {
  name: string;
  filePath?: string;
}

export interface ScoreInput {
  caseId: string;
  suite: EvalSuite;
  api: EvalApi;
  expectedSymbols: string[];
  expectedMatches?: Array<{ name: string; filePath?: string }>;
  candidates: CandidateNode[];
  latencyMs: number;
  required?: boolean;
  strictPrecision?: boolean;
  forbiddenSymbols?: string[];
  noisePathPatterns?: string[];
  edges?: EvalEdge[];
  mrr?: number;
  targetSymbol?: string;
  targetFilePath?: string;
  maxLatencyMs?: number;
  notes?: string[];
}

export function scoreCandidates(input: ScoreInput): EvalResult {
  const expectedSpecs = buildExpectedSpecs(input.expectedSymbols, input.expectedMatches);
  const forbiddenLower = new Set((input.forbiddenSymbols ?? []).map((s) => s.toLowerCase()));
  const noiseRegexes = (input.noisePathPatterns ?? []).map((pattern) => new RegExp(pattern));
  const required = input.required ?? true;

  const found: string[] = [];
  const missed: string[] = [];
  let firstRank = 0;

  for (let i = 0; i < expectedSpecs.length; i++) {
    const idx = input.candidates.findIndex((candidate) =>
      isExpectedCandidate(candidate, expectedSpecs[i]!, forbiddenLower, noiseRegexes)
    );
    if (idx !== -1) {
      found.push(input.expectedSymbols[i]!);
      if (firstRank === 0) firstRank = idx + 1;
    } else {
      missed.push(input.expectedSymbols[i]!);
    }
  }

  const classified = input.candidates.map((candidate) => {
    const lowerName = candidate.name.toLowerCase();
    const expectedSpec = expectedSpecs.find((spec) => spec.nameLower === lowerName);
    const isExpected = expectedSpec ? matchesExpectedSpec(candidate, expectedSpec) : false;
    const isWrongExpectedPath = Boolean(expectedSpec && !isExpected);
    const isForbidden = forbiddenLower.has(lowerName);
    const isNoisePath = matchesNoisePath(candidate, noiseRegexes);
    const isUnexpected = !isExpected && input.strictPrecision === true;
    const reasons = [
      ...(isUnexpected ? ['unexpected-symbol'] : []),
      ...(isWrongExpectedPath ? ['unexpected-path'] : []),
      ...(isForbidden ? ['forbidden-symbol'] : []),
      ...(isNoisePath ? ['noise-path'] : []),
    ];
    return {
      candidate,
      truePositive: isExpected && !isForbidden && !isNoisePath,
      falsePositive: isUnexpected || isWrongExpectedPath || isForbidden || isNoisePath,
      isNoisePath,
      reasons,
    };
  });
  const truePositiveCount = classified.filter((item) => item.truePositive).length;
  const falsePositiveItems = classified.filter((item) => item.falsePositive);
  const falsePositiveSymbols = unique(falsePositiveItems.map((item) => item.candidate.name));
  const falsePositiveMatches = falsePositiveItems.map((item) => ({
    name: item.candidate.name,
    filePath: item.candidate.filePath,
    reasons: item.reasons,
  }));
  const noisePathMatches = classified.filter((item) => item.isNoisePath).length;
  const falsePositiveCount = falsePositiveItems.length;
  const recall = input.expectedSymbols.length > 0 ? found.length / input.expectedSymbols.length : 1;
  const precisionDenominator = truePositiveCount + falsePositiveCount;
  const precision = precisionDenominator > 0 ? truePositiveCount / precisionDenominator : 1;
  const mrr = input.mrr ?? (firstRank > 0 ? 1 / firstRank : 0);
  const edgeCount = input.edges?.length ?? 0;
  const edgeDensity = input.candidates.length > 0 ? edgeCount / input.candidates.length : 0;
  const edgeStats = summarizeEdges(input.edges ?? []);
  const latencyPass = input.maxLatencyMs === undefined || input.latencyMs <= input.maxLatencyMs;
  const pass = recall >= PASS_THRESHOLD && falsePositiveCount === 0 && latencyPass;

  const notes = [...(input.notes ?? [])];
  if (!latencyPass && input.maxLatencyMs !== undefined) {
    notes.push(`latency ${Math.round(input.latencyMs)}ms exceeded ${input.maxLatencyMs}ms`);
  }

  return {
    caseId: input.caseId,
    suite: input.suite,
    api: input.api,
    required,
    pass,
    blocking: required && !pass,
    recall,
    precision,
    mrr,
    foundSymbols: found,
    missedSymbols: missed,
    falsePositiveSymbols,
    falsePositiveMatches,
    falsePositiveCount,
    noisePathCount: noisePathMatches,
    returnedSymbolCount: input.candidates.length,
    returnedSymbols: input.candidates.map((candidate) => ({
      name: candidate.name,
      filePath: candidate.filePath,
    })),
    targetSymbol: input.targetSymbol,
    targetFilePath: input.targetFilePath,
    nodeCount: input.candidates.length,
    edgeCount,
    edgeDensity,
    edgeKindDistribution: edgeStats.byKind,
    edgeProvenanceDistribution: edgeStats.byProvenance,
    resolvedByDistribution: edgeStats.byResolvedBy,
    confidenceDistribution: edgeStats.byConfidence,
    edgeSamples: sampleEdges(input.edges ?? []),
    latencyMs: input.latencyMs,
    notes: notes.length > 0 ? notes : undefined,
  };
}

export function scoreSearchNodes(
  caseId: string,
  suite: EvalSuite,
  expectedSymbols: string[],
  results: Array<{ node: EvalNode; score: number }>,
  latencyMs: number,
  options: Partial<ScoreInput> = {}
): EvalResult {
  return scoreCandidates({
    ...options,
    caseId,
    suite,
    api: 'searchNodes',
    expectedSymbols,
    candidates: results.map((result) => result.node),
    latencyMs,
  });
}

export function scoreFindRelevantContext(
  caseId: string,
  suite: EvalSuite,
  expectedSymbols: string[],
  subgraph: { nodes: Map<string, EvalNode>; edges: EvalEdge[]; roots: string[] },
  latencyMs: number,
  options: Partial<ScoreInput> = {}
): EvalResult {
  return scoreCandidates({
    ...options,
    caseId,
    suite,
    api: 'findRelevantContext',
    expectedSymbols,
    candidates: [...subgraph.nodes.values()],
    edges: subgraph.edges,
    latencyMs,
    mrr: 0,
  });
}

export function summarizeEdges(edges: EvalEdge[]): {
  byKind: Record<string, number>;
  byProvenance: Record<string, number>;
  byResolvedBy: Record<string, number>;
  byConfidence: Record<string, number>;
} {
  const byKind: Record<string, number> = {};
  const byProvenance: Record<string, number> = {};
  const byResolvedBy: Record<string, number> = {};
  const byConfidence: Record<string, number> = {};

  for (const edge of edges) {
    increment(byKind, edge.kind);
    increment(byProvenance, edge.provenance ?? 'unknown');

    const resolvedBy =
      typeof edge.metadata?.resolvedBy === 'string' ? edge.metadata.resolvedBy : 'unknown';
    increment(byResolvedBy, resolvedBy);

    const confidence =
      typeof edge.metadata?.confidence === 'number' ? edge.metadata.confidence : undefined;
    increment(byConfidence, confidenceBucket(confidence));
  }

  return { byKind, byProvenance, byResolvedBy, byConfidence };
}

export function mergeDistribution(
  target: Record<string, number>,
  source: Record<string, number> | undefined
): void {
  if (!source) return;
  for (const [key, count] of Object.entries(source)) {
    target[key] = (target[key] ?? 0) + count;
  }
}

interface ExpectedSpec {
  name: string;
  nameLower: string;
  filePath?: string;
}

function buildExpectedSpecs(
  expectedSymbols: string[],
  expectedMatches: Array<{ name: string; filePath?: string }> | undefined
): ExpectedSpec[] {
  return expectedSymbols.map((symbol) => {
    const match = expectedMatches?.find((item) => item.name === symbol);
    return {
      name: symbol,
      nameLower: symbol.toLowerCase(),
      filePath: match?.filePath,
    };
  });
}

function isExpectedCandidate(
  candidate: CandidateNode,
  expected: ExpectedSpec,
  forbiddenLower: Set<string>,
  noiseRegexes: RegExp[]
): boolean {
  const lowerName = candidate.name.toLowerCase();
  return (
    matchesExpectedSpec(candidate, expected) &&
    !forbiddenLower.has(lowerName) &&
    !matchesNoisePath(candidate, noiseRegexes)
  );
}

function matchesExpectedSpec(candidate: CandidateNode, expected: ExpectedSpec): boolean {
  if (candidate.name.toLowerCase() !== expected.nameLower) return false;
  return expected.filePath === undefined || candidate.filePath === expected.filePath;
}

function matchesNoisePath(candidate: CandidateNode, regexes: RegExp[]): boolean {
  if (!candidate.filePath) return false;
  return regexes.some((regex) => regex.test(candidate.filePath!));
}

function sampleEdges(edges: EvalEdge[]): EvalResult['edgeSamples'] {
  return edges.slice(0, 20).map((edge) => ({
    kind: edge.kind,
    source: edge.source,
    target: edge.target,
    provenance: edge.provenance,
    confidence: typeof edge.metadata?.confidence === 'number' ? edge.metadata.confidence : undefined,
    resolvedBy: typeof edge.metadata?.resolvedBy === 'string' ? edge.metadata.resolvedBy : undefined,
  }));
}

function confidenceBucket(confidence: number | undefined): string {
  if (confidence === undefined) return 'unknown';
  if (confidence >= 0.9) return 'high';
  if (confidence >= 0.7) return 'medium';
  return 'low';
}

function increment(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
