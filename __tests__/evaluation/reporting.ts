import * as fs from 'fs';
import * as path from 'path';
import { mergeDistribution } from './scoring.js';
import type { EvalReport, EvalResult } from './types.js';

export function printResults(results: EvalResult[]): void {
  const maxIdLen = results.length > 0 ? Math.max(...results.map((r) => r.caseId.length)) : 0;

  for (const r of results) {
    const status = r.pass
      ? '\x1b[32mPASS\x1b[0m'
      : r.required
        ? '\x1b[31mFAIL\x1b[0m'
        : '\x1b[33mWARN\x1b[0m';
    const id = r.caseId.padEnd(maxIdLen);
    const recall = `recall=${r.recall.toFixed(2)}`;
    const precision = `precision=${r.precision.toFixed(2)}`;
    const falsePositives = `fp=${r.falsePositiveCount}`;
    const latency = `${Math.round(r.latencyMs)}ms`;

    console.log(`  ${id}  ${status}  ${recall}  ${precision}  ${falsePositives}  ${latency}`);

    if (r.missedSymbols.length > 0) {
      console.log(`  ${' '.repeat(maxIdLen)}        missed: ${r.missedSymbols.join(', ')}`);
    }
    if (r.falsePositiveSymbols.length > 0) {
      console.log(`  ${' '.repeat(maxIdLen)}        false positives: ${r.falsePositiveSymbols.join(', ')}`);
    }
    if (r.falsePositiveMatches.length > 0) {
      const details = r.falsePositiveMatches
        .map((match) => `${match.name}${match.filePath ? ` (${match.filePath})` : ''}:${match.reasons.join('+')}`)
        .join(', ');
      console.log(`  ${' '.repeat(maxIdLen)}        false positive details: ${details}`);
    }
    if (r.noisePathCount > 0) {
      console.log(`  ${' '.repeat(maxIdLen)}        noisy paths: ${r.noisePathCount}`);
    }
    if (r.notes && r.notes.length > 0) {
      console.log(`  ${' '.repeat(maxIdLen)}        notes: ${r.notes.join('; ')}`);
    }
  }

  const summary = summarizeResults(results);
  const summaryColor = summary.failed === 0 ? '\x1b[32m' : '\x1b[33m';
  console.log('');
  console.log(
    `${summaryColor}SUMMARY: required=${summary.requiredPassed}/${summary.requiredTotal} | ` +
      `tracked=${summary.trackedWarnings}/${summary.trackedTotal} warnings | ` +
      `all-pass=${summary.passed}/${summary.total} | blocking=${summary.failed} | ` +
      `recall=${summary.meanRecall.toFixed(2)} | precision=${summary.meanPrecision.toFixed(2)} | ` +
      `mrr=${summary.meanMRR.toFixed(2)} | fp=${summary.totalFalsePositives} | ` +
      `latency=${Math.round(summary.meanLatencyMs)}ms\x1b[0m`
  );
}

export function saveReport(
  results: EvalResult[],
  codebasePath: string,
  codegraphSha: string,
  evaluationDir: string,
  command: string,
  fixtureHash?: string
): string {
  const report: EvalReport = {
    timestamp: new Date().toISOString(),
    codebasePath,
    codegraphSha,
    command,
    fixtureHash,
    summary: summarizeResults(results),
    results,
  };

  const resultsDir = process.env.EVAL_REPORT_DIR || path.join(evaluationDir, 'results');
  fs.mkdirSync(resultsDir, { recursive: true });
  const reportFile = path.join(
    resultsDir,
    `${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  );
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  return reportFile;
}

export function summarizeResults(results: EvalResult[]): EvalReport['summary'] {
  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => r.blocking).length;
  const warnings = results.filter((r) => !r.pass && !r.required).length;
  const requiredResults = results.filter((r) => r.required);
  const trackedResults = results.filter((r) => !r.required);
  const requiredTotal = requiredResults.length;
  const requiredPassed = requiredResults.filter((r) => r.pass).length;
  const trackedTotal = trackedResults.length;
  const trackedWarnings = trackedResults.filter((r) => !r.pass).length;
  const meanRecall = average(results.map((r) => r.recall));
  const meanPrecision = average(results.map((r) => r.precision));
  const mrrResults = results.filter((r) => r.mrr > 0 || r.api === 'searchNodes');
  const meanMRR = average(mrrResults.map((r) => r.mrr));
  const meanLatencyMs = average(results.map((r) => r.latencyMs));
  const totalFalsePositives = results.reduce((sum, r) => sum + r.falsePositiveCount, 0);
  const totalNoisePaths = results.reduce((sum, r) => sum + r.noisePathCount, 0);
  const edgeKindDistribution: Record<string, number> = {};
  const edgeProvenanceDistribution: Record<string, number> = {};
  const resolvedByDistribution: Record<string, number> = {};
  const confidenceDistribution: Record<string, number> = {};

  for (const result of results) {
    mergeDistribution(edgeKindDistribution, result.edgeKindDistribution);
    mergeDistribution(edgeProvenanceDistribution, result.edgeProvenanceDistribution);
    mergeDistribution(resolvedByDistribution, result.resolvedByDistribution);
    mergeDistribution(confidenceDistribution, result.confidenceDistribution);
  }

  return {
    total,
    passed,
    failed,
    warnings,
    requiredTotal,
    requiredPassed,
    trackedTotal,
    trackedWarnings,
    meanRecall,
    meanPrecision,
    meanMRR,
    meanLatencyMs,
    totalFalsePositives,
    totalNoisePaths,
    edgeKindDistribution,
    edgeProvenanceDistribution,
    resolvedByDistribution,
    confidenceDistribution,
  };
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
