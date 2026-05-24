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
});
