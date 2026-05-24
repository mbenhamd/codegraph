/**
 * PF-610 follow-up: Python (integration) + Go (white-box) coverage
 * for the import-shadow gate.
 *
 * The original PF-610 PR shipped JS/TS coverage in
 * `false-positive-resolution.test.ts` (Request / Record / .toString
 * scenarios). The same `isBuiltInOrExternal` filter inside
 * `src/resolution/index.ts` gates Python (PYTHON_BUILT_INS,
 * PYTHON_BUILT_IN_METHODS, PYTHON_BUILT_IN_TYPES) and Go
 * (GO_STDLIB_PACKAGES, GO_BUILT_INS) but had NO test coverage —
 * a regression in PYTHON_BUILT_INS would silently misroute Python
 * `print()` / `len()` to project classes of the same name.
 *
 * Python is tested through the integration path (real
 * `CodeGraph.init` against a temp dir):
 *   1. Bare `len(items)` does NOT link to a project `class len`.
 *      Bug-pinned: disabling the gate at index.ts:954 fails this.
 *   2. Same-file `def print(...)` shadow still resolves to itself
 *      (the gate does not overblock legitimate local declarations).
 *
 * Go is tested via white-box predicate access — `(cg as any)
 * .resolver.isBuiltInOrExternal(ref)`. The resolver's name-match
 * strategy doesn't form `fmt.Println` -> project `fmt.Println`
 * cross-file links in synthetic minimal projects under current
 * rules (no go.mod / module path), so the GO_STDLIB_PACKAGES /
 * GO_BUILT_INS gates have no observable effect through the
 * integration path today. Calling the predicate directly pins the
 * gate's behavior anyway — a regression in either Set flips the
 * predicate's return. Precedent for white-box testing of private
 * resolver state is `__tests__/mcp-tool-handler-close.test.ts`
 * (PR #27).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

describe('false-positive resolution — Python (PF-610 follow-up)', () => {
  let tempDir: string;
  let cg: CodeGraph | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-pf610-py-'));
  });

  afterEach(() => {
    cg?.destroy();
    cg = undefined;
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function findNodeByNameAndFile(name: string, fileSuffix: string) {
    if (!cg) return undefined;
    return cg
      .searchNodes(name, { limit: 25 })
      .map((r) => r.node)
      .find((n) => n.name === name && n.filePath.endsWith(fileSuffix));
  }

  function incomingEdgeSourceFiles(targetNodeId: string): string[] {
    if (!cg) return [];
    const REF_EDGE_KINDS = new Set([
      'calls',
      'references',
      'instantiates',
      'extends',
      'implements',
      'decorates',
    ]);
    const files: string[] = [];
    for (const edge of cg.getIncomingEdges(targetNodeId)) {
      if (!REF_EDGE_KINDS.has(edge.kind)) continue;
      const node = cg.getNode(edge.source);
      if (node) files.push(node.filePath);
    }
    return files;
  }

  it('bare `len(items)` does NOT link to a project class named `len` (PYTHON_BUILT_INS gate)', async () => {
    // Bug-pin verified: with the PYTHON_BUILT_INS gate disabled at
    // src/resolution/index.ts:954, this assertion fails — proving
    // the test catches a regression where the gate is bypassed.
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'src', 'project_len.py'),
      'class len:\n    def __init__(self, x):\n        self.x = x\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(tempDir, 'src', 'caller.py'),
      // No import — this is the built-in `len`.
      'def count(items):\n    return len(items)\n',
      'utf8',
    );

    cg = await CodeGraph.init(tempDir, { index: true });
    const projectLen = findNodeByNameAndFile('len', 'project_len.py');
    expect(projectLen).toBeDefined();
    const files = incomingEdgeSourceFiles(projectLen!.id);
    expect(files.some((f) => f.endsWith('caller.py'))).toBe(false);
  });

  it('same-file `def print(...)` shadow still resolves to the local declaration (no overblock)', async () => {
    // This is a contract observation, not a strict gate-pin: the
    // built-in filter must not be so aggressive that it suppresses
    // a same-file declaration that locally rebinds `print`. The
    // resolver's same-file matcher handles the actual binding —
    // this test asserts the gate doesn't interfere.
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'src', 'local_shadow.py'),
      'def print(msg):\n    return msg.upper()\n\n' +
        'def caller():\n    return print("hi")\n',
      'utf8',
    );

    cg = await CodeGraph.init(tempDir, { index: true });
    const localPrint = findNodeByNameAndFile('print', 'local_shadow.py');
    expect(localPrint).toBeDefined();
    const files = incomingEdgeSourceFiles(localPrint!.id);
    expect(files.some((f) => f.endsWith('local_shadow.py'))).toBe(true);
  });
});

/**
 * White-box predicate tests for the Go gates. `isBuiltInOrExternal`
 * is private on `ReferenceResolver`, so we reach in via the same
 * `as any` pattern PR #27 used for ToolHandler.closeAll. The
 * integration path doesn't form the candidate edges Go would need
 * for the gate to fire, so a direct predicate call is the only
 * place a regression in GO_STDLIB_PACKAGES / GO_BUILT_INS becomes
 * observable. See file header for the full rationale.
 */
describe('false-positive resolution — Go gate predicate (PF-610 follow-up)', () => {
  let tempDir: string;
  let cg: CodeGraph | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-pf610-go-'));
  });

  afterEach(() => {
    cg?.destroy();
    cg = undefined;
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  type GateInput = {
    referenceName: string;
    referenceKind: string;
    fromNodeId: string;
    line: number;
    column: number;
    filePath: string;
    language: string;
  };

  function goRef(name: string): GateInput {
    return {
      referenceName: name,
      referenceKind: 'calls',
      fromNodeId: 'caller',
      line: 1,
      column: 0,
      filePath: 'main.go',
      language: 'go',
    };
  }

  /**
   * Call the private predicate on the resolver held by a real
   * `CodeGraph` instance. Mirrors the white-box access in
   * `mcp-tool-handler-close.test.ts`.
   */
  async function gate(name: string): Promise<boolean> {
    if (!cg) {
      cg = await CodeGraph.init(tempDir, { index: false });
    }
    const internals = cg as unknown as {
      resolver: { isBuiltInOrExternal: (ref: GateInput) => boolean };
    };
    return internals.resolver.isBuiltInOrExternal(goRef(name));
  }

  it('filters `fmt.Println` via GO_STDLIB_PACKAGES (pins the stdlib gate at index.ts:988)', async () => {
    expect(await gate('fmt.Println')).toBe(true);
  });

  it('filters `http.ListenAndServe` and `os.Exit` via GO_STDLIB_PACKAGES', async () => {
    expect(await gate('http.ListenAndServe')).toBe(true);
    expect(await gate('os.Exit')).toBe(true);
  });

  it('filters bare Go built-ins via GO_BUILT_INS (pins the built-ins gate at index.ts:992)', async () => {
    // `make`, `new`, `len`, `cap`, `append` are spec-defined Go
    // built-ins, not stdlib package members. They must filter
    // independently of GO_STDLIB_PACKAGES.
    expect(await gate('make')).toBe(true);
    expect(await gate('new')).toBe(true);
    expect(await gate('len')).toBe(true);
    expect(await gate('cap')).toBe(true);
    expect(await gate('append')).toBe(true);
  });

  it('does NOT filter unrelated project-package refs', async () => {
    // Project-owned package whose name doesn't collide with any
    // stdlib package or built-in. The gate must pass through so
    // the resolver's normal strategies can attempt to link it.
    expect(await gate('myutil.Helper')).toBe(false);
    expect(await gate('internalpkg.DoThing')).toBe(false);
    expect(await gate('Helper')).toBe(false);
  });
});
