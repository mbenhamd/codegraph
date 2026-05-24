/**
 * PF-609: project-relative path filter for MCP graph tools.
 *
 * Each MCP graph tool accepts optional `path` and `excludePath` arrays of
 * project-relative path prefixes or glob-ish patterns. Results whose file
 * path does not match `path` (when set) OR matches any `excludePath` are
 * dropped. Filtering happens AFTER graph expansion and BEFORE ranking /
 * output trimming, so traversal semantics are unaffected — only what the
 * agent sees is scoped down.
 *
 * Pattern semantics (glob-ish, intentionally narrow to avoid prompt
 * confusion):
 *
 *   - `*`  matches any sequence of characters EXCEPT `/` (a single path segment).
 *   - `**` matches any sequence of characters INCLUDING `/` (any depth).
 *   - A trailing `/` makes the pattern a prefix match for that directory.
 *   - Any other character is matched literally (case-sensitive).
 *
 * Examples:
 *   `packages/api/`         → packages/api/index.ts, packages/api/src/x.ts
 *   `apps/web/src/`         → apps/web/src/main.tsx
 *   `vendor/`               → vendor/lodash/index.js
 *   `**\/*.test.ts`        → src/utils.test.ts, apps/web/lib/cache.test.ts
 *   `**\/__tests__/**`     → src/__tests__/foo.ts
 */

export interface PathFilterOptions {
  /** Include only paths matching at least one of these patterns. */
  path?: ReadonlyArray<string>;
  /** Drop paths matching any of these patterns. */
  excludePath?: ReadonlyArray<string>;
}

export class PathFilter {
  private readonly includes: ReadonlyArray<RegExp>;
  private readonly excludes: ReadonlyArray<RegExp>;

  constructor(options: PathFilterOptions = {}) {
    this.includes = (options.path ?? []).map(compilePattern);
    this.excludes = (options.excludePath ?? []).map(compilePattern);
  }

  /** No filtering rules configured at all — every path passes. */
  isOpen(): boolean {
    return this.includes.length === 0 && this.excludes.length === 0;
  }

  /**
   * True if `filePath` (project-relative) passes the include + exclude
   * rules. When no includes are set, every path is included; excludes
   * still drop matches.
   */
  matches(filePath: string): boolean {
    if (this.excludes.some((re) => re.test(filePath))) return false;
    if (this.includes.length === 0) return true;
    return this.includes.some((re) => re.test(filePath));
  }
}

/**
 * Compile a glob-ish pattern into a regex. Trailing-slash patterns become
 * prefix matches; `*` and `**` get their usual glob semantics; other
 * regex metacharacters are escaped so users don't have to think about it.
 */
function compilePattern(pattern: string): RegExp {
  // Tokenize on `**/`, `**`, and `*` while escaping regex metachars
  // between them. `**/` is special-cased so it matches "any depth
  // INCLUDING zero" — `**/*.test.ts` therefore matches root-level
  // `foo.test.ts` as well as `nested/dir/foo.test.ts`, matching the
  // documented `**` semantics.
  let regex = '';
  let i = 0;
  while (i < pattern.length) {
    if (pattern.startsWith('**/', i)) {
      regex += '(?:.*/)?';
      i += 3;
    } else if (pattern.startsWith('**', i)) {
      regex += '.*';
      i += 2;
    } else if (pattern[i] === '*') {
      regex += '[^/]*';
      i += 1;
    } else {
      // Escape regex metacharacters; let / and `-` through as literals.
      const ch = pattern[i]!;
      regex += /[.*+?^${}()|[\]\\]/.test(ch) ? '\\' + ch : ch;
      i += 1;
    }
  }
  // Trailing-slash → match anything under that directory.
  if (pattern.endsWith('/')) {
    regex += '.*';
  }
  return new RegExp('^' + regex + '$');
}

/**
 * Parse the `path` / `excludePath` MCP tool arguments. Both are optional
 * `string[]`. Returns an empty array when the arg is missing or has a
 * non-array shape — the gate is permissive on shape to keep agents from
 * tripping on subtle MCP variance.
 */
export function parsePathFilterArgs(args: Record<string, unknown>): PathFilterOptions {
  const path = Array.isArray(args.path) ? (args.path as unknown[]).filter((v): v is string => typeof v === 'string') : undefined;
  const excludePath = Array.isArray(args.excludePath)
    ? (args.excludePath as unknown[]).filter((v): v is string => typeof v === 'string')
    : undefined;
  return {
    ...(path && path.length > 0 ? { path } : {}),
    ...(excludePath && excludePath.length > 0 ? { excludePath } : {}),
  };
}
