import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CodeGraph from '../src';
import { parseBenchmarkQuerySpec, runBenchmark } from '../src/benchmark';

describe('benchmark harness', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeProject(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-benchmark-'));
    tempDirs.push(dir);
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src', 'db.ts'),
      'export function saveOrder(): void {}\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'service.ts'),
      "import { saveOrder } from './db';\nexport function checkout(): void {\n  saveOrder();\n}\n",
      'utf8'
    );
    return dir;
  }

  it('parses query specs and defaults bare specs to search', () => {
    expect(parseBenchmarkQuerySpec('checkout')).toEqual({ kind: 'search', input: 'checkout' });
    expect(parseBenchmarkQuerySpec('callees: checkout')).toEqual({ kind: 'callees', input: 'checkout' });
    expect(() => parseBenchmarkQuerySpec('')).toThrow(/empty/);
    expect(() => parseBenchmarkQuerySpec('unknown: checkout')).toThrow(/Unsupported benchmark query kind/);
    expect(() => parseBenchmarkQuerySpec('search:')).toThrow(/missing input/);
  });

  it('indexes, runs representative query benchmarks, and cleans benchmark-created indexes', async () => {
    const dir = makeProject();

    const report = await runBenchmark(dir, {
      cleanup: true,
      queries: [
        'search:checkout',
        'callers:saveOrder',
        'callees:checkout',
        'impact:saveOrder',
        'context:checkout flow',
      ],
    });

    expect(report.mode.createdIndex).toBe(true);
    expect(report.mode.hadCodeGraphDirBefore).toBe(false);
    expect(report.mode.cleanedUp).toBe(true);
    expect(report.stats.fileCount).toBeGreaterThanOrEqual(2);
    expect(report.stats.nodeCount).toBeGreaterThan(0);
    expect(report.queries).toHaveLength(5);
    expect(report.queries.every((query) => query.ok)).toBe(true);
    expect(report.queries.find((query) => query.spec === 'callers:saveOrder')?.resultCount).toBeGreaterThan(0);
    expect(report.queries.find((query) => query.spec === 'callees:checkout')?.resultCount).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(dir, '.codegraph'))).toBe(false);
  });

  it('refuses cold benchmarks that would remove an existing index without force', async () => {
    const dir = makeProject();
    fs.mkdirSync(path.join(dir, '.codegraph'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.codegraph', 'codegraph.db'), '', 'utf8');

    await expect(runBenchmark(dir, { cold: true })).rejects.toThrow(/Re-run with --force/);
  });

  it('refuses cleanup when a pre-existing non-index .codegraph directory would be removed', async () => {
    const dir = makeProject();
    fs.mkdirSync(path.join(dir, '.codegraph'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.codegraph', 'lessons.db'), 'keep me', 'utf8');

    await expect(runBenchmark(dir, { cleanup: true })).rejects.toThrow(/Cleanup is unsafe/);
    expect(fs.readFileSync(path.join(dir, '.codegraph', 'lessons.db'), 'utf8')).toBe('keep me');
  });

  it('validates query specs before creating an index', async () => {
    const dir = makeProject();

    await expect(runBenchmark(dir, { cleanup: true, queries: ['missing-kind:checkout'] })).rejects.toThrow(/Unsupported benchmark query kind/);
    expect(fs.existsSync(path.join(dir, '.codegraph'))).toBe(false);
  });

  it('cleans benchmark-created indexes when benchmarking fails after setup', async () => {
    const dir = makeProject();
    vi.spyOn(CodeGraph.prototype, 'getStats').mockImplementation(() => {
      throw new Error('stats failed');
    });

    await expect(runBenchmark(dir, { cleanup: true })).rejects.toThrow(/stats failed/);
    expect(fs.existsSync(path.join(dir, '.codegraph'))).toBe(false);
  });

  it('validates query specs before destructive benchmark setup', async () => {
    const dir = makeProject();
    fs.mkdirSync(path.join(dir, '.codegraph'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.codegraph', 'codegraph.db'), '', 'utf8');
    fs.writeFileSync(path.join(dir, '.codegraph', 'marker'), 'unchanged', 'utf8');

    await expect(runBenchmark(dir, { reindex: true, queries: ['missing-kind:checkout'] })).rejects.toThrow(/Unsupported benchmark query kind/);
    expect(fs.readFileSync(path.join(dir, '.codegraph', 'marker'), 'utf8')).toBe('unchanged');
  });

  it('refuses to create missing project paths', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-benchmark-missing-'));
    tempDirs.push(root);
    const missing = path.join(root, 'missing');

    await expect(runBenchmark(missing)).rejects.toThrow(/does not exist/);
    expect(fs.existsSync(missing)).toBe(false);
  });

  it('requires force before reindexing an existing index', async () => {
    const dir = makeProject();
    fs.mkdirSync(path.join(dir, '.codegraph'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.codegraph', 'codegraph.db'), '', 'utf8');
    fs.writeFileSync(path.join(dir, '.codegraph', 'marker'), 'unchanged', 'utf8');

    await expect(runBenchmark(dir, { reindex: true, queries: ['checkout'] })).rejects.toThrow(/Reindex benchmark would clear/);
    expect(fs.readFileSync(path.join(dir, '.codegraph', 'marker'), 'utf8')).toBe('unchanged');
  });
});
