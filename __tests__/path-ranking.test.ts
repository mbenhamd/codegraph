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

  // PF-673: package-role refinements on top of PF-608.
  describe('package-role profiles (PF-673)', () => {
    it('demotes fixtures, test-support, and docs lanes by default', () => {
      expect(
        getPathRankingSignals('src/__fixtures__/payment.ts', 'payment service').reasons,
      ).toContain('demoted fixture path');
      expect(
        getPathRankingSignals('packages/api/test-utils/payment.ts', 'payment service').reasons,
      ).toContain('demoted test-support path');
      expect(
        getPathRankingSignals('docs/architecture/payment.md', 'payment service').reasons,
      ).toContain('demoted docs path');
    });

    it('does NOT demote `examples/` — runnable first-party apps live there', () => {
      // `examples/payment-app/src/handler.ts` is real code in many
      // monorepo layouts; demoting it for a broad query like
      // 'payment service' buries legitimate user code.
      const signals = getPathRankingSignals(
        'examples/payment-app/src/handler.ts',
        'payment service',
      );
      expect(signals.reasons).not.toContain('demoted docs path');
    });

    it('does NOT demote top-level `mocks/` — production mock infra lives there', () => {
      // Plain `mocks/` (vs `__mocks__/`) is often app-side mock
      // infrastructure (analytics, payments) that should answer
      // broad workflow queries; only `__mocks__` is treated as
      // Jest/Vitest test-support.
      const signals = getPathRankingSignals(
        'mocks/analytics.ts',
        'analytics tracking',
      );
      expect(signals.reasons).not.toContain('demoted test-support path');
    });

    it('keeps fixture / test-support / docs paths reachable when the query explicitly mentions them', () => {
      const fixtureSignals = getPathRankingSignals(
        'src/__fixtures__/payment.ts',
        'fixtures payment',
      );
      expect(fixtureSignals.scoreAdjustment).toBeGreaterThanOrEqual(0);
      expect(fixtureSignals.reasons).toContain('explicit fixture path query');

      const testSupportSignals = getPathRankingSignals(
        'packages/api/test-utils/payment.ts',
        'test-utils payment',
      );
      expect(testSupportSignals.reasons).toContain('explicit test-support path query');

      const docsSignals = getPathRankingSignals('docs/architecture/payment.md', 'docs payment');
      expect(docsSignals.reasons).toContain('explicit docs path query');
    });

    it('does NOT apply role demotion on top of vendor/generated/build demotion (no double-count)', () => {
      const signals = getPathRankingSignals(
        'vendor/sdk/__fixtures__/payment.ts',
        'payment',
      );
      expect(signals.reasons).toContain('demoted vendor/third_party path');
      expect(signals.reasons).not.toContain('demoted fixture path');
    });

    it('ranks app source above same-named file in fixtures lane', () => {
      const query = 'PaymentService charge';
      const appScore = scorePathRelevance('src/app/payment-service.ts', query);
      const fixtureScore = scorePathRelevance(
        'src/__fixtures__/payment-service.ts',
        query,
      );
      expect(appScore).toBeGreaterThan(fixtureScore);
    });
  });
});
