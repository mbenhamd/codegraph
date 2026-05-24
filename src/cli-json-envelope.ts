/**
 * PF-613: shared envelope for every CLI `--json` output.
 *
 * Every `--json` payload is wrapped with `schemaVersion` + `tool` at
 * the top level so downstream consumers (scripts, CI, agents) can
 * branch on the version and verify they're talking to the tool they
 * expect.
 *
 * Lives outside `src/bin/codegraph.ts` so tests can import the real
 * helper without dragging in commander, the bundled WASM init, or
 * other CLI-level imports.
 */

export const CLI_JSON_SCHEMA_VERSION = 1 as const;

/**
 * Wrap a tool-specific JSON payload with the shared envelope. The
 * envelope's `schemaVersion` + `tool` ALWAYS win on conflict (spread
 * order puts payload first), so a tool whose payload happens to carry
 * a top-level `schemaVersion` (notably inventory) MUST be wrapped
 * under a key (e.g. `{ inventory }`) to keep its own version
 * accessible without clobbering the envelope.
 */
export function cliJsonEnvelope<T extends Record<string, unknown>>(
  tool: string,
  payload: T,
): { schemaVersion: typeof CLI_JSON_SCHEMA_VERSION; tool: string } & T {
  return { ...payload, schemaVersion: CLI_JSON_SCHEMA_VERSION, tool };
}
