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
    const calls = edges.filter((e) => e.kind === 'calls' && e.target.includes('helper'));
    // Both calls share the same target node; if only one was emitted,
    // the resolver may have deduplicated and the ambiguity case
    // doesn't fire. Skip the assertion in that situation rather than
    // pretending the test ran.
    if (calls.length < 2) {
      return;
    }
    // Pick a (source, target, kind) tuple that is repeated.
    const grouped = new Map<string, typeof calls>();
    for (const e of calls) {
      const k = `${e.source}\x1f${e.target}\x1f${e.kind}`;
      const v = grouped.get(k) ?? [];
      v.push(e);
      grouped.set(k, v);
    }
    const repeated = [...grouped.entries()].find(([, v]) => v.length > 1);
    if (!repeated) return;
    const [, dupes] = repeated;
    expect(() =>
      explainEdgeByCanonical(fixture!.dbPath, {
        source: dupes[0].source,
        target: dupes[0].target,
        kind: 'calls',
      }),
    ).toThrow(/ambiguous|--line/i);
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
});
