export type EvalApi =
  | 'searchNodes'
  | 'findRelevantContext'
  | 'callers'
  | 'callees'
  | 'impact'
  | 'literalBypass';

export type EvalSuite = 'external' | 'structural';

export interface EvalNode {
  id: string;
  kind: string;
  name: string;
  filePath: string;
}

export interface EvalEdge {
  source: string;
  target: string;
  kind: string;
  metadata?: Record<string, unknown>;
  provenance?: string;
}

export interface EvalTestCase {
  id: string;
  suite: EvalSuite;
  query?: string;
  api: EvalApi;
  expectedSymbols: string[];
  expectedMatches?: Array<{ name: string; filePath?: string }>;
  forbiddenSymbols?: string[];
  noisePathPatterns?: string[];
  kinds?: string[];
  targetSymbol?: string;
  targetFilePath?: string;
  targetKinds?: string[];
  literalText?: string;
  maxDepth?: number;
  maxLatencyMs?: number;
  required?: boolean;
  options?: Record<string, unknown>;
}

export interface EvalResult {
  caseId: string;
  suite: EvalSuite;
  api: EvalApi;
  required: boolean;
  pass: boolean;
  blocking: boolean;
  recall: number;
  precision: number;
  mrr: number;
  foundSymbols: string[];
  missedSymbols: string[];
  falsePositiveSymbols: string[];
  falsePositiveMatches: Array<{ name: string; filePath?: string; reasons: string[] }>;
  falsePositiveCount: number;
  noisePathCount: number;
  returnedSymbolCount: number;
  returnedSymbols: Array<{ name: string; filePath?: string }>;
  targetSymbol?: string;
  targetFilePath?: string;
  nodeCount?: number;
  edgeCount?: number;
  edgeDensity?: number;
  edgeKindDistribution?: Record<string, number>;
  edgeProvenanceDistribution?: Record<string, number>;
  resolvedByDistribution?: Record<string, number>;
  confidenceDistribution?: Record<string, number>;
  edgeSamples?: Array<{
    kind: string;
    source: string;
    target: string;
    provenance?: string;
    confidence?: number;
    resolvedBy?: string;
  }>;
  latencyMs: number;
  notes?: string[];
}

export interface EvalReport {
  timestamp: string;
  codebasePath: string;
  codegraphSha: string;
  command: string;
  fixtureHash?: string;
  summary: {
    total: number;
    passed: number;
    failed: number;
    warnings: number;
    requiredTotal: number;
    requiredPassed: number;
    trackedTotal: number;
    trackedWarnings: number;
    meanRecall: number;
    meanPrecision: number;
    meanMRR: number;
    meanLatencyMs: number;
    totalFalsePositives: number;
    totalNoisePaths: number;
    edgeKindDistribution: Record<string, number>;
    edgeProvenanceDistribution: Record<string, number>;
    resolvedByDistribution: Record<string, number>;
    confidenceDistribution: Record<string, number>;
  };
  results: EvalResult[];
}
