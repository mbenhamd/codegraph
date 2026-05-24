/**
 * PF-691: `codegraph diff` primitive tests.
 *
 * Each case sets up two temp projects, indexes them, then runs
 * `diffDatabases(oldDb, newDb)` and asserts the result shape.
 * Uses the production extract -> persist -> query pipeline so
 * the diff is exercised end-to-end, not against fabricated rows.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { diffDatabases } from '../src/diff';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

interface ProjectFixture {
  dir: string;
  dbPath: string;
}

async function makeProject(files: Record<string, string>): Promise<ProjectFixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-diff-'));
  for (const [relPath, content] of Object.entries(files)) {
    const full = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  const cg = await CodeGraph.init(dir, { index: true });
  cg.destroy();
  return { dir, dbPath: path.join(dir, '.codegraph', 'codegraph.db') };
}

function cleanup(p: ProjectFixture): void {
  if (fs.existsSync(p.dir)) {
    fs.rmSync(p.dir, { recursive: true, force: true });
  }
}

describe('PF-691: diffDatabases', () => {
  let oldP: ProjectFixture | undefined;
  let newP: ProjectFixture | undefined;

  beforeEach(() => {
    oldP = undefined;
    newP = undefined;
  });

  afterEach(() => {
    if (oldP) cleanup(oldP);
    if (newP) cleanup(newP);
  });

  it('identical projects produce empty diff', async () => {
    const files = {
      'src/a.ts': 'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
    };
    oldP = await makeProject(files);
    newP = await makeProject(files);
    const result = diffDatabases(oldP.dbPath, newP.dbPath);
    expect(result.summary.addedNodes).toBe(0);
    expect(result.summary.removedNodes).toBe(0);
    expect(result.summary.changedNodes).toBe(0);
  });

  it('added function in new DB surfaces as addedNodes', async () => {
    oldP = await makeProject({
      'src/a.ts': 'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
    });
    newP = await makeProject({
      'src/a.ts':
        'export function add(a: number, b: number): number {\n  return a + b;\n}\n' +
        'export function sub(a: number, b: number): number {\n  return a - b;\n}\n',
    });
    const result = diffDatabases(oldP.dbPath, newP.dbPath);
    // Inspect by qualifiedName containing 'sub' (suffix shape is
    // language-extractor-specific — qualifiedName format differs
    // across extractors and we just need to verify the symbol
    // shows up at all).
    const subAdded = result.addedNodes.find((n) => n.qualifiedName.includes('sub'));
    expect(
      subAdded,
      `sub should be in addedNodes. Got: ${JSON.stringify(result.addedNodes.map((n) => n.qualifiedName))}`,
    ).toBeDefined();
    expect(result.summary.removedNodes).toBe(0);
  });

  it('removed function in new DB surfaces as removedNodes', async () => {
    oldP = await makeProject({
      'src/a.ts':
        'export function add(a: number, b: number): number {\n  return a + b;\n}\n' +
        'export function sub(a: number, b: number): number {\n  return a - b;\n}\n',
    });
    newP = await makeProject({
      'src/a.ts': 'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
    });
    const result = diffDatabases(oldP.dbPath, newP.dbPath);
    const subRemoved = result.removedNodes.find((n) => n.qualifiedName.includes('sub'));
    expect(
      subRemoved,
      `sub should be in removedNodes. Got: ${JSON.stringify(result.removedNodes.map((n) => n.qualifiedName))}`,
    ).toBeDefined();
    expect(result.summary.addedNodes).toBe(0);
  });

  it('function body change surfaces as changedNodes with astHash in changedFields', async () => {
    // Same signature, different body — should keep same node ID
    // (filePath + qualifiedName + startLine unchanged) but emit
    // an astHash drift.
    oldP = await makeProject({
      'src/a.ts': 'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
    });
    newP = await makeProject({
      'src/a.ts': 'export function add(a: number, b: number): number {\n  return a + b + 0;\n}\n',
    });
    const result = diffDatabases(oldP.dbPath, newP.dbPath);
    const change = result.changedNodes.find((c) => c.name === 'add');
    expect(change, 'add should be in changedNodes').toBeDefined();
    expect(change!.changedFields).toContain('astHash');
    // sigHash should NOT have changed — the signature is identical.
    expect(change!.changedFields).not.toContain('sigHash');
  });

  it('signature change surfaces as sigHash drift', async () => {
    oldP = await makeProject({
      'src/a.ts': 'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
    });
    newP = await makeProject({
      'src/a.ts': 'export function add(a: number, b: number, c: number): number {\n  return a + b + c;\n}\n',
    });
    const result = diffDatabases(oldP.dbPath, newP.dbPath);
    const change = result.changedNodes.find((c) => c.name === 'add');
    expect(change, 'add should be in changedNodes').toBeDefined();
    expect(change!.changedFields).toContain('sigHash');
    expect(change!.changedFields).toContain('signature');
    // Body changed too, so astHash drifts as well.
    expect(change!.changedFields).toContain('astHash');
  });

  it('summary counts match the array lengths', async () => {
    oldP = await makeProject({
      'src/a.ts': 'export function one(): number { return 1; }\n',
    });
    newP = await makeProject({
      'src/b.ts': 'export function two(): number { return 2; }\n',
    });
    const result = diffDatabases(oldP.dbPath, newP.dbPath);
    expect(result.summary.addedNodes).toBe(result.addedNodes.length);
    expect(result.summary.removedNodes).toBe(result.removedNodes.length);
    expect(result.summary.changedNodes).toBe(result.changedNodes.length);
    expect(result.summary.addedEdges).toBe(result.addedEdges.length);
    expect(result.summary.removedEdges).toBe(result.removedEdges.length);
  });

  it('throws when a database path does not exist', () => {
    const missing = '/tmp/codegraph-diff-missing-' + Date.now() + '.db';
    expect(() => diffDatabases(missing, missing)).toThrow(/not found/i);
  });

  it('does not mutate either DB or create WAL sidecars (Codex BLOCKER fix)', async () => {
    // PR #39 / PF-691 Codex pass 1 BLOCKER: the original implementation went
    // through DatabaseConnection.open, which sets `journal_mode = WAL` and
    // runs forward migrations — both mutate the file. A diff tool on
    // historical snapshots must NEVER do that.
    oldP = await makeProject({
      'src/a.ts': 'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
    });
    newP = await makeProject({
      'src/a.ts': 'export function add(a: number, b: number): number {\n  return a + b + 0;\n}\n',
    });
    // Snapshot DB + sidecar state BEFORE diffing. The `-wal`/`-shm`
    // sidecars exist already because CodeGraph.init opens in WAL mode
    // for indexing — what we need to verify is that diffDatabases
    // itself doesn't *change* them and doesn't write any new files.
    const snapshot = (p: string): Record<string, { size: number; mtime: number } | null> => {
      const out: Record<string, { size: number; mtime: number } | null> = {};
      for (const sidecar of ['', '-wal', '-shm', '-journal']) {
        const full = p + sidecar;
        out[sidecar] = fs.existsSync(full)
          ? { size: fs.statSync(full).size, mtime: fs.statSync(full).mtimeMs }
          : null;
      }
      return out;
    };
    const beforeOld = snapshot(oldP.dbPath);
    const beforeNew = snapshot(newP.dbPath);

    diffDatabases(oldP.dbPath, newP.dbPath);

    expect(snapshot(oldP.dbPath)).toEqual(beforeOld);
    expect(snapshot(newP.dbPath)).toEqual(beforeNew);
  });

  it('handles legacy schema (no fingerprint columns) without failing', () => {
    // PR #39 / PF-691 Codex pass 1 BLOCKER follow-up: pre-v6 DBs lack the
    // ast_hash / ast_shape_hash / sig_hash / call_pattern_hash columns
    // (added in PR #38 / PF-690). The diff must project them as NULL and
    // continue, not throw `no such column`.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void };
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-diff-v5-'));
    const v5DbA = path.join(dir, 'old.db');
    const v5DbB = path.join(dir, 'new.db');
    try {
      for (const [p, qname] of [
        [v5DbA, 'src/a.ts::add'],
        [v5DbB, 'src/a.ts::sub'],
      ] as const) {
        const db = new DatabaseSync(p);
        // Minimal v5 shape: only columns that existed before fingerprints.
        db.exec(`CREATE TABLE nodes(
          id TEXT PRIMARY KEY, kind TEXT, name TEXT, qualified_name TEXT,
          file_path TEXT, language TEXT,
          start_line INT, end_line INT, start_column INT, end_column INT,
          signature TEXT)`);
        db.exec(`CREATE TABLE edges(
          id INTEGER PRIMARY KEY, source TEXT, target TEXT, kind TEXT,
          metadata TEXT, line INT, col INT, provenance TEXT)`);
        db.exec(`CREATE TABLE files(
          path TEXT PRIMARY KEY, content_hash TEXT NOT NULL, language TEXT NOT NULL,
          size INTEGER NOT NULL, modified_at INTEGER NOT NULL,
          indexed_at INTEGER NOT NULL, node_count INTEGER DEFAULT 0,
          errors TEXT)`);
        db.exec(
          `INSERT INTO nodes VALUES('${p}#1', 'function', '${qname.split('::').pop()}',` +
            ` '${qname}', 'src/a.ts', 'typescript', 1, 3, 0, 0, NULL)`,
        );
        db.exec(
          `INSERT INTO files VALUES('src/a.ts', 'h${p}', 'typescript', 100, 0, 0, 1, NULL)`,
        );
        db.close();
      }
      const result = diffDatabases(v5DbA, v5DbB);
      // Two different qnames → one added in B, one removed in A.
      expect(result.summary.addedNodes).toBe(1);
      expect(result.summary.removedNodes).toBe(1);
      expect(result.summary.changedNodes).toBe(0);
      // Both v5 DBs lack fingerprint columns → 0 nodes carry astHash.
      expect(result.fingerprintCoverage.old.nodesWithAstHash).toBe(0);
      expect(result.fingerprintCoverage.new.nodesWithAstHash).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emits null (not -1 sentinel) for NULL line/col in edge identities', async () => {
    // PR #39 round 3 NITPICK fix: the internal Map key uses -1 as a
    // null-bucket sentinel (matches PF-625 UNIQUE INDEX semantics),
    // but the public JSON output must preserve the original `null`.
    oldP = await makeProject({
      'src/a.ts': `export function add(a: number, b: number): number {\n  return a + b;\n}\n`,
    });
    newP = await makeProject({
      'src/a.ts': `export function add(a: number, b: number): number {\n  return a + b;\n}\n` +
        `export function sub(a: number, b: number): number { return a - b; }\n`,
    });
    const result = diffDatabases(oldP.dbPath, newP.dbPath);
    // All edge identities (added/removed/changed) should have number-or-null
    // line/col, never the internal -1 sentinel.
    const allEdges = [...result.addedEdges, ...result.removedEdges];
    for (const e of allEdges) {
      expect(e.line === null || (typeof e.line === 'number' && e.line !== -1)).toBe(true);
      expect(e.col === null || (typeof e.col === 'number' && e.col !== -1)).toBe(true);
    }
  });

  it('reports added/removed/changed files via the files table', async () => {
    // PR #39 round 3 BLOCKER fix: a file added/removed must surface
    // at the file granularity even when its node count is 0.
    oldP = await makeProject({
      'src/a.ts': 'export function helper(): number { return 1; }\n',
    });
    newP = await makeProject({
      'src/a.ts': 'export function helper(): number { return 2; }\n',
      'src/b.ts': 'export function added(): number { return 3; }\n',
    });
    const result = diffDatabases(oldP.dbPath, newP.dbPath);
    // b.ts → addedFiles, a.ts changed content (different body)
    const addedPaths = result.addedFiles.map((f) => f.path).join(',');
    expect(addedPaths).toMatch(/b\.ts/);
    const changedPaths = result.changedFiles.map((f) => f.path).join(',');
    expect(changedPaths).toMatch(/a\.ts/);
    const aChange = result.changedFiles.find((f) => f.path.endsWith('a.ts'));
    expect(aChange!.changedFields).toContain('contentHash');
  });

  it('reports changedEdges when resolver metadata or provenance drifts', () => {
    // Hand-build two DBs with identical edge identity but different
    // metadata to verify changedEdges fires on resolver drift
    // (PR #39 round 3 REVIEW fix).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void };
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-diff-edgechange-'));
    const oldDb = path.join(dir, 'old.db');
    const newDb = path.join(dir, 'new.db');
    try {
      const buildSchema = (db: { exec(sql: string): void }) => {
        db.exec(`CREATE TABLE nodes(
          id TEXT PRIMARY KEY, kind TEXT, name TEXT, qualified_name TEXT,
          file_path TEXT, language TEXT,
          start_line INT, end_line INT, start_column INT, end_column INT,
          signature TEXT, ast_hash TEXT, ast_shape_hash TEXT,
          sig_hash TEXT, call_pattern_hash TEXT)`);
        db.exec(`CREATE TABLE edges(
          id INTEGER PRIMARY KEY, source TEXT, target TEXT, kind TEXT,
          metadata TEXT, line INT, col INT, provenance TEXT)`);
        db.exec(`CREATE TABLE files(
          path TEXT PRIMARY KEY, content_hash TEXT NOT NULL, language TEXT NOT NULL,
          size INTEGER NOT NULL, modified_at INTEGER NOT NULL,
          indexed_at INTEGER NOT NULL, node_count INTEGER DEFAULT 0,
          errors TEXT)`);
        db.exec(
          `INSERT INTO nodes VALUES('src-node', 'function', 'callerFn', 'src/a.ts::callerFn',
            'src/a.ts', 'typescript', 1, 5, 0, 0, NULL, NULL, NULL, NULL, NULL)`,
        );
        db.exec(
          `INSERT INTO nodes VALUES('tgt-node', 'function', 'targetFn', 'src/b.ts::targetFn',
            'src/b.ts', 'typescript', 1, 3, 0, 0, NULL, NULL, NULL, NULL, NULL)`,
        );
      };

      const dbOld = new DatabaseSync(oldDb);
      buildSchema(dbOld);
      dbOld.exec(
        `INSERT INTO edges(source, target, kind, metadata, line, col, provenance)
         VALUES('src-node', 'tgt-node', 'calls',
                '{"resolvedBy":"fuzzy","confidence":0.3}', 2, 5, 'heuristic')`,
      );
      dbOld.close();

      const dbNew = new DatabaseSync(newDb);
      buildSchema(dbNew);
      dbNew.exec(
        `INSERT INTO edges(source, target, kind, metadata, line, col, provenance)
         VALUES('src-node', 'tgt-node', 'calls',
                '{"resolvedBy":"qualified-name","confidence":0.85}', 2, 5, 'tree-sitter')`,
      );
      dbNew.close();

      const result = diffDatabases(oldDb, newDb);
      expect(result.summary.addedEdges).toBe(0);
      expect(result.summary.removedEdges).toBe(0);
      expect(result.summary.changedEdges).toBe(1);
      const ce = result.changedEdges[0];
      expect(ce.changedFields).toContain('metadata');
      expect(ce.changedFields).toContain('provenance');
      expect(ce.old.provenance).toBe('heuristic');
      expect(ce.new.provenance).toBe('tree-sitter');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('wraps non-SQLite file errors with friendly message', () => {
    // PR #39 round 3 REVIEW fix: random `.db` file → invalid CodeGraph database.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-diff-corrupt-'));
    const fakeDb = path.join(dir, 'fake.db');
    try {
      fs.writeFileSync(fakeDb, 'this is not a SQLite database\n');
      expect(() => diffDatabases(fakeDb, fakeDb)).toThrow(/Invalid CodeGraph database/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('summary counts match every array length (including new fields)', async () => {
    oldP = await makeProject({
      'src/a.ts': 'export function one(): number { return 1; }\n',
    });
    newP = await makeProject({
      'src/b.ts': 'export function two(): number { return 2; }\n',
    });
    const result = diffDatabases(oldP.dbPath, newP.dbPath);
    expect(result.summary.addedFiles).toBe(result.addedFiles.length);
    expect(result.summary.removedFiles).toBe(result.removedFiles.length);
    expect(result.summary.changedFiles).toBe(result.changedFiles.length);
    expect(result.summary.changedEdges).toBe(result.changedEdges.length);
  });
});
