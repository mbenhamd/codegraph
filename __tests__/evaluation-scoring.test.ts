import { describe, expect, it } from 'vitest';
import { scoreCandidates } from './evaluation/scoring';

describe('evaluation scoring', () => {
  it('counts expected symbols returned from the wrong path as false positives', () => {
    const result = scoreCandidates({
      caseId: 'wrong-path',
      suite: 'structural',
      api: 'searchNodes',
      expectedSymbols: ['PaymentService'],
      expectedMatches: [{ name: 'PaymentService', filePath: 'src/app/payment-service.ts' }],
      candidates: [{ name: 'PaymentService', filePath: 'vendor/sdk/payment-service.ts' }],
      latencyMs: 10,
    });

    expect(result.foundSymbols).toEqual([]);
    expect(result.missedSymbols).toEqual(['PaymentService']);
    expect(result.falsePositiveCount).toBe(1);
    expect(result.falsePositiveMatches).toEqual([
      {
        name: 'PaymentService',
        filePath: 'vendor/sdk/payment-service.ts',
        reasons: ['unexpected-path'],
      },
    ]);
    expect(result.precision).toBe(0);
    expect(result.pass).toBe(false);
  });

  it('does not count correctly matched expected paths as false positives', () => {
    const result = scoreCandidates({
      caseId: 'correct-path',
      suite: 'structural',
      api: 'searchNodes',
      expectedSymbols: ['PaymentService'],
      expectedMatches: [{ name: 'PaymentService', filePath: 'src/app/payment-service.ts' }],
      candidates: [{ name: 'PaymentService', filePath: 'src/app/payment-service.ts' }],
      latencyMs: 10,
    });

    expect(result.foundSymbols).toEqual(['PaymentService']);
    expect(result.falsePositiveCount).toBe(0);
    expect(result.falsePositiveMatches).toEqual([]);
    expect(result.precision).toBe(1);
    expect(result.pass).toBe(true);
  });
});
