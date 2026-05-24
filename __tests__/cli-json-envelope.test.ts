/**
 * PF-613: CLI `--json` outputs share a versioned envelope so downstream
 * consumers (scripts, CI, agents) can branch on `schemaVersion` and
 * verify they're talking to the tool they expect.
 *
 * Every `--json` output should serialize an object with:
 *   - `schemaVersion: 1`  (the envelope version, NOT the payload's own)
 *   - `tool: '<name>'`    (matches the CLI subcommand)
 *   - …tool-specific fields…
 *
 * This test invokes the built dist binary, calls each subcommand that
 * supports `--json`, and verifies the envelope shape. Skipped when
 * `dist/bin/codegraph.js` is not built so contributors can still run
 * `npm test` without a fresh build.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

const DIST_BIN = path.resolve(__dirname, '..', 'dist', 'bin', 'codegraph.js');
const NODE_BIN = process.execPath;
const HAS_DIST = fs.existsSync(DIST_BIN);

const itIfDist = HAS_DIST ? it : it.skip;

function runCliJson(args: string[]): Record<string, unknown> {
  const stdout = execFileSync(NODE_BIN, [DIST_BIN, ...args], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return JSON.parse(stdout);
}

describe('PF-613 CLI JSON envelope', () => {
  let projectDir: string | undefined;

  function setupProject(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-pf613-'));
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
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"pf613-fixture"}\n', 'utf8');
    execFileSync(NODE_BIN, [DIST_BIN, 'init', '-i', dir], { stdio: 'ignore' });
    return dir;
  }

  function teardownProject(): void {
    if (projectDir && fs.existsSync(projectDir)) {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
    projectDir = undefined;
  }

  itIfDist('status --json carries the envelope', () => {
    projectDir = setupProject();
    try {
      const out = runCliJson(['status', projectDir, '--json']);
      expect(out.schemaVersion).toBe(1);
      expect(out.tool).toBe('status');
      expect(out.initialized).toBe(true);
    } finally {
      teardownProject();
    }
  });

  itIfDist('callers --json carries the envelope', () => {
    projectDir = setupProject();
    try {
      const out = runCliJson(['callers', 'impl', '-p', projectDir, '--json']);
      expect(out.schemaVersion).toBe(1);
      expect(out.tool).toBe('callers');
      expect(out.symbol).toBe('impl');
      expect(Array.isArray(out.callers)).toBe(true);
    } finally {
      teardownProject();
    }
  });

  itIfDist('impact --json carries the envelope', () => {
    projectDir = setupProject();
    try {
      const out = runCliJson(['impact', 'impl', '-p', projectDir, '--json']);
      expect(out.schemaVersion).toBe(1);
      expect(out.tool).toBe('impact');
      expect(out.symbol).toBe('impl');
      // PF-606b lowConfidenceEdges shape carries through inside the envelope.
      expect(out.lowConfidenceEdges).toBeDefined();
    } finally {
      teardownProject();
    }
  });

  itIfDist('inventory --json carries the envelope (and preserves payload schemaVersion)', () => {
    projectDir = setupProject();
    try {
      const out = runCliJson(['inventory', projectDir, '--json']);
      expect(out.schemaVersion).toBe(1);
      expect(out.tool).toBe('inventory');
      // The inventory payload itself ALSO carries its own schemaVersion
      // (the inventory contract from PF-624). Those are independent —
      // the CLI envelope describes the JSON shape, the payload
      // schemaVersion describes the inventory data shape.
      const inv = out.inventory as Record<string, unknown>;
      expect(inv.schemaVersion).toBe(1);
      expect(Array.isArray(inv.packages)).toBe(true);
    } finally {
      teardownProject();
    }
  });

  itIfDist('files --json carries the envelope', () => {
    projectDir = setupProject();
    try {
      const out = runCliJson(['files', '-p', projectDir, '--json']);
      expect(out.schemaVersion).toBe(1);
      expect(out.tool).toBe('files');
      expect(Array.isArray(out.files)).toBe(true);
    } finally {
      teardownProject();
    }
  });

  itIfDist('status --json on uninitialized dir still carries the envelope', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-pf613-uninit-'));
    try {
      const out = runCliJson(['status', dir, '--json']);
      expect(out.schemaVersion).toBe(1);
      expect(out.tool).toBe('status');
      expect(out.initialized).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  itIfDist('search --json carries the envelope', () => {
    projectDir = setupProject();
    try {
      const out = runCliJson(['query', 'impl', '-p', projectDir, '--json']);
      expect(out.schemaVersion).toBe(1);
      expect(out.tool).toBe('search');
      expect(out.query).toBe('impl');
      expect(Array.isArray(out.results)).toBe(true);
    } finally {
      teardownProject();
    }
  });

  itIfDist('callees --json carries the envelope', () => {
    projectDir = setupProject();
    try {
      const out = runCliJson(['callees', 'run', '-p', projectDir, '--json']);
      expect(out.schemaVersion).toBe(1);
      expect(out.tool).toBe('callees');
      expect(out.symbol).toBe('run');
      expect(Array.isArray(out.callees)).toBe(true);
    } finally {
      teardownProject();
    }
  });

  itIfDist('affected --json carries the envelope', () => {
    projectDir = setupProject();
    try {
      const out = runCliJson(['affected', '-p', projectDir, '--json', 'src/impl.ts']);
      expect(out.schemaVersion).toBe(1);
      expect(out.tool).toBe('affected');
      expect(Array.isArray(out.changedFiles)).toBe(true);
      expect(Array.isArray(out.affectedTests)).toBe(true);
    } finally {
      teardownProject();
    }
  });
});
