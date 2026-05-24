/**
 * PF-609: project-relative path filter — reusable utility shared
 * between MCP graph tools, the context builder, and the CLI. Lives at
 * the top of `src/` so cross-layer consumers (resolution / context /
 * MCP) can import without creating an inverted dependency on
 * `src/mcp/`.
 *
 * Pattern semantics (glob-ish, intentionally narrow to avoid prompt
 * confusion):
 *
 *   - `*`  matches any sequence of characters EXCEPT `/` (a single path segment).
 *   - `**` matches any sequence of characters INCLUDING `/` (any depth).
 *   - `**\/` matches any depth INCLUDING zero so `**\/*.test.ts` also matches
 *     root-level `foo.test.ts`.
 *   - A trailing `/` makes the pattern a prefix match for that directory.
 *   - Any other character is matched literally (case-sensitive).
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
      const ch = pattern[i]!;
      regex += /[.*+?^${}()|[\]\\]/.test(ch) ? '\\' + ch : ch;
      i += 1;
    }
  }
  if (pattern.endsWith('/')) {
    regex += '.*';
  }
  return new RegExp('^' + regex + '$');
}
