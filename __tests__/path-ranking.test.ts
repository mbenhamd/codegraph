import { describe, expect, it } from 'vitest';
import { getPathRankingSignals, scorePathRelevance } from '../src/search/query-utils';

describe('path ranking', () => {
  it('demotes vendor, third_party, generated, and build-output paths by default', () => {
    expect(getPathRankingSignals('third_party/mastra/src/runtime.ts', 'runtime scheduler').reasons)
      .toContain('demoted vendor/third_party path');
    expect(getPathRankingSignals('vendor/sdk/src/runtime.ts', 'runtime scheduler').reasons)
      .toContain('demoted vendor/third_party path');
    expect(getPathRankingSignals('src/generated/runtime.ts', 'runtime scheduler').reasons)
      .toContain('demoted generated path');
    expect(getPathRankingSignals('dist/runtime.js', 'runtime scheduler').reasons)
      .toContain('demoted build-output path');
  });

  it('boosts production source roots without treating them as noise', () => {
    const signals = getPathRankingSignals('src/app/runtime.ts', 'runtime scheduler');

    expect(signals.scoreAdjustment).toBeGreaterThan(0);
    expect(signals.reasons).toContain('boosted source-root path');
  });

  it('keeps explicit vendor and generated path queries reachable', () => {
    const vendorSignals = getPathRankingSignals('third_party/mastra/src/runtime.ts', 'third_party runtime');
    const generatedSignals = getPathRankingSignals('src/generated/runtime.ts', 'generated runtime');

    expect(vendorSignals.scoreAdjustment).toBeGreaterThan(0);
    expect(vendorSignals.reasons).toContain('explicit vendor/third_party path query');
    expect(generatedSignals.scoreAdjustment).toBeGreaterThan(0);
    expect(generatedSignals.reasons).toContain('explicit generated path query');
  });

  it('keeps named vendored projects reachable without requiring path:third_party', () => {
    const signals = getPathRankingSignals(
      'third_party/mastra/packages/core/src/workflows/workflow.ts',
      'How does Mastra resume workflows?'
    );

    expect(signals.scoreAdjustment).toBeGreaterThan(0);
    expect(signals.reasons).toContain('matched vendored project name');
  });

  it('does not infer explicit generated/build intent from word substrings', () => {
    expect(getPathRankingSignals('src/generated/agent.ts', 'agent scheduler').reasons)
      .toContain('demoted generated path');
    expect(getPathRankingSignals('out/runtime.js', 'about runtime').reasons)
      .toContain('demoted build-output path');
  });

  it('only treats the vendored project segment as implicit vendor intent', () => {
    expect(getPathRankingSignals(
      'third_party/mastra/packages/core/src/workflows/workflow.ts',
      'core workflow resume'
    ).reasons).toContain('demoted vendor/third_party path');
    expect(getPathRankingSignals(
      'third_party/mastra/packages/core/src/workflows/workflow.ts',
      'mastra workflow resume'
    ).reasons).toContain('matched vendored project name');
  });

  it('ranks local app files above duplicate vendor and generated paths for app queries', () => {
    const query = 'PaymentService charge';
    const appScore = scorePathRelevance('src/app/payment-service.ts', query);
    const thirdPartyScore = scorePathRelevance('third_party/generated/payment-service.ts', query);
    const vendorScore = scorePathRelevance('vendor/sdk/payment-service.ts', query);

    expect(appScore).toBeGreaterThan(thirdPartyScore);
    expect(appScore).toBeGreaterThan(vendorScore);
  });
});
