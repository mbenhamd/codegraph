/**
 * PF-606: edge-confidence + resolver-provenance surfacing.
 *
 * Asserts that the resolver metadata (`resolvedBy`, `confidence`) stored on
 * graph edges propagates to:
 *   - the `formatEdgeProvenance` helper used by the MCP `codegraph_callers`
 *     / `codegraph_callees` formatters,
 *   - the `getCallers` / `getCallees` results from a real indexed project,
 *     for representative resolver paths (import vs name-match vs framework).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { formatEdgeProvenance } from '../src/edge-provenance';
import type { Edge } from '../src/types';

describe('formatEdgeProvenance (PF-606)', () => {
  it('returns "[resolvedBy confidence]" for a fully-tagged edge', () => {
    const edge: Edge = {
      source: 'a',
      target: 'b',
      kind: 'calls',
      metadata: { resolvedBy: 'import', confidence: 0.9 },
    };
    expect(formatEdgeProvenance(edge)).toBe('[import 0.90]');
  });

  it('rounds confidence to two decimals', () => {
    const edge: Edge = {
      source: 'a',
      target: 'b',
      kind: 'calls',
      metadata: { resolvedBy: 'fuzzy', confidence: 0.123456 },
    };
    expect(formatEdgeProvenance(edge)).toBe('[fuzzy 0.12]');
  });

  it('returns "[resolvedBy]" when only resolvedBy is present', () => {
    const edge: Edge = {
      source: 'a',
      target: 'b',
      kind: 'calls',
      metadata: { resolvedBy: 'framework' },
    };
    expect(formatEdgeProvenance(edge)).toBe('[framework]');
  });

  it('returns "[confidence]" when only confidence is present', () => {
    const edge: Edge = {
      source: 'a',
      target: 'b',
      kind: 'calls',
      metadata: { confidence: 0.5 },
    };
    expect(formatEdgeProvenance(edge)).toBe('[0.50]');
  });

  it('returns empty string when no resolver metadata is set', () => {
    expect(formatEdgeProvenance(undefined)).toBe('');
    expect(
      formatEdgeProvenance({ source: 'a', target: 'b', kind: 'contains' }),
    ).toBe('');
    expect(
      formatEdgeProvenance({ source: 'a', target: 'b', kind: 'calls', metadata: {} }),
    ).toBe('');
  });

  it('ignores non-string resolvedBy and non-number confidence', () => {
    const edge: Edge = {
      source: 'a',
      target: 'b',
      kind: 'calls',
      metadata: { resolvedBy: 42, confidence: 'high' } as Record<string, unknown>,
    };
    expect(formatEdgeProvenance(edge)).toBe('');
  });

  it('drops non-finite confidence (NaN / Infinity) instead of leaking to output', () => {
    const nanEdge: Edge = {
      source: 'a',
      target: 'b',
      kind: 'calls',
      metadata: { resolvedBy: 'import', confidence: Number.NaN },
    };
    const infEdge: Edge = {
      source: 'a',
      target: 'b',
      kind: 'calls',
      metadata: { resolvedBy: 'import', confidence: Number.POSITIVE_INFINITY },
    };
    // Only resolvedBy survives — confidence is dropped silently.
    expect(formatEdgeProvenance(nanEdge)).toBe('[import]');
    expect(formatEdgeProvenance(infEdge)).toBe('[import]');
  });
});

describe('edge provenance surfacing in graph queries (PF-606)', () => {
  let tempDir: string;
  let cg: CodeGraph | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-pf606-'));
  });

  afterEach(() => {
    cg?.destroy();
    cg = undefined;
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('preserves resolvedBy + confidence on import-resolved call edges', async () => {
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'src', 'helper.ts'),
      'export function helper(): void {}\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(tempDir, 'src', 'caller.ts'),
      "import { helper } from './helper';\nexport function main(): void {\n  helper();\n}\n",
      'utf8',
    );

    cg = await CodeGraph.init(tempDir, { index: true });

    const helperNode = cg
      .searchNodes('helper', { limit: 25 })
      .map((r) => r.node)
      .find((n) => n.name === 'helper' && n.kind === 'function');
    expect(helperNode).toBeDefined();

    const callers = cg.getCallers(helperNode!.id);
    expect(callers.length).toBeGreaterThan(0);
    const callerEdge = callers[0]!.edge;
    expect(callerEdge.metadata).toBeDefined();
    const meta = callerEdge.metadata as { confidence?: number; resolvedBy?: string };
    expect(typeof meta.resolvedBy).toBe('string');
    expect(typeof meta.confidence).toBe('number');
    expect(meta.confidence!).toBeGreaterThanOrEqual(0);
    expect(meta.confidence!).toBeLessThanOrEqual(1);
    // Strong import-resolved edge — confidence should be high.
    expect(meta.confidence!).toBeGreaterThanOrEqual(0.7);

    expect(formatEdgeProvenance(callerEdge)).toMatch(/^\[[a-z-]+ \d\.\d{2}\]$/);
  });
});
