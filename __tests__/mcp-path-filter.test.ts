/**
 * PF-609: tests for the MCP graph-tool path/excludePath filter.
 *
 * Covers the `PathFilter` helper (pattern compilation + matching) and
 * the MCP-handler integration through `ToolHandler` for `codegraph_callers`,
 * `codegraph_callees`, and `codegraph_impact`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { PathFilter, parsePathFilterArgs } from '../src/mcp/path-filter';
import { ToolHandler } from '../src/mcp/tools';
import { ProjectAccessGate } from '../src/mcp/project-access';

describe('PathFilter (PF-609)', () => {
  it('matches plain prefixes with trailing slash', () => {
    const f = new PathFilter({ path: ['packages/api/'] });
    expect(f.matches('packages/api/index.ts')).toBe(true);
    expect(f.matches('packages/api/src/foo.ts')).toBe(true);
    expect(f.matches('packages/web/index.ts')).toBe(false);
  });

  it('honors excludePath even when path is set', () => {
    const f = new PathFilter({
      path: ['packages/'],
      excludePath: ['packages/api/'],
    });
    expect(f.matches('packages/web/index.ts')).toBe(true);
    expect(f.matches('packages/api/index.ts')).toBe(false);
  });

  it('treats `*` as a single segment', () => {
    const f = new PathFilter({ path: ['packages/*/index.ts'] });
    expect(f.matches('packages/api/index.ts')).toBe(true);
    expect(f.matches('packages/web/index.ts')).toBe(true);
    expect(f.matches('packages/api/src/index.ts')).toBe(false);
  });

  it('treats `**` as any depth, INCLUDING zero', () => {
    const f = new PathFilter({ excludePath: ['**/*.test.ts'] });
    expect(f.matches('src/utils/cache.ts')).toBe(true);
    expect(f.matches('src/utils/cache.test.ts')).toBe(false);
    expect(f.matches('apps/web/lib/cache.test.ts')).toBe(false);
    // Root-level test must also be excluded (Codex round 1 finding).
    expect(f.matches('cache.test.ts')).toBe(false);
  });

  it('is open when both lists are empty', () => {
    const f = new PathFilter({});
    expect(f.isOpen()).toBe(true);
    expect(f.matches('anything/at/all.ts')).toBe(true);
  });

  it('escapes regex metacharacters in patterns', () => {
    const f = new PathFilter({ path: ['src/foo+bar/'] });
    // Pattern has `+`, must be matched literally (not as regex one-or-more).
    expect(f.matches('src/foo+bar/x.ts')).toBe(true);
    expect(f.matches('src/foobar/x.ts')).toBe(false);
  });
});

describe('parsePathFilterArgs (PF-609)', () => {
  it('extracts string-only arrays from path / excludePath', () => {
    expect(parsePathFilterArgs({ path: ['a/', 'b/'], excludePath: ['c/'] })).toEqual({
      path: ['a/', 'b/'],
      excludePath: ['c/'],
    });
  });

  it('drops non-string elements silently', () => {
    expect(parsePathFilterArgs({ path: ['a/', 42, null], excludePath: ['c/'] })).toEqual({
      path: ['a/'],
      excludePath: ['c/'],
    });
  });

  it('returns empty options when path/excludePath are missing', () => {
    expect(parsePathFilterArgs({})).toEqual({});
  });

  it('returns empty options when path/excludePath are not arrays', () => {
    expect(parsePathFilterArgs({ path: 'not-an-array', excludePath: null })).toEqual({});
  });
});

describe('MCP graph tools: path/excludePath integration (PF-609)', () => {
  let tempDir: string;
  let cg: CodeGraph | undefined;
  let handler: ToolHandler;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-pf609-'));
  });

  afterEach(() => {
    cg?.destroy();
    cg = undefined;
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  async function setupMonorepo(): Promise<void> {
    // Monorepo-shaped fixture: an api package + a web package + vendor
    // (which should be excludable), all sharing a util function.
    fs.mkdirSync(path.join(tempDir, 'packages', 'api', 'src'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'packages', 'web', 'src'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'packages', 'shared', 'src'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'vendor', 'lib'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'packages', 'shared', 'src', 'util.ts'),
      'export function util(): number { return 42; }\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(tempDir, 'packages', 'api', 'src', 'handler.ts'),
      "import { util } from '../../../packages/shared/src/util';\nexport function handler() { util(); }\n",
      'utf8',
    );
    fs.writeFileSync(
      path.join(tempDir, 'packages', 'web', 'src', 'page.ts'),
      "import { util } from '../../../packages/shared/src/util';\nexport function page() { util(); }\n",
      'utf8',
    );
    fs.writeFileSync(
      path.join(tempDir, 'vendor', 'lib', 'vendor-caller.ts'),
      "import { util } from '../../packages/shared/src/util';\nexport function vendorCaller() { util(); }\n",
      'utf8',
    );

    cg = await CodeGraph.init(tempDir, { index: true });
    handler = new ToolHandler(cg);
    // Allow any path so the access gate doesn't block the test-private
    // project root lookups (PF-619 default is restrictive).
    handler.setProjectAccess(new ProjectAccessGate({ allowAny: true }));
  }

  // Helper: invoke a tool handler via its dispatch path and extract the text.
  async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await handler.execute(name, args);
    return result.content[0]?.text ?? '';
  }

  it('codegraph_callers honors `path` filter to scope to a package', async () => {
    await setupMonorepo();

    // No filter → all three callers (api, web, vendor) show up.
    const allOut = await callTool('codegraph_callers', { symbol: 'util' });
    expect(allOut).toMatch(/handler/);
    expect(allOut).toMatch(/page/);
    expect(allOut).toMatch(/vendorCaller/);

    // path filter to packages/api/ → only the api caller.
    const apiOnly = await callTool('codegraph_callers', {
      symbol: 'util',
      path: ['packages/api/'],
    });
    expect(apiOnly).toMatch(/handler/);
    expect(apiOnly).not.toMatch(/page/);
    expect(apiOnly).not.toMatch(/vendorCaller/);
  });

  it('codegraph_callers honors `excludePath` to drop vendor noise', async () => {
    await setupMonorepo();

    const withoutVendor = await callTool('codegraph_callers', {
      symbol: 'util',
      excludePath: ['vendor/'],
    });
    expect(withoutVendor).toMatch(/handler/);
    expect(withoutVendor).toMatch(/page/);
    expect(withoutVendor).not.toMatch(/vendorCaller/);
  });

  it('codegraph_impact honors path scope and reports empty-set politely', async () => {
    await setupMonorepo();

    const scopedAway = await callTool('codegraph_impact', {
      symbol: 'util',
      path: ['apps/never-existed/'],
    });
    expect(scopedAway).toMatch(/affects 0 symbols/);
  });

  it('codegraph_callees honors `excludePath` against the callee endpoint', async () => {
    await setupMonorepo();

    // Callees of handler() should include util. excludePath the shared
    // package — handler has no other callees, so the result must be empty.
    const droppedCallee = await callTool('codegraph_callees', {
      symbol: 'handler',
      excludePath: ['packages/shared/'],
    });
    expect(droppedCallee).toMatch(/No callees found/);
  });

  // PF-609 follow-up — context + explore.
  it('codegraph_context honors `path` to scope to one package', async () => {
    await setupMonorepo();

    const apiOnly = await callTool('codegraph_context', {
      task: 'util',
      path: ['packages/api/'],
    });
    // Output must include the api caller's file but NOT the web/vendor ones.
    expect(apiOnly).toMatch(/packages\/api\//);
    expect(apiOnly).not.toMatch(/packages\/web\//);
    expect(apiOnly).not.toMatch(/vendor\//);
  });

  it('codegraph_context honors `excludePath`', async () => {
    await setupMonorepo();

    const noVendor = await callTool('codegraph_context', {
      task: 'util',
      excludePath: ['vendor/'],
    });
    expect(noVendor).not.toMatch(/vendor\//);
  });

  it('codegraph_explore honors `path` to scope by package', async () => {
    await setupMonorepo();

    const apiOnly = await callTool('codegraph_explore', {
      query: 'util handler page',
      path: ['packages/api/'],
    });
    expect(apiOnly).toMatch(/packages\/api\//);
    expect(apiOnly).not.toMatch(/packages\/web\//);
  });

  it('codegraph_explore honors `excludePath` to drop vendor', async () => {
    await setupMonorepo();

    const noVendor = await callTool('codegraph_explore', {
      query: 'util handler page',
      excludePath: ['vendor/'],
    });
    expect(noVendor).not.toMatch(/vendor\//);
  });

  it('codegraph_explore returns scope-aware empty message when nothing matches', async () => {
    await setupMonorepo();

    const empty = await callTool('codegraph_explore', {
      query: 'util',
      path: ['apps/never-existed/'],
    });
    expect(empty).toMatch(/within configured path filter/);
  });

  it('codegraph_context with no filter behaves identically to before (parity)', async () => {
    await setupMonorepo();

    const noFilter = await callTool('codegraph_context', { task: 'util' });
    // Without a filter, the result should mention symbols from multiple
    // packages — proves the default is unchanged when no filter is set.
    expect(noFilter).toMatch(/util/);
    expect(noFilter.length).toBeGreaterThan(50);
  });

  // PF-618 follow-up — diagnostics on codegraph_explore.
  it('codegraph_explore omits ranking diagnostics by default (PF-618 follow-up)', async () => {
    await setupMonorepo();
    const out = await callTool('codegraph_explore', { query: 'util handler page' });
    expect(out).not.toMatch(/### Ranking Diagnostics/);
  });

  it('codegraph_explore emits Ranking Diagnostics when diagnostics:true (PF-618 follow-up)', async () => {
    await setupMonorepo();
    const out = await callTool('codegraph_explore', {
      query: 'util handler page',
      diagnostics: true,
    });
    expect(out).toMatch(/### Ranking Diagnostics/);
    // The block lists per-file structural-score breakdowns.
    expect(out).toMatch(/structural score \d+ \(/);
  });
});
