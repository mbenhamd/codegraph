/**
 * Node.js version compatibility check.
 *
 * Node 25.x has a V8 turboshaft WASM JIT Zone allocator bug that
 * reliably crashes CodeGraph with `Fatal process out of memory: Zone`
 * during tree-sitter grammar compilation. This module owns the
 * user-facing banner shown before exit. Kept side-effect-free so it's
 * safe to import from tests without triggering CLI bootstrap.
 */

/**
 * Build the bordered banner shown when CodeGraph detects an
 * unsupported Node.js major version (currently 25+). Pinned via unit
 * test so the recovery commands and override instructions can't be
 * silently stripped by future edits.
 *
 * Uses ASCII glyphs to stay readable on Windows OEM-codepage consoles
 * (see ../ui/glyphs.ts for the rationale).
 */
export function buildNode25BlockBanner(nodeVersion: string): string {
  const sep = '-'.repeat(72);
  return [
    sep,
    `[CodeGraph] Unsupported Node.js version: ${nodeVersion}`,
    sep,
    'Node.js 25.x has a V8 WASM JIT (turboshaft) Zone allocator bug that',
    'crashes with `Fatal process out of memory: Zone` when CodeGraph',
    'compiles tree-sitter grammars. CodeGraph WILL crash on this Node',
    'version mid-indexing. See https://github.com/colbymchenry/codegraph/issues/81',
    '',
    'Fix: install a supported Node.js LTS (24 recommended, 22 also supported):',
    '  nvm install 24 && nvm use 24                          # explicit nvm',
    '  brew install node@24 && brew link --overwrite --force node@24  # Homebrew',
    '',
    'To override (NOT recommended - you will likely OOM):',
    '  CODEGRAPH_ALLOW_UNSAFE_NODE=1 codegraph ...',
    sep,
  ].join('\n');
}

/**
 * Lowest supported Node.js version. Matches the `engines` floor in package.json.
 * Below this, CodeGraph or its runtime dependencies rely on language features /
 * native APIs that aren't present, and the combination is untested. `engines`
 * alone only *warns* on install (unless the user set `engine-strict`), so the CLI
 * bootstrap also hard-blocks here to actually enforce the floor.
 */
export const MIN_NODE_VERSION = '22.13.0';

export function isNodeVersionBelowMinimum(nodeVersion: string): boolean {
  const actual = nodeVersion.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const minimum = MIN_NODE_VERSION.split('.').map((part) => Number.parseInt(part, 10) || 0);

  for (let i = 0; i < minimum.length; i += 1) {
    const actualPart = actual[i] ?? 0;
    const minimumPart = minimum[i] ?? 0;
    if (actualPart < minimumPart) return true;
    if (actualPart > minimumPart) return false;
  }

  return false;
}

/**
 * Build the bordered banner shown when CodeGraph detects a Node.js version below
 * {@link MIN_NODE_VERSION}. Pinned via unit test so the recovery commands and the
 * override env var can't be silently stripped by future edits.
 *
 * Uses ASCII glyphs to stay readable on Windows OEM-codepage consoles
 * (see ../ui/glyphs.ts for the rationale).
 */
export function buildNodeTooOldBanner(nodeVersion: string): string {
  const sep = '-'.repeat(72);
  return [
    sep,
    `[CodeGraph] Unsupported Node.js version: ${nodeVersion}`,
    sep,
    `CodeGraph requires Node.js ${MIN_NODE_VERSION} or newer. Older versions lack`,
    'language features or dependency support CodeGraph depends on, and are not',
    'tested or supported.',
    '',
    'Fix: install a supported Node.js LTS (24 recommended, 22 also supported):',
    '  nvm install 24 && nvm use 24                          # explicit nvm',
    '  brew install node@24 && brew link --overwrite --force node@24  # Homebrew',
    '',
    'To override (NOT recommended - unsupported):',
    '  CODEGRAPH_ALLOW_UNSAFE_NODE=1 codegraph ...',
    sep,
  ].join('\n');
}
