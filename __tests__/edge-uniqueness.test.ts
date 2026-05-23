/**
 * PF-625: edge uniqueness regression.
 *
 * After PF-611b shipped `synthesizeReExportEdges` (which emits one
 * file→file `imports` edge per `export … from` statement), repeated
 * resolution runs against the same project must produce a STABLE edge
 * count — re-indexing, watch restarts, or repeated `resolveReferences`
 * calls cannot accumulate duplicates. The fix is a schema-level
 * `UNIQUE (source, target, kind, COALESCE(line,-1), COALESCE(col,-1))`
 * index that turns the existing `INSERT OR IGNORE` from a no-op into a
 * real deduplicator.
 *
 * This test pins that contract:
 *   1. Index a fixture with multi-hop re-exports + direct imports.
 *   2. Snapshot the total edge count.
 *   3. Call `resolveReferences()` a second time — re-synthesizes the
 *      same re-export edges, re-creates the same caller→callee edges.
 *   4. Assert the total edge count is unchanged.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

describe('edge uniqueness across repeated resolution (PF-625)', () => {
  let tempDir: string;
  let cg: CodeGraph | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-pf625-'));
  });

  afterEach(() => {
    cg?.destroy();
    cg = undefined;
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not accumulate duplicate edges on repeated resolveReferences', async () => {
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'src', 'b'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'src', 'b', 'inner'), { recursive: true });

    // Leaf the chain points at.
    fs.writeFileSync(
      path.join(tempDir, 'src', 'b', 'inner', 'leaf.ts'),
      'export function leaf(): number { return 1; }\n',
      'utf8',
    );
    // Inner barrel.
    fs.writeFileSync(
      path.join(tempDir, 'src', 'b', 'inner', 'index.ts'),
      "export * from './leaf';\n",
      'utf8',
    );
    // Outer barrel.
    fs.writeFileSync(
      path.join(tempDir, 'src', 'b', 'index.ts'),
      "export * from './inner';\n",
      'utf8',
    );
    // Caller — exercises both the synthesized re-export chain and a
    // direct call edge into the leaf function.
    fs.writeFileSync(
      path.join(tempDir, 'src', 'caller.test.ts'),
      "import { leaf } from './b';\nexport function run() { leaf(); }\n",
      'utf8',
    );

    cg = await CodeGraph.init(tempDir, { index: true });

    const firstStats = cg.getStats();
    const firstCount = firstStats.edgeCount;
    expect(firstCount).toBeGreaterThan(0);

    // Re-run resolution. PF-611b's synthesizeReExportEdges re-emits
    // the same file→file imports edges; resolveAll re-emits the same
    // caller→callee edge. Without the PF-625 unique index they would
    // duplicate; with it, INSERT OR IGNORE on the schema-level
    // constraint keeps the row count stable.
    cg.resolveReferences();
    const secondStats = cg.getStats();
    expect(secondStats.edgeCount).toBe(firstCount);

    // A third run for extra confidence — would catch a linear-growth bug
    // that the second-run check missed if duplicates leaked through a
    // narrow gap somewhere.
    cg.resolveReferences();
    const thirdStats = cg.getStats();
    expect(thirdStats.edgeCount).toBe(firstCount);

    // Directly verify the schema-level unique index is what enforces
    // dedup — not just app-layer logic in synthesizeReExportEdges (which
    // might silently regress). Pick any existing edge, attempt to
    // insert an exact duplicate, and assert the row count is unchanged.
    // This proves `idx_edges_unique` is active and `INSERT OR IGNORE`
    // honors it.
    const queries = (cg as unknown as { queries: { db: { prepare: (sql: string) => { all: () => Array<Record<string, unknown>>; get: (...args: unknown[]) => Record<string, unknown> | undefined; run: (...args: unknown[]) => void } } } }).queries;
    const indexExists = queries.db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?")
      .get('idx_edges_unique');
    expect(indexExists).toBeDefined();

    const anyEdge = queries.db
      .prepare('SELECT source, target, kind, line, col FROM edges LIMIT 1')
      .get() as { source: string; target: string; kind: string; line: number | null; col: number | null };
    expect(anyEdge).toBeDefined();
    const beforeRow = queries.db.prepare('SELECT COUNT(*) as c FROM edges').get() as { c: number };
    queries.db
      .prepare(
        'INSERT OR IGNORE INTO edges (source, target, kind, metadata, line, col, provenance) VALUES (?, ?, ?, NULL, ?, ?, NULL)',
      )
      .run(anyEdge.source, anyEdge.target, anyEdge.kind, anyEdge.line, anyEdge.col);
    const afterRow = queries.db.prepare('SELECT COUNT(*) as c FROM edges').get() as { c: number };
    expect(afterRow.c).toBe(beforeRow.c);
  });
});
