/**
 * PF-617: Framework-resolver contract test harness.
 *
 * Locks the public contract of `FrameworkResolver.extract(filePath, content)`
 * across ecosystems with fixture-driven golden tests. Each fixture in
 * `__tests__/fixtures/framework-contracts/<name>/` contains:
 *
 *   - `source.<ext>` — synthetic minimal source the resolver inspects.
 *   - `meta.json` — `{ resolver, sourcePath, description? }`.
 *   - `expected.json` — the golden `{ nodes, references }` payload the
 *     resolver must emit.
 *
 * This complements the per-resolver unit tests in
 * `__tests__/frameworks.test.ts` by pinning the FULL output shape
 * (nodes + references including ids, ranges, and provenance) rather than
 * spot-checking individual fields. Adding a new framework case is a
 * three-file drop, no harness code changes.
 *
 * ## Capturing or refreshing a golden
 *
 *   1. Add `source.<ext>` + `meta.json` for the new fixture.
 *   2. Run `UPDATE_FRAMEWORK_GOLDENS=1 npm test -- framework-contract-harness`.
 *   3. The harness writes `expected.json` for any fixture without one
 *      and skips the assertion for those cases. Inspect the diff,
 *      confirm the output is what the contract should be, commit.
 *
 * Goldens are stable: every emitted `Node.id` is a deterministic
 * function of the fixture inputs — the route extractors in
 * `frameworks/python.ts`, `frameworks/java.ts`, etc. construct ids
 * like `route:${sourcePath}:${line}:${method}:${routePath}`, all of
 * which are pinned by the fixture. Re-running without source changes
 * reproduces the same JSON byte-for-byte.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { FrameworkResolver } from '../src/resolution/types';
import {
  djangoResolver,
  flaskResolver,
  fastapiResolver,
} from '../src/resolution/frameworks/python';
import { expressResolver } from '../src/resolution/frameworks/express';
import { springResolver } from '../src/resolution/frameworks/java';
import { laravelResolver } from '../src/resolution/frameworks/laravel';
import { railsResolver } from '../src/resolution/frameworks/ruby';
import { nestjsResolver } from '../src/resolution/frameworks/nestjs';
import { goResolver } from '../src/resolution/frameworks/go';
import { rustResolver } from '../src/resolution/frameworks/rust';
import { aspnetResolver } from '../src/resolution/frameworks/csharp';
import { vaporResolver } from '../src/resolution/frameworks/swift';
import { vueResolver } from '../src/resolution/frameworks/vue';
import { svelteResolver } from '../src/resolution/frameworks/svelte';
import { reactResolver } from '../src/resolution/frameworks/react';
import { drupalResolver } from '../src/resolution/frameworks/drupal';

const RESOLVERS: Record<string, FrameworkResolver> = {
  django: djangoResolver,
  flask: flaskResolver,
  fastapi: fastapiResolver,
  express: expressResolver,
  spring: springResolver,
  laravel: laravelResolver,
  rails: railsResolver,
  nestjs: nestjsResolver,
  go: goResolver,
  rust: rustResolver,
  aspnet: aspnetResolver,
  vapor: vaporResolver,
  vue: vueResolver,
  svelte: svelteResolver,
  react: reactResolver,
  drupal: drupalResolver,
};

interface FixtureMeta {
  resolver: string;
  sourcePath: string;
  description?: string;
}

const FIXTURES_DIR = path.resolve(__dirname, 'fixtures', 'framework-contracts');
// Guard against an accidental CI run with UPDATE set — the harness
// would silently rewrite all goldens instead of catching regressions.
// Requires `ALLOW_GOLDEN_UPDATE_IN_CI=1` to opt back in if a CI
// invocation legitimately wants to refresh goldens.
const UPDATE_REQUESTED = process.env.UPDATE_FRAMEWORK_GOLDENS === '1';
const ALLOW_IN_CI = process.env.ALLOW_GOLDEN_UPDATE_IN_CI === '1';
if (UPDATE_REQUESTED && process.env.CI && !ALLOW_IN_CI) {
  throw new Error(
    'PF-617: UPDATE_FRAMEWORK_GOLDENS is set in a CI environment. ' +
    'Refusing to rewrite goldens — re-run locally or set ' +
    'ALLOW_GOLDEN_UPDATE_IN_CI=1 to override.',
  );
}
const UPDATE = UPDATE_REQUESTED;

function listFixtures(): string[] {
  if (!fs.existsSync(FIXTURES_DIR)) return [];
  return fs
    .readdirSync(FIXTURES_DIR)
    .filter((entry) => {
      const full = path.join(FIXTURES_DIR, entry);
      return fs.statSync(full).isDirectory();
    })
    .sort();
}

/**
 * Strip fields that aren't part of the resolver contract:
 *  - `Node.updatedAt` is a wall-clock timestamp set by extractors
 *    when they emit a node; comparing it across runs would flap.
 *
 * Scoped narrowly to `result.nodes` (not a recursive walk) so a
 * future reference payload that legitimately contains an `updatedAt`
 * field is still locked by the golden.
 */
function normalize(result: { nodes: unknown[]; references: unknown[] }): {
  nodes: unknown[];
  references: unknown[];
} {
  return {
    nodes: result.nodes.map((node) => {
      if (node && typeof node === 'object') {
        const { updatedAt: _updatedAt, ...rest } = node as Record<string, unknown>;
        return rest;
      }
      return node;
    }),
    references: result.references,
  };
}

function loadFixture(name: string): {
  meta: FixtureMeta;
  source: string;
  expectedPath: string;
  expectedExists: boolean;
  expected: unknown;
} {
  const dir = path.join(FIXTURES_DIR, name);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) as FixtureMeta;
  // Tight pattern: `source.<single-ext>` only. Rejects backup files
  // like `source.py.bak` and dotfiles like `source.` — both would
  // silently masquerade as canonical with a startsWith check.
  const sourceFiles = fs
    .readdirSync(dir)
    .filter((f) => /^source\.[^.]+$/.test(f));
  if (sourceFiles.length !== 1) {
    throw new Error(
      `Fixture "${name}" must contain exactly one source.* file, got ${sourceFiles.length}`,
    );
  }
  const source = fs.readFileSync(path.join(dir, sourceFiles[0]!), 'utf8');
  const expectedPath = path.join(dir, 'expected.json');
  const expectedExists = fs.existsSync(expectedPath);
  const expected = expectedExists
    ? JSON.parse(fs.readFileSync(expectedPath, 'utf8'))
    : null;
  return { meta, source, expectedPath, expectedExists, expected };
}

describe('Framework resolver contract harness (PF-617)', () => {
  const fixtures = listFixtures();
  if (fixtures.length === 0) {
    it.skip('no fixtures present yet', () => {
      // Placeholder so the test file is never empty during initial setup.
    });
    return;
  }

  for (const fixtureName of fixtures) {
    it(`fixture: ${fixtureName}`, () => {
      const fixture = loadFixture(fixtureName);
      const resolver = RESOLVERS[fixture.meta.resolver];
      expect(resolver, `unknown resolver "${fixture.meta.resolver}" in fixture ${fixtureName}`)
        .toBeDefined();
      expect(
        resolver.extract,
        `resolver "${fixture.meta.resolver}" has no extract() method`,
      ).toBeDefined();

      const result = normalize(resolver.extract!(fixture.meta.sourcePath, fixture.source));

      if (UPDATE) {
        fs.writeFileSync(fixture.expectedPath, JSON.stringify(result, null, 2) + '\n');
        if (!fixture.expectedExists) {
          // Newly captured — surface the path so reviewers see what was written.
          process.stderr.write(
            `[PF-617] Captured initial golden for ${fixtureName} at ${fixture.expectedPath}\n`,
          );
        }
        return;
      }

      expect(
        fixture.expectedExists,
        `Missing expected.json for fixture "${fixtureName}". Re-run with UPDATE_FRAMEWORK_GOLDENS=1 to capture.`,
      ).toBe(true);
      expect(result).toEqual(fixture.expected);
    });
  }
});
