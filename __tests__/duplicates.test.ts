/**
 * PF-692: `codegraph duplicates` primitive tests.
 *
 * Each case builds a real temp project via `CodeGraph.init`,
 * which runs the production extract → fingerprint → persist
 * pipeline. The tests then call `findDuplicates(dbPath, opts)`
 * and assert clone group shape. Synthetic SQLite rows are used
 * only for negative paths (legacy schema, missing DB).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import {
  findDuplicates,
  DEFAULT_DUPLICATE_KINDS,
  DEFAULT_MIN_LINES,
} from '../src/duplicates';
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-dup-'));
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

/** Body large enough to clear the default min-lines floor of 10. */
const LARGE_BODY = `{
  const a = 1;
  const b = 2;
  const c = 3;
  const d = 4;
  const e = 5;
  const f = 6;
  const g = 7;
  const h = 8;
  return a + b + c + d + e + f + g + h;
}`;

describe('PF-692: findDuplicates', () => {
  let fixture: ProjectFixture | undefined;

  beforeEach(() => {
    fixture = undefined;
  });

  afterEach(() => {
    cleanup(fixture);
  });

  it('exposes the council-locked defaults', () => {
    // Locked by the PR #40 RFC — changing these breaks downstream
    // expectations. Fail loudly if anyone tweaks them.
    expect(DEFAULT_DUPLICATE_KINDS).toEqual(['function', 'method']);
    expect(DEFAULT_MIN_LINES).toBe(10);
  });

  it('detects identical same-named functions across files as an exact group', async () => {
    // The `ast_hash` includes the function name (rename-locals only
    // wipes LOCAL identifiers, not the declaration name itself).
    // Two functions named `handler` with the same body in different
    // files are the canonical Type-1 clone shape.
    fixture = await makeProject({
      'src/a.ts': `export function handler(x: number, y: number): number ${LARGE_BODY}\n`,
      'src/b.ts': `export function handler(x: number, y: number): number ${LARGE_BODY}\n`,
    });
    const result = findDuplicates(fixture.dbPath);
    const exactGroup = result.groups.find((g) => g.kind === 'exact');
    expect(
      exactGroup,
      `expected at least one exact group; got: ${JSON.stringify(
        result.groups.map((g) => ({ k: g.kind, n: g.members.length })),
      )}`,
    ).toBeDefined();
    expect(exactGroup!.members.length).toBeGreaterThanOrEqual(2);
    const files = exactGroup!.members.map((m) => m.filePath).join(',');
    expect(files).toMatch(/a\.ts/);
    expect(files).toMatch(/b\.ts/);
  });

  it('detects renamed-but-same-shape functions as a Type-2 shape group', async () => {
    // Same body, DIFFERENT function names. Type-1 (`ast_hash`) won't
    // match because the function name participates in the hash;
    // Type-2 (`ast_shape_hash`) should — it normalizes all
    // identifiers, including the declaration name.
    fixture = await makeProject({
      'src/a.ts': `export function adder(x: number, y: number): number ${LARGE_BODY}\n`,
      'src/b.ts': `export function alsoAdder(x: number, y: number): number ${LARGE_BODY}\n`,
    });
    const result = findDuplicates(fixture.dbPath);
    expect(result.summary.exactGroups).toBe(0);
    const shapeGroup = result.groups.find((g) => g.kind === 'shape');
    expect(shapeGroup, 'shape group should detect the renamed clone').toBeDefined();
    const names = shapeGroup!.members.map((m) => m.qualifiedName).join(',');
    expect(names).toMatch(/adder/);
    expect(names).toMatch(/alsoAdder/);
  });

  it('does NOT report a clone group when only one symbol matches the fingerprint', async () => {
    fixture = await makeProject({
      'src/a.ts': `export function unique(x: number): number ${LARGE_BODY}\n`,
    });
    const result = findDuplicates(fixture.dbPath);
    // Single-member fingerprints aren't clones — GROUP BY ... HAVING > 1
    // filters them out. summary.exactGroups should be 0.
    expect(result.summary.exactGroups).toBe(0);
  });

  it('filters out symbols below --min-lines floor', async () => {
    // Same-name one-line functions across two files — would match
    // Type-1 if min-lines allowed them. Default min-lines=10 should
    // filter them out; min-lines=1 should surface them.
    fixture = await makeProject({
      'src/a.ts': 'export function ping(): number { return 1; }\n',
      'src/b.ts': 'export function ping(): number { return 1; }\n',
    });
    const result = findDuplicates(fixture.dbPath);
    expect(result.summary.exactGroups).toBe(0);
    expect(result.summary.shapeGroups).toBe(0);
    const lowered = findDuplicates(fixture.dbPath, { minLines: 1 });
    expect(lowered.summary.exactGroups).toBeGreaterThanOrEqual(1);
  });

  it('groups sort by member count DESC (RFC fork 5)', async () => {
    // Three same-named copies of `triple` (Type-1 group of 3) and
    // two same-named copies of `pair` (Type-1 group of 2). The
    // triple group must come before the pair group.
    const bodyA = LARGE_BODY;
    const bodyB = `{
  const x = 10;
  const y = 20;
  const z = 30;
  const a = 40;
  const b = 50;
  const c = 60;
  const d = 70;
  const e = 80;
  return x * y * z + a + b + c + d + e;
}`;
    fixture = await makeProject({
      'src/a.ts': `export function triple(x: number): number ${bodyA}\n`,
      'src/b.ts': `export function triple(x: number): number ${bodyA}\n`,
      'src/c.ts': `export function triple(x: number): number ${bodyA}\n`,
      'src/d.ts': `export function pair(x: number): number ${bodyB}\n`,
      'src/e.ts': `export function pair(x: number): number ${bodyB}\n`,
    });
    const result = findDuplicates(fixture.dbPath);
    const groupsBySize = result.groups.map((g) => g.members.length);
    for (let i = 1; i < groupsBySize.length; i++) {
      expect(groupsBySize[i - 1]).toBeGreaterThanOrEqual(groupsBySize[i]);
    }
    expect(groupsBySize[0]).toBeGreaterThanOrEqual(3);
  });

  it('ties on member count fall back to max line span DESC (RFC fork 5 secondary)', async () => {
    // Two clone groups, both with 2 members. The `longBody`
    // group spans more lines per symbol; it must sort before
    // the `shortBody` group despite equal member counts.
    const shortBody = LARGE_BODY; // 11 lines
    const longBody = `{
  const a = 1;
  const b = 2;
  const c = 3;
  const d = 4;
  const e = 5;
  const f = 6;
  const g = 7;
  const h = 8;
  const i = 9;
  const j = 10;
  const k = 11;
  const l = 12;
  const m = 13;
  const n = 14;
  const o = 15;
  return a + b + c + d + e + f + g + h + i + j + k + l + m + n + o;
}`; // 18 lines
    fixture = await makeProject({
      'src/a.ts': `export function shortA(x: number): number ${shortBody}\n`,
      'src/b.ts': `export function shortA(x: number): number ${shortBody}\n`,
      'src/c.ts': `export function longB(x: number): number ${longBody}\n`,
      'src/d.ts': `export function longB(x: number): number ${longBody}\n`,
    });
    const result = findDuplicates(fixture.dbPath);
    expect(result.groups.length).toBe(2);
    expect(result.groups[0].members.length).toBe(2);
    expect(result.groups[1].members.length).toBe(2);
    const span0 = Math.max(
      ...result.groups[0].members.map((m) => m.endLine - m.startLine + 1),
    );
    const span1 = Math.max(
      ...result.groups[1].members.map((m) => m.endLine - m.startLine + 1),
    );
    expect(span0).toBeGreaterThan(span1);
  });

  it('ties on member count AND span fall back to fingerprint ASC (RFC fork 5 tertiary)', async () => {
    // Two clone pairs with identical line spans but structurally
    // different bodies (sum vs product) → different ast_hash AND
    // different ast_shape_hash, so no 4-member shape group forms.
    // The two exact groups must sort by fingerprint ASC after the
    // member-count and span ties.
    const sumBody = `{
  const a = 1;
  const b = 2;
  const c = 3;
  const d = 4;
  const e = 5;
  const f = 6;
  const g = 7;
  const h = 8;
  return a + b + c + d + e + f + g + h;
}`;
    const productBody = `{
  const a = 1;
  const b = 2;
  const c = 3;
  const d = 4;
  const e = 5;
  const f = 6;
  const g = 7;
  const h = 8;
  return a * b * c * d * e * f * g * h;
}`;
    fixture = await makeProject({
      'src/a.ts': `export function alpha(x: number): number ${sumBody}\n`,
      'src/b.ts': `export function alpha(x: number): number ${sumBody}\n`,
      'src/c.ts': `export function bravo(x: number): number ${productBody}\n`,
      'src/d.ts': `export function bravo(x: number): number ${productBody}\n`,
    });
    const result = findDuplicates(fixture.dbPath);
    // Two distinct exact groups, two members each, same span.
    const exactGroups = result.groups.filter((g) => g.kind === 'exact');
    expect(exactGroups.length).toBe(2);
    expect(exactGroups[0].members.length).toBe(2);
    expect(exactGroups[1].members.length).toBe(2);
    // After ties on count and span, fingerprint ASC takes over.
    expect(exactGroups[0].fingerprint < exactGroups[1].fingerprint).toBe(true);
  });

  it('suppresses shape groups that exactly cover an exact group (RFC fork 1)', async () => {
    // Same-named functions in two files form both an exact group
    // (identical ast_hash) AND a shape group covering the same
    // {a, b} member set. The shape group must be suppressed.
    fixture = await makeProject({
      'src/a.ts': `export function shared(x: number, y: number): number ${LARGE_BODY}\n`,
      'src/b.ts': `export function shared(x: number, y: number): number ${LARGE_BODY}\n`,
    });
    const result = findDuplicates(fixture.dbPath);
    expect(result.summary.exactGroups).toBeGreaterThanOrEqual(1);
    // The same-member shape group should NOT also be reported.
    const exactMemberSet = (() => {
      const g = result.groups.find((g) => g.kind === 'exact');
      return new Set(g!.members.map((m) => m.id));
    })();
    for (const g of result.groups.filter((g) => g.kind === 'shape')) {
      const shapeMemberSet = new Set(g.members.map((m) => m.id));
      // Shape group must not match an exact group's member set 1:1.
      const equal =
        shapeMemberSet.size === exactMemberSet.size &&
        [...shapeMemberSet].every((id) => exactMemberSet.has(id));
      expect(equal, `shape group ${g.fingerprint} duplicates an exact group`).toBe(false);
    }
  });

  it('rejects --kind=<empty list> instead of returning silent zero groups', async () => {
    fixture = await makeProject({
      'src/a.ts': `export function any(): number ${LARGE_BODY}\n`,
    });
    expect(() => findDuplicates(fixture!.dbPath, { kinds: [] })).toThrow(
      /--kind list cannot be empty/i,
    );
  });

  it('throws a clear schema error on a v5-style DB (no fingerprint columns)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void };
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-dup-v5-'));
    const dbPath = path.join(dir, 'old.db');
    try {
      const db = new DatabaseSync(dbPath);
      // Minimal v5 shape with NO fingerprint columns.
      db.exec(`CREATE TABLE nodes(
        id TEXT PRIMARY KEY, kind TEXT, name TEXT, qualified_name TEXT,
        file_path TEXT, language TEXT,
        start_line INT, end_line INT, start_column INT, end_column INT,
        signature TEXT)`);
      db.close();
      expect(() => findDuplicates(dbPath)).toThrow(/schema v6\+/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when the database path does not exist', () => {
    const missing = '/tmp/codegraph-dup-missing-' + Date.now() + '.db';
    expect(() => findDuplicates(missing)).toThrow(/not found/i);
  });

  it('does not mutate the DB or create WAL sidecars', async () => {
    // Same Codex BLOCKER concern as PR #39 — the read path must be
    // truly read-only. Snapshots DB + sidecars before, asserts equal
    // after.
    fixture = await makeProject({
      'src/a.ts': `export function clone1(x: number): number ${LARGE_BODY}\n`,
      'src/b.ts': `export function clone2(x: number): number ${LARGE_BODY}\n`,
    });
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
    findDuplicates(fixture.dbPath);
    expect(snapshot(fixture.dbPath)).toEqual(before);
  });
});
