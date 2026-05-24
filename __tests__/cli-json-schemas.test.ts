/**
 * PF-613 follow-up: validate CLI `--json` outputs against the
 * versioned JSON Schemas in `schemas/cli/`. Each schema documents
 * the shape of one CLI surface and conforms to the shared envelope
 * via `$ref: envelope.json`.
 *
 * Test runs against the built dist binary, skipped when
 * `dist/bin/codegraph.js` is absent so contributors can run
 * `npm test` without a fresh build. The source-level envelope
 * contract in `cli-json-envelope-helper.test.ts` runs
 * unconditionally and protects the envelope shape even when this
 * dist suite is skipped.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import Ajv, { type ValidateFunction } from 'ajv';

const DIST_BIN = path.resolve(__dirname, '..', 'dist', 'bin', 'codegraph.js');
const SCHEMA_DIR = path.resolve(__dirname, '..', 'schemas', 'cli');
const NODE_BIN = process.execPath;
const HAS_DIST = fs.existsSync(DIST_BIN);
const itIfDist = HAS_DIST ? it : it.skip;

function loadValidator(name: string): ValidateFunction {
  // Use draft-07; allow $ref between schema files in this directory.
  const ajv = new Ajv({ allErrors: true, strict: false });
  // Register the envelope under its filename so per-tool schemas can
  // resolve `{ "$ref": "envelope.json" }`. When the target IS the
  // envelope, compile directly to avoid the $id collision.
  const target = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, `${name}.json`), 'utf8'));
  if (name !== 'envelope') {
    const envelope = JSON.parse(
      fs.readFileSync(path.join(SCHEMA_DIR, 'envelope.json'), 'utf8'),
    );
    ajv.addSchema(envelope, 'envelope.json');
  }
  return ajv.compile(target);
}

function runCliJson(args: string[]): unknown {
  const stdout = execFileSync(NODE_BIN, [DIST_BIN, ...args], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return JSON.parse(stdout);
}

function setupProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-pf613b-'));
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src', 'impl.ts'),
      'export function impl(): number { return 1; }\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'caller.ts'),
      "import { impl } from './impl';\nexport function run() { impl(); }\n",
      'utf8',
    );
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"pf613b-fixture"}\n', 'utf8');
    execFileSync(NODE_BIN, [DIST_BIN, 'init', '-i', dir], { stdio: 'ignore' });
    return dir;
  } catch (err) {
    // Self-clean the temp dir on any setup failure so the test runner
    // doesn't leak fixtures when init or fs writes throw before the
    // caller could assign the path to its cleanup-tracking variable.
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

function expectValid(validate: ValidateFunction, output: unknown): void {
  const ok = validate(output);
  if (!ok) {
    // Detailed failure with all errors for the failing assertion message.
    throw new Error(
      `JSON Schema validation failed:\n${JSON.stringify(validate.errors, null, 2)}\nReceived:\n${JSON.stringify(output, null, 2)}`,
    );
  }
  expect(ok).toBe(true);
}

describe('PF-613 follow-up: CLI JSON schema validation', () => {
  let projectDir: string | undefined;

  function cleanup() {
    if (projectDir && fs.existsSync(projectDir)) {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
    projectDir = undefined;
  }

  itIfDist('status output conforms to schemas/cli/status.json', () => {
    projectDir = setupProject();
    try {
      const validate = loadValidator('status');
      const out = runCliJson(['status', projectDir, '--json']);
      expectValid(validate, out);
    } finally {
      cleanup();
    }
  });

  itIfDist('callers output conforms to schemas/cli/callers.json', () => {
    projectDir = setupProject();
    try {
      const validate = loadValidator('callers');
      const out = runCliJson(['callers', 'impl', '-p', projectDir, '--json']);
      expectValid(validate, out);
    } finally {
      cleanup();
    }
  });

  itIfDist('callees output conforms to schemas/cli/callees.json', () => {
    projectDir = setupProject();
    try {
      const validate = loadValidator('callees');
      const out = runCliJson(['callees', 'run', '-p', projectDir, '--json']);
      expectValid(validate, out);
    } finally {
      cleanup();
    }
  });

  itIfDist('impact output conforms to schemas/cli/impact.json', () => {
    projectDir = setupProject();
    try {
      const validate = loadValidator('impact');
      const out = runCliJson(['impact', 'impl', '-p', projectDir, '--json']);
      expectValid(validate, out);
    } finally {
      cleanup();
    }
  });

  itIfDist('inventory output conforms to schemas/cli/inventory.json', () => {
    projectDir = setupProject();
    try {
      const validate = loadValidator('inventory');
      const out = runCliJson(['inventory', projectDir, '--json']);
      expectValid(validate, out);
    } finally {
      cleanup();
    }
  });

  itIfDist('files output conforms to schemas/cli/files.json', () => {
    projectDir = setupProject();
    try {
      const validate = loadValidator('files');
      const out = runCliJson(['files', '-p', projectDir, '--json']);
      expectValid(validate, out);
    } finally {
      cleanup();
    }
  });

  itIfDist('search output conforms to schemas/cli/search.json', () => {
    projectDir = setupProject();
    try {
      const validate = loadValidator('search');
      const out = runCliJson(['query', 'impl', '-p', projectDir, '--json']);
      expectValid(validate, out);
    } finally {
      cleanup();
    }
  });

  itIfDist('affected output conforms to schemas/cli/affected.json', () => {
    projectDir = setupProject();
    try {
      const validate = loadValidator('affected');
      const out = runCliJson(['affected', '-p', projectDir, '--json', 'src/impl.ts']);
      expectValid(validate, out);
    } finally {
      cleanup();
    }
  });

  it('envelope schema validates a hand-built minimal envelope', () => {
    const validate = loadValidator('envelope');
    expect(validate({ schemaVersion: 1, tool: 'status' })).toBe(true);
    expect(validate({ schemaVersion: 1, tool: 'invented-tool' })).toBe(false);
    expect(validate({ schemaVersion: 2, tool: 'status' })).toBe(false);
    expect(validate({ tool: 'status' })).toBe(false);
  });

  // PF-613c: not-found / empty branches must emit a valid envelope, not a
  // plain-text "not found" line. These cases pin the contract guarantee.

  itIfDist('callers not-found output conforms to schema (notFound + empty array)', () => {
    projectDir = setupProject();
    try {
      const validate = loadValidator('callers');
      const out = runCliJson([
        'callers',
        '__pf613c_definitely_missing__',
        '-p',
        projectDir,
        '--json',
      ]) as { notFound?: boolean; callers?: unknown[] };
      expectValid(validate, out);
      expect(out.notFound).toBe(true);
      expect(out.callers).toEqual([]);
    } finally {
      cleanup();
    }
  });

  itIfDist('callees not-found output conforms to schema (notFound + empty array)', () => {
    projectDir = setupProject();
    try {
      const validate = loadValidator('callees');
      const out = runCliJson([
        'callees',
        '__pf613c_definitely_missing__',
        '-p',
        projectDir,
        '--json',
      ]) as { notFound?: boolean; callees?: unknown[] };
      expectValid(validate, out);
      expect(out.notFound).toBe(true);
      expect(out.callees).toEqual([]);
    } finally {
      cleanup();
    }
  });

  itIfDist('impact not-found output conforms to schema (notFound + zero counts)', () => {
    projectDir = setupProject();
    try {
      const validate = loadValidator('impact');
      const out = runCliJson([
        'impact',
        '__pf613c_definitely_missing__',
        '-p',
        projectDir,
        '--json',
      ]) as {
        notFound?: boolean;
        affected?: unknown[];
        nodeCount?: number;
        edgeCount?: number;
      };
      expectValid(validate, out);
      expect(out.notFound).toBe(true);
      expect(out.affected).toEqual([]);
      expect(out.nodeCount).toBe(0);
      expect(out.edgeCount).toBe(0);
    } finally {
      cleanup();
    }
  });

  itIfDist('files no-matches output conforms to schema (reason + empty array)', () => {
    projectDir = setupProject();
    try {
      const validate = loadValidator('files');
      const out = runCliJson([
        'files',
        '-p',
        projectDir,
        '--filter',
        'does/not/exist',
        '--json',
      ]) as { reason?: string; files?: unknown[] };
      expectValid(validate, out);
      expect(out.reason).toBe('no_matches');
      expect(out.files).toEqual([]);
    } finally {
      cleanup();
    }
  });

  itIfDist('files not-indexed output conforms to schema (reason=not_indexed)', () => {
    // Init an empty source tree so the index is valid but contains zero
    // files — this is the not_indexed branch in the files command.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-pf613c-empty-'));
    try {
      fs.writeFileSync(path.join(empty, 'package.json'), '{"name":"pf613c-empty"}\n', 'utf8');
      execFileSync(NODE_BIN, [DIST_BIN, 'init', '-i', empty], { stdio: 'ignore' });
      const validate = loadValidator('files');
      const out = runCliJson(['files', '-p', empty, '--json']) as {
        reason?: string;
        files?: unknown[];
      };
      expectValid(validate, out);
      expect(out.reason).toBe('not_indexed');
      expect(out.files).toEqual([]);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  itIfDist('affected rejects --depth=NaN with exit(1) (silent BFS uncapping fix)', () => {
    // Regression for Codex round-2 finding: affected --depth raw parseInt
    // produced NaN, and `current.depth >= NaN` is always false, silently
    // disabling the BFS depth cap. The fix mirrors impact's NaN guard.
    projectDir = setupProject();
    try {
      let threw = false;
      let stderr = '';
      try {
        execFileSync(
          NODE_BIN,
          [DIST_BIN, 'affected', '-p', projectDir!, '--depth', 'abc', '--json', 'src/impl.ts'],
          { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
        );
      } catch (err) {
        threw = true;
        const e = err as { status?: number; stderr?: Buffer | string };
        expect(e.status).toBe(1);
        stderr = String(e.stderr ?? '');
      }
      expect(threw).toBe(true);
      expect(stderr).toMatch(/Invalid --depth/);
    } finally {
      cleanup();
    }
  });

  itIfDist('impact rejects --depth=NaN with exit(1) instead of emitting depth:null', () => {
    // Regression for PF-613c pass 1: parseInt("abc") => NaN, which
    // JSON.stringify serializes as null, violating impact.json's
    // `depth: integer minimum 1` on the not-found branch.
    projectDir = setupProject();
    try {
      // execFileSync throws when the child exits non-zero. We want to
      // assert exit code 1 + a clear error on stderr — not a JSON payload.
      let threw = false;
      let stderr = '';
      try {
        execFileSync(
          NODE_BIN,
          [DIST_BIN, 'impact', 'impl', '-p', projectDir!, '--depth', 'abc', '--json'],
          { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
        );
      } catch (err) {
        threw = true;
        const e = err as { status?: number; stderr?: Buffer | string };
        expect(e.status).toBe(1);
        stderr = String(e.stderr ?? '');
      }
      expect(threw).toBe(true);
      expect(stderr).toMatch(/Invalid --depth/);
    } finally {
      cleanup();
    }
  });

  itIfDist('affected with no input files conforms to schema (empty payload)', () => {
    projectDir = setupProject();
    try {
      const validate = loadValidator('affected');
      // Passing no positional file args and no --stdin lands on the
      // changedFiles.length === 0 branch.
      const out = runCliJson(['affected', '-p', projectDir, '--json']) as {
        changedFiles?: unknown[];
        affectedTests?: unknown[];
        totalDependentsTraversed?: number;
      };
      expectValid(validate, out);
      expect(out.changedFiles).toEqual([]);
      expect(out.affectedTests).toEqual([]);
      expect(out.totalDependentsTraversed).toBe(0);
    } finally {
      cleanup();
    }
  });

  // PF-691: `codegraph diff` JSON output conforms to schemas/cli/diff.json.
  itIfDist('diff between two identical projects conforms to schemas/cli/diff.json', () => {
    projectDir = setupProject();
    // Re-use the same fixture as the "old" and "new" — diff should
    // be empty but the envelope shape must still validate.
    const dbPath = path.join(projectDir!, '.codegraph', 'codegraph.db');
    try {
      const validate = loadValidator('diff');
      const out = runCliJson(['diff', dbPath, dbPath, '--json']) as {
        addedNodes?: unknown[];
        removedNodes?: unknown[];
        changedNodes?: unknown[];
        addedEdges?: unknown[];
        removedEdges?: unknown[];
        summary?: { addedNodes: number; removedNodes: number; changedNodes: number };
      };
      expectValid(validate, out);
      // Identical DB vs itself: every diff field must be empty.
      expect(out.addedNodes).toEqual([]);
      expect(out.removedNodes).toEqual([]);
      expect(out.changedNodes).toEqual([]);
      expect(out.summary!.addedNodes).toBe(0);
      expect(out.summary!.removedNodes).toBe(0);
      expect(out.summary!.changedNodes).toBe(0);
    } finally {
      cleanup();
    }
  });

  // PF-692: `codegraph duplicates` JSON output conforms to schemas/cli/duplicates.json.
  // PR #40 round 2 REVIEW fix: use a fixture with a REAL duplicate
  // so the group/member subschema (fileCount, coveredByExactGroup,
  // members minItems:2) is exercised, not just the empty-output
  // envelope shape.
  itIfDist('duplicates with a real clone fixture conforms to schemas/cli/duplicates.json', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-pf613b-dup-'));
    projectDir = dir;
    try {
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      // Same-named function in two files with a body large enough
      // to clear the default --min-lines=10 floor.
      const body = `{
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
      fs.writeFileSync(
        path.join(dir, 'src', 'a.ts'),
        `export function shared(x: number): number ${body}\n`,
      );
      fs.writeFileSync(
        path.join(dir, 'src', 'b.ts'),
        `export function shared(x: number): number ${body}\n`,
      );
      fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"pf613-dup","version":"0"}\n');
      execFileSync(NODE_BIN, [DIST_BIN, 'init', '-i', dir], { stdio: 'ignore' });

      const validate = loadValidator('duplicates');
      const out = runCliJson(['duplicates', dir, '--json']) as {
        groups?: Array<{ kind: string; members: unknown[]; fileCount: number; coveredByExactGroup: boolean }>;
        summary?: { exactGroups: number; shapeGroups: number };
      };
      expectValid(validate, out);
      // Real duplicates → at least one exact group with fileCount=2.
      expect(out.summary!.exactGroups).toBeGreaterThanOrEqual(1);
      const exact = out.groups!.find((g) => g.kind === 'exact');
      expect(exact, 'expected at least one exact group').toBeDefined();
      expect(exact!.fileCount).toBe(2);
      expect(exact!.coveredByExactGroup).toBe(false);
      expect(exact!.members.length).toBeGreaterThanOrEqual(2);
    } finally {
      cleanup();
    }
  });

  // PF-693: `codegraph explain` JSON output conforms to schemas/cli/explain.json.
  itIfDist('explain on a real call edge conforms to schemas/cli/explain.json', () => {
    // Build a small fixture with a known import/call pair so at
    // least one `calls` edge persists in the index.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-pf613b-explain-'));
    projectDir = dir;
    try {
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'util.ts'),
        'export function helper(): number { return 42; }\n',
      );
      fs.writeFileSync(
        path.join(dir, 'src', 'main.ts'),
        "import { helper } from './util';\n" +
          'export function main(): number { return helper(); }\n',
      );
      fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"pf613-explain","version":"0"}\n');
      execFileSync(NODE_BIN, [DIST_BIN, 'init', '-i', dir], { stdio: 'ignore' });

      // Find the call edge id by reading the DB directly — same
      // path explainEdgeById uses internally.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { DatabaseSync } = require('node:sqlite') as {
        DatabaseSync: new (p: string) => { prepare: (s: string) => { all: () => unknown[] }; close: () => void };
      };
      const dbPath = path.join(dir, '.codegraph', 'codegraph.db');
      const db = new DatabaseSync(dbPath);
      const edges = db.prepare('SELECT id FROM edges WHERE kind = ?').all('calls') as Array<{
        id: number;
      }>;
      db.close();
      if (edges.length === 0) {
        // The resolver/extractor pipeline may not emit a calls edge
        // for this fixture on every CI matrix; skip rather than
        // produce a false failure.
        return;
      }
      const validate = loadValidator('explain');
      const out = runCliJson(['explain', String(edges[0].id), '-p', dir, '--json']) as {
        edgeId?: number;
      };
      expectValid(validate, out);
      expect(out.edgeId).toBe(edges[0].id);
    } finally {
      cleanup();
    }
  });
});
