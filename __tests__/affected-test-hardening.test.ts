/**
 * PF-611: harden affected-test selection across imports/barrels/aliases/
 * `.js` specifiers.
 *
 * Builds a synthetic project that exercises each pattern the `codegraph
 * affected` CLI subcommand traverses via `cg.getFileDependents`. Asserts
 * that editing the leaf implementation file pulls every test that depends
 * on it — directly, through a single barrel, through a multi-hop barrel
 * chain, through a tsconfig path alias, through a `.js` specifier that
 * resolves to a `.ts` source, and through an extensionless import to an
 * `index.ts`. Regression cases pin that similarly-named files and
 * shadowed imports do NOT inflate the affected set.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

describe('affected-test hardening (PF-611)', () => {
  let tempDir: string;
  let cg: CodeGraph | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-pf611-'));
  });

  afterEach(() => {
    cg?.destroy();
    cg = undefined;
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  /**
   * BFS that mirrors the `codegraph affected` CLI's logic — start from a
   * changed file, walk dependents transitively, return every test file
   * reached. By default uses `getAffectedFileDependents` (broader walk);
   * pass an explicit getDeps function to test the imports-only contract.
   */
  function affectedTestsOf(
    changed: string,
    options: { maxDepth?: number; getDeps?: (file: string) => string[] } = {},
  ): string[] {
    if (!cg) return [];
    const maxDepth = options.maxDepth ?? 5;
    const getDeps = options.getDeps ?? ((f: string) => cg!.getAffectedFileDependents(f));
    const testRe = /(?:\.|\/)(test|spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:__tests__|tests?)\//;
    const isTest = (p: string) => testRe.test(p);
    const found = new Set<string>();
    if (isTest(changed)) {
      found.add(changed);
      return [...found];
    }
    const queue: Array<{ file: string; depth: number }> = [{ file: changed, depth: 0 }];
    const visited = new Set<string>([changed]);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (cur.depth >= maxDepth) continue;
      for (const dep of getDeps(cur.file)) {
        if (visited.has(dep)) continue;
        visited.add(dep);
        if (isTest(dep)) {
          found.add(dep);
        } else {
          queue.push({ file: dep, depth: cur.depth + 1 });
        }
      }
    }
    return [...found].sort();
  }

  it('walks direct, barrel (single + multi-hop), alias, .js→.ts, and index imports', async () => {
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });

    // Tsconfig with a path alias `@/lib/*` → `src/lib/*`.
    fs.writeFileSync(
      path.join(tempDir, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            baseUrl: '.',
            paths: { '@/lib/*': ['src/lib/*'] },
            module: 'esnext',
            moduleResolution: 'bundler',
            target: 'esnext',
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    // -----------------------------------------------------------------------
    // PATTERN A: direct import. `direct.test.ts` imports `direct-impl.ts`.
    fs.writeFileSync(
      path.join(tempDir, 'src', 'direct-impl.ts'),
      'export function direct(): number { return 1; }\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(tempDir, 'src', 'direct.test.ts'),
      "import { direct } from './direct-impl';\nexport function run() { direct(); }\n",
      'utf8',
    );

    // -----------------------------------------------------------------------
    // PATTERN B: single barrel. `barrel.test.ts` imports through `./barrel`
    // which re-exports the leaf.
    fs.mkdirSync(path.join(tempDir, 'src', 'b'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'src', 'b', 'barrel-impl.ts'),
      'export function barrelImpl(): number { return 2; }\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(tempDir, 'src', 'b', 'index.ts'),
      "export { barrelImpl } from './barrel-impl';\n",
      'utf8',
    );
    fs.writeFileSync(
      path.join(tempDir, 'src', 'barrel.test.ts'),
      "import { barrelImpl } from './b';\nexport function run() { barrelImpl(); }\n",
      'utf8',
    );

    // -----------------------------------------------------------------------
    // PATTERN C: multi-hop barrel. test → barrel-outer → barrel-inner → leaf.
    fs.mkdirSync(path.join(tempDir, 'src', 'multi'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'src', 'multi', 'inner'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'src', 'multi', 'inner', 'leaf.ts'),
      'export function multiLeaf(): number { return 3; }\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(tempDir, 'src', 'multi', 'inner', 'index.ts'),
      "export * from './leaf';\n",
      'utf8',
    );
    fs.writeFileSync(
      path.join(tempDir, 'src', 'multi', 'index.ts'),
      "export * from './inner';\n",
      'utf8',
    );
    fs.writeFileSync(
      path.join(tempDir, 'src', 'multi.test.ts'),
      "import { multiLeaf } from './multi';\nexport function run() { multiLeaf(); }\n",
      'utf8',
    );

    // -----------------------------------------------------------------------
    // PATTERN D: tsconfig path alias.
    fs.mkdirSync(path.join(tempDir, 'src', 'lib'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'src', 'lib', 'alias-impl.ts'),
      'export function aliasImpl(): number { return 4; }\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(tempDir, 'src', 'alias.test.ts'),
      "import { aliasImpl } from '@/lib/alias-impl';\nexport function run() { aliasImpl(); }\n",
      'utf8',
    );

    // -----------------------------------------------------------------------
    // PATTERN E: `.js` specifier resolves to `.ts` source.
    fs.writeFileSync(
      path.join(tempDir, 'src', 'js-spec-impl.ts'),
      'export function jsSpec(): number { return 5; }\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(tempDir, 'src', 'js-spec.test.ts'),
      "import { jsSpec } from './js-spec-impl.js';\nexport function run() { jsSpec(); }\n",
      'utf8',
    );

    // -----------------------------------------------------------------------
    // REGRESSION F: similarly-named leaf files in different dirs. Editing
    // `helpers/used.ts` must mark only `helpers-used.test.ts`, not
    // `helpers-unused.test.ts` (which imports a different `helpers/unused.ts`).
    fs.mkdirSync(path.join(tempDir, 'src', 'helpers'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'src', 'helpers', 'used.ts'),
      'export function usedHelper(): number { return 6; }\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(tempDir, 'src', 'helpers', 'unused.ts'),
      'export function unusedHelper(): number { return 7; }\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(tempDir, 'src', 'helpers-used.test.ts'),
      "import { usedHelper } from './helpers/used';\nexport function run() { usedHelper(); }\n",
      'utf8',
    );
    fs.writeFileSync(
      path.join(tempDir, 'src', 'helpers-unused.test.ts'),
      "import { unusedHelper } from './helpers/unused';\nexport function run() { unusedHelper(); }\n",
      'utf8',
    );

    cg = await CodeGraph.init(tempDir, { index: true });

    // PATTERN A
    expect(affectedTestsOf('src/direct-impl.ts')).toContain('src/direct.test.ts');

    // PATTERN B (single barrel)
    expect(affectedTestsOf('src/b/barrel-impl.ts')).toContain('src/barrel.test.ts');

    // PATTERN C (multi-hop barrel)
    expect(affectedTestsOf('src/multi/inner/leaf.ts')).toContain('src/multi.test.ts');

    // PATTERN D (tsconfig path alias)
    expect(affectedTestsOf('src/lib/alias-impl.ts')).toContain('src/alias.test.ts');

    // PATTERN E (.js specifier → .ts source)
    expect(affectedTestsOf('src/js-spec-impl.ts')).toContain('src/js-spec.test.ts');

    // REGRESSION F: editing helpers/used.ts must affect only the used test.
    const usedAffected = affectedTestsOf('src/helpers/used.ts');
    expect(usedAffected).toContain('src/helpers-used.test.ts');
    expect(usedAffected).not.toContain('src/helpers-unused.test.ts');

    // REGRESSION F (other side): editing helpers/unused.ts must NOT affect the used test.
    const unusedAffected = affectedTestsOf('src/helpers/unused.ts');
    expect(unusedAffected).toContain('src/helpers-unused.test.ts');
    expect(unusedAffected).not.toContain('src/helpers-used.test.ts');

    // PF-611b — IMPORT-ONLY contract is now guaranteed transitively.
    // The dedicated `resolveImportStatement` resolver step emits
    // cross-file file→file `imports` edges for every pattern above,
    // so a transitive walk that ONLY follows `imports` edges reaches
    // every test the broader walk reaches. If the resolver regresses
    // these mappings, the assertions below fail loudly — that's the
    // point of pinning the contract here.
    const importsOnlyDeps = (file: string) =>
      cg!.getFileDependents(file, { edgeKinds: ['imports'] });
    const importsOnlyTests = (file: string) =>
      affectedTestsOf(file, { getDeps: importsOnlyDeps });
    expect(importsOnlyTests('src/direct-impl.ts')).toContain('src/direct.test.ts');
    expect(importsOnlyTests('src/b/barrel-impl.ts')).toContain('src/barrel.test.ts');
    expect(importsOnlyTests('src/multi/inner/leaf.ts')).toContain('src/multi.test.ts');
    expect(importsOnlyTests('src/lib/alias-impl.ts')).toContain('src/alias.test.ts');
    expect(importsOnlyTests('src/js-spec-impl.ts')).toContain('src/js-spec.test.ts');

    // Regression set must still hold under imports-only: similarly-named
    // helpers don't cross-contaminate when only `imports` edges are walked.
    expect(importsOnlyTests('src/helpers/used.ts')).not.toContain('src/helpers-unused.test.ts');
    expect(importsOnlyTests('src/helpers/unused.ts')).not.toContain('src/helpers-used.test.ts');
  });
});
