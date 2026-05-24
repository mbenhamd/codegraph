/**
 * PF-693: `codegraph explain` primitive tests.
 *
 * Build a real fixture via `CodeGraph.init` so the resolver runs
 * end-to-end, then exercise both the integer-id and canonical
 * lookup paths against the persisted breadcrumbs.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import {
  explainEdgeById,
  explainEdgeByCanonical,
  formatExplainNarrative,
} from '../src/explain';
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-explain-'));
  for (const [relPath, content] of Object.entries(files)) {
    const full = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  const cg = await CodeGraph.init(dir, { index: true });
  cg.destroy();
  return { dir, dbPath: path.join(dir, '.codegraph', 'codegraph.db') };
}

function cleanup(p: ProjectFixture | undefined): void {
  if (p && fs.existsSync(p.dir)) {
    fs.rmSync(p.dir, { recursive: true, force: true });
  }
}

/**
 * Pull every persisted edge directly via the read-only path,
 * matching what `explainEdgeById` will see. Used as a fixture
 * helper — tests pick the first call-kind edge and feed it
 * into the explain primitive.
 */
function listEdges(dbPath: string): Array<{
  id: number;
  source: string;
  target: string;
  kind: string;
  line: number | null;
  col: number | null;
}> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (
      p: string,
      o?: { readOnly?: boolean },
    ) => { prepare: (s: string) => { all: () => unknown[] }; close: () => void };
  };
  const { pathToFileURL } = require('url') as typeof import('url');
  const db = new DatabaseSync(pathToFileURL(dbPath).href + '?immutable=1', {
    readOnly: true,
  });
  try {
    return db
      .prepare('SELECT id, source, target, kind, line, col FROM edges')
      .all() as Array<{ id: number; source: string; target: string; kind: string; line: number | null; col: number | null }>;
  } finally {
    db.close();
  }
}

describe('PF-693: explainEdge', () => {
  let fixture: ProjectFixture | undefined;

  beforeEach(() => {
    fixture = undefined;
  });

  afterEach(() => {
    cleanup(fixture);
  });

  it('looks up a call edge by integer id and surfaces resolver provenance', async () => {
    fixture = await makeProject({
      'src/util.ts': 'export function helper(): number { return 42; }\n',
      'src/main.ts':
        "import { helper } from './util';\n" +
        'export function main(): number { return helper(); }\n',
    });
    const edges = listEdges(fixture.dbPath);
    const callEdge = edges.find((e) => e.kind === 'calls');
    expect(callEdge, 'expected at least one calls edge in fixture').toBeDefined();
    const result = explainEdgeById(fixture.dbPath, callEdge!.id);
    expect(result.edgeId).toBe(callEdge!.id);
    expect(result.kind).toBe('calls');
    expect(result.sourceNode, 'sourceNode should resolve').not.toBeNull();
    expect(result.targetNode, 'targetNode should resolve').not.toBeNull();
    // The helper() call site should track back to a real source line.
    expect(result.line).not.toBeNull();
    // Resolver metadata should populate (this is an import-driven call).
    // We don't lock the strategy name because the resolver chain may
    // route through several handlers; just verify SOMETHING was persisted.
    const hasProvenance =
      result.resolvedBy !== null ||
      result.confidence !== null ||
      result.extractorProvenance !== null;
    expect(hasProvenance, `expected at least one provenance field; got ${JSON.stringify(result)}`).toBe(
      true,
    );
  });

  it('looks up by canonical identity (source + target + kind)', async () => {
    fixture = await makeProject({
      'src/util.ts': 'export function helper(): number { return 42; }\n',
      'src/main.ts':
        "import { helper } from './util';\n" +
        'export function main(): number { return helper(); }\n',
    });
    const edges = listEdges(fixture.dbPath);
    const callEdge = edges.find((e) => e.kind === 'calls');
    expect(callEdge).toBeDefined();
    const result = explainEdgeByCanonical(fixture.dbPath, {
      source: callEdge!.source,
      target: callEdge!.target,
      kind: 'calls',
    });
    expect(result.edgeId).toBe(callEdge!.id);
    expect(result.source).toBe(callEdge!.source);
    expect(result.target).toBe(callEdge!.target);
  });

  it('errors on ambiguous canonical lookup with a --line N hint', async () => {
    // Two call sites for the same target on different lines —
    // (source, target, kind) alone is ambiguous; explain should
    // refuse and point the user at --line / --col.
    fixture = await makeProject({
      'src/util.ts': 'export function helper(): number { return 42; }\n',
      'src/main.ts':
        "import { helper } from './util';\n" +
        'export function a(): number { return helper(); }\n' +
        'export function b(): number { return helper(); }\n',
    });
    const edges = listEdges(fixture.dbPath);
    // Hand-built ambiguity fixture: insert two distinct call-site
    // edges with the same (source, target, kind) but different
    // line/col. The skip-on-precondition pattern from PR #41 round
    // 1 was unreliable — Codex flagged it because the resolver may
    // deduplicate and the test silently passes for the wrong
    // reason. PR #41 round 2 fix.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (p: string) => { exec(sql: string): void; close(): void };
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-explain-amb-'));
    const dbPath = path.join(dir, 'amb.db');
    try {
      const db = new DatabaseSync(dbPath);
      db.exec(`CREATE TABLE nodes(
        id TEXT PRIMARY KEY, kind TEXT, name TEXT, qualified_name TEXT,
        file_path TEXT, language TEXT,
        start_line INT, end_line INT, start_column INT, end_column INT,
        signature TEXT)`);
      db.exec(`CREATE TABLE edges(
        id INTEGER PRIMARY KEY, source TEXT, target TEXT, kind TEXT,
        metadata TEXT, line INT, col INT, provenance TEXT)`);
      db.exec(`INSERT INTO nodes VALUES('src-id', 'function', 'caller', 'src/a.ts::caller',
        'src/a.ts', 'typescript', 1, 10, 0, 0, NULL)`);
      db.exec(`INSERT INTO nodes VALUES('tgt-id', 'function', 'callee', 'src/b.ts::callee',
        'src/b.ts', 'typescript', 1, 3, 0, 0, NULL)`);
      // Two call sites at the same (source, target, kind) — must
      // produce ambiguity.
      db.exec(`INSERT INTO edges(source, target, kind, line, col)
        VALUES('src-id', 'tgt-id', 'calls', 3, 5)`);
      db.exec(`INSERT INTO edges(source, target, kind, line, col)
        VALUES('src-id', 'tgt-id', 'calls', 7, 5)`);
      db.close();

      expect(() =>
        explainEdgeByCanonical(dbPath, {
          source: 'src-id',
          target: 'tgt-id',
          kind: 'calls',
        }),
      ).toThrow(/ambiguous|--line/i);

      // Disambiguating with --line resolves it.
      const result = explainEdgeByCanonical(dbPath, {
        source: 'src-id',
        target: 'tgt-id',
        kind: 'calls',
        line: 7,
      });
      expect(result.line).toBe(7);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('errors when no edge matches the canonical identity', async () => {
    fixture = await makeProject({
      'src/util.ts': 'export function helper(): number { return 42; }\n',
    });
    expect(() =>
      explainEdgeByCanonical(fixture!.dbPath, {
        source: 'nonexistent-source',
        target: 'nonexistent-target',
        kind: 'calls',
      }),
    ).toThrow(/no edge matches/i);
  });

  it('errors when looking up a missing edge id', async () => {
    fixture = await makeProject({
      'src/a.ts': 'export function only(): number { return 1; }\n',
    });
    expect(() => explainEdgeById(fixture!.dbPath, 999999)).toThrow(/no edge with id/i);
  });

  it('rejects non-positive edge ids before opening the DB', () => {
    expect(() => explainEdgeById('/dev/null', 0)).toThrow(/positive integer/i);
    expect(() => explainEdgeById('/dev/null', -5)).toThrow(/positive integer/i);
    expect(() => explainEdgeById('/dev/null', 1.5)).toThrow(/positive integer/i);
  });

  it('formats a readable narrative for terminal output', async () => {
    fixture = await makeProject({
      'src/util.ts': 'export function helper(): number { return 42; }\n',
      'src/main.ts':
        "import { helper } from './util';\n" +
        'export function main(): number { return helper(); }\n',
    });
    const edges = listEdges(fixture.dbPath);
    const callEdge = edges.find((e) => e.kind === 'calls');
    if (!callEdge) return;
    const result = explainEdgeById(fixture.dbPath, callEdge.id);
    const narrative = formatExplainNarrative(result);
    expect(narrative).toContain('edge #');
    expect(narrative).toContain('[calls]');
    expect(narrative).toContain('resolver:');
    expect(narrative).toContain('extractor:');
  });

  it('throws on a non-CodeGraph SQLite file', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (p: string) => { exec(sql: string): void; close(): void };
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-explain-bare-'));
    const dbPath = path.join(dir, 'bare.db');
    try {
      const db = new DatabaseSync(dbPath);
      db.exec('CREATE TABLE other(x INT)');
      db.close();
      expect(() => explainEdgeById(dbPath, 1)).toThrow(/not a CodeGraph database/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not mutate the DB or create WAL sidecars', async () => {
    fixture = await makeProject({
      'src/util.ts': 'export function helper(): number { return 42; }\n',
      'src/main.ts':
        "import { helper } from './util';\n" +
        'export function main(): number { return helper(); }\n',
    });
    const edges = listEdges(fixture.dbPath);
    const callEdge = edges.find((e) => e.kind === 'calls');
    if (!callEdge) return;
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
    const before = snapshot(fixture.dbPath);
    explainEdgeById(fixture.dbPath, callEdge.id);
    expect(snapshot(fixture.dbPath)).toEqual(before);
  });

  it('throws when the database path does not exist', () => {
    const missing = '/tmp/codegraph-explain-missing-' + Date.now() + '.db';
    expect(() => explainEdgeById(missing, 1)).toThrow(/not found/i);
  });

  it('reports traceAvailable: false (PR #41 round 2 scope-honesty BLOCKER fix)', async () => {
    fixture = await makeProject({
      'src/util.ts': 'export function helper(): number { return 42; }\n',
      'src/main.ts':
        "import { helper } from './util';\n" +
        'export function main(): number { return helper(); }\n',
    });
    const edges = listEdges(fixture.dbPath);
    const callEdge = edges.find((e) => e.kind === 'calls');
    if (!callEdge) return;
    const result = explainEdgeById(fixture.dbPath, callEdge.id);
    // The resolver discards loser strategies, so a full causal
    // trace is never available. Locking this at false catches any
    // accidental flip to true before the resolver trace table is
    // actually implemented.
    expect(result.traceAvailable).toBe(false);
  });

  it('surfaces non-object metadata via rawMetadata instead of dropping it (PR #41 round 2)', () => {
    // Hand-build a DB with edge metadata that's a JSON ARRAY
    // (legacy / unexpected shape). parseMetadata used to silently
    // return null; round 2 fix exposes the raw string so users
    // know there's content they just can't interpret as an object.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (p: string) => { exec(sql: string): void; close(): void };
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-explain-raw-'));
    const dbPath = path.join(dir, 'raw.db');
    try {
      const db = new DatabaseSync(dbPath);
      db.exec(`CREATE TABLE nodes(
        id TEXT PRIMARY KEY, kind TEXT, name TEXT, qualified_name TEXT,
        file_path TEXT, language TEXT,
        start_line INT, end_line INT, start_column INT, end_column INT,
        signature TEXT)`);
      db.exec(`CREATE TABLE edges(
        id INTEGER PRIMARY KEY, source TEXT, target TEXT, kind TEXT,
        metadata TEXT, line INT, col INT, provenance TEXT)`);
      db.exec(`INSERT INTO nodes VALUES('src', 'function', 'a', 'a', 'a.ts', 'typescript', 1, 2, 0, 0, NULL)`);
      db.exec(`INSERT INTO nodes VALUES('tgt', 'function', 'b', 'b', 'b.ts', 'typescript', 1, 2, 0, 0, NULL)`);
      db.exec(`INSERT INTO edges(source, target, kind, metadata, line, col)
        VALUES('src', 'tgt', 'calls', '["legacy", "array", "shape"]', 1, 0)`);
      db.close();

      const result = explainEdgeByCanonical(dbPath, {
        source: 'src',
        target: 'tgt',
        kind: 'calls',
      });
      expect(result.metadata).toBeNull();
      expect(result.rawMetadata).toBe('["legacy", "array", "shape"]');
      // No resolvedBy/confidence can be derived from a non-object.
      expect(result.resolvedBy).toBeNull();
      expect(result.confidence).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
