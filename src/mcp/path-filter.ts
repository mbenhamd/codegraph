/**
 * PF-609: MCP-specific glue around the shared `PathFilter` utility.
 *
 * `PathFilter` itself lives at `src/path-filter.ts` so cross-layer
 * consumers (context builder, resolution, CLI) can import it without
 * inverting the dependency direction (a context module shouldn't
 * import from `src/mcp/`). This file owns the MCP argument parsing
 * only.
 */

export { PathFilter } from '../path-filter';
export type { PathFilterOptions } from '../path-filter';
import type { PathFilterOptions } from '../path-filter';

/**
 * Parse the `path` / `excludePath` MCP tool arguments. Both are optional
 * `string[]`. Returns an empty object when the arg is missing or has a
 * non-array shape — the gate is permissive on shape to keep agents from
 * tripping on subtle MCP variance.
 */
export function parsePathFilterArgs(args: Record<string, unknown>): PathFilterOptions {
  const path = Array.isArray(args.path)
    ? (args.path as unknown[]).filter((v): v is string => typeof v === 'string')
    : undefined;
  const excludePath = Array.isArray(args.excludePath)
    ? (args.excludePath as unknown[]).filter((v): v is string => typeof v === 'string')
    : undefined;
  return {
    ...(path && path.length > 0 ? { path } : {}),
    ...(excludePath && excludePath.length > 0 ? { excludePath } : {}),
  };
}
