/**
 * PF-613 helper-level contract test.
 *
 * The end-to-end suite in `cli-json-envelope.test.ts` exercises the
 * shipped dist binary and skips when `dist/bin/codegraph.js` is
 * absent. This file imports the REAL `cliJsonEnvelope` from
 * `src/cli-json-envelope.ts` and runs unconditionally — if the
 * shipped helper regresses (envelope-first spread, missing tool
 * field, etc.) the test fails in CI regardless of build state
 * (Codex round-2 review note 2026-05-24).
 */

import { describe, expect, it } from 'vitest';
import { cliJsonEnvelope, CLI_JSON_SCHEMA_VERSION } from '../src/cli-json-envelope';

describe('PF-613 envelope helper (source-level contract)', () => {
  it('exports schemaVersion 1', () => {
    expect(CLI_JSON_SCHEMA_VERSION).toBe(1);
  });

  it('wraps a payload with schemaVersion + tool', () => {
    const out = cliJsonEnvelope('callers', { symbol: 'foo', callers: [] });
    expect(out.schemaVersion).toBe(1);
    expect(out.tool).toBe('callers');
    expect(out.symbol).toBe('foo');
    expect(out.callers).toEqual([]);
  });

  it('envelope wins if the payload tries to set schemaVersion or tool', () => {
    // Cast to bypass TS overlap protection — the contract is at runtime.
    const naughty = { schemaVersion: 99 as const, tool: 'wrong', data: 1 } as Record<string, unknown>;
    const out = cliJsonEnvelope('impact', naughty);
    expect(out.schemaVersion).toBe(1);
    expect(out.tool).toBe('impact');
    // Other payload keys still pass through.
    expect(out.data).toBe(1);
  });

  it('preserves nested object payloads (e.g. inventory)', () => {
    const inv = { schemaVersion: 1 as const, packages: ['a', 'b'] };
    // The CLI wraps under a key (`{ inventory: inv }`) to keep the
    // inventory's own schemaVersion accessible without clobbering
    // the envelope.
    const out = cliJsonEnvelope('inventory', { inventory: inv });
    expect(out.schemaVersion).toBe(1);
    expect(out.tool).toBe('inventory');
    expect(out.inventory).toEqual(inv);
  });
});
