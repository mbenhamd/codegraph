/**
 * PF-690 fingerprint unit tests. Locks the structural contract the
 * downstream duplicate / drift / explain CLIs will rely on:
 *
 *   - Determinism: same input -> same hash, byte-for-byte, every run.
 *   - Whitespace/comment insensitivity: cosmetic edits must NOT
 *     change either hash.
 *   - Type-1 detection: two identical functions -> same `astHash`.
 *   - Type-2 detection: identical except for local-identifier names
 *     -> same `astShapeHash` but different `astHash`.
 *   - Member/type identifier preservation: rename a method call
 *     receiver and `astShapeHash` MUST diverge (semantic difference
 *     must not be hidden by local-rename normalization).
 *   - sigHash determinism + null handling on absent signature.
 *
 * Tests parse real TypeScript snippets via the shipped tree-sitter
 * extractor so we exercise the SAME code path that runs at index
 * time, not a synthetic AST stub.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { computeSigHash } from '../src/extraction/fingerprints';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

/**
 * Extract `source` via the production `extractFromSource` pipeline
 * and return the first node matching `symbolName`. Uses the same
 * entry point the file watcher + initial index use, so these tests
 * exercise the real createNode -> fingerprint path, not an isolated
 * helper.
 */
function extractFirstNode(filePath: string, source: string, symbolName: string) {
  const result = extractFromSource(filePath, source);
  const node = result.nodes.find((n) => n.name === symbolName);
  expect(node, `extractor did not find symbol "${symbolName}"`).toBeDefined();
  return node!;
}

describe('PF-690: fingerprint determinism', () => {
  it('computeSigHash returns the same hex for the same signature', () => {
    const sig = '(x: number, y: number): number';
    expect(computeSigHash(sig)).toBe(computeSigHash(sig));
    expect(computeSigHash(sig)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('computeSigHash returns null for undefined / missing signature', () => {
    expect(computeSigHash(undefined)).toBeNull();
    expect(computeSigHash('')).toBeNull();
  });

  it('different signatures produce different sigHash', () => {
    expect(computeSigHash('(x: number)')).not.toBe(computeSigHash('(x: string)'));
  });
});

describe('PF-690: fingerprints via extractor (real tree-sitter)', () => {
  it('emits non-null ast_hash + ast_shape_hash + sig_hash for a normal function', () => {
    const src = 'export function add(a: number, b: number): number {\n  return a + b;\n}\n';
    const result = extractFromSource('add.ts', src);
    const add = result.nodes.find((n) => n.name === 'add');
    expect(add).toBeDefined();
    expect(add!.astHash).toMatch(/^[0-9a-f]{64}$/);
    expect(add!.astShapeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(add!.sigHash).toMatch(/^[0-9a-f]{64}$/);
    // callPatternHash is populated post-resolution, not at extract
    // time. Extract-only output must leave it null so the
    // resolution pass owns that slot exclusively.
    expect(add!.callPatternHash ?? null).toBeNull();
  });

  it('Type-1 clones (only whitespace/comments differ) have the same astHash', () => {
    const a = 'function f(x: number): number {\n  return x + 1;\n}\n';
    const b = 'function f(x: number): number {\n  // adds one\n  return x+1;\n}\n';
    const na = extractFirstNode('a.ts', a, 'f');
    const nb = extractFirstNode('b.ts', b, 'f');
    expect(na.astHash).toBeDefined();
    expect(nb.astHash).toBeDefined();
    expect(na.astHash).toBe(nb.astHash);
  });

  it('Type-2 clones (only local-identifier names differ) share astShapeHash but NOT astHash', () => {
    const a = 'function f(x: number): number {\n  const r = x + 1;\n  return r;\n}\n';
    const b = 'function f(y: number): number {\n  const result = y + 1;\n  return result;\n}\n';
    const na = extractFirstNode('a.ts', a, 'f');
    const nb = extractFirstNode('b.ts', b, 'f');
    expect(na.astHash).not.toBe(nb.astHash);
    expect(na.astShapeHash).toBe(nb.astShapeHash);
  });

  it('member-name renames DO change astShapeHash (semantic difference must not be normalized away)', () => {
    // Same shape, different member call. astShapeHash MUST diverge —
    // `.start()` and `.stop()` mean different things and the
    // duplicate detector must not conflate them.
    const a = 'function f(obj: any): void {\n  obj.start();\n}\n';
    const b = 'function f(obj: any): void {\n  obj.stop();\n}\n';
    const na = extractFirstNode('a.ts', a, 'f');
    const nb = extractFirstNode('b.ts', b, 'f');
    expect(na.astHash).not.toBe(nb.astHash);
    expect(na.astShapeHash).not.toBe(nb.astShapeHash);
  });

  it('literal-value changes DO change both hashes (security/config sensitivity)', () => {
    // Council explicitly accepted "missing literal-only clones" as
    // the strongest counterpoint for v1, because security/config
    // code where the literal matters must NOT be conflated. This
    // test pins that decision.
    const a = 'function f(): number {\n  const buf = 1024;\n  return buf;\n}\n';
    const b = 'function f(): number {\n  const buf = 2048;\n  return buf;\n}\n';
    const na = extractFirstNode('a.ts', a, 'f');
    const nb = extractFirstNode('b.ts', b, 'f');
    expect(na.astHash).not.toBe(nb.astHash);
    expect(na.astShapeHash).not.toBe(nb.astShapeHash);
  });

  it('control-flow reorder DOES change both hashes (Type-3 NOT detected in v1)', () => {
    // v1 commits to NOT detecting Type-3 reordering. This test pins
    // that choice. If we ever flip to Type-3 detection, this test
    // updates and downstream consumers know the contract changed.
    const a = 'function f(x: number): number {\n  if (x > 0) return 1;\n  return 0;\n}\n';
    const b = 'function f(x: number): number {\n  if (x <= 0) return 0;\n  return 1;\n}\n';
    const na = extractFirstNode('a.ts', a, 'f');
    const nb = extractFirstNode('b.ts', b, 'f');
    expect(na.astHash).not.toBe(nb.astHash);
    expect(na.astShapeHash).not.toBe(nb.astShapeHash);
  });
});

describe('PF-690: Python regression for member/callee name preservation', () => {
  // Codex pass 1 BLOCKER: tree-sitter-python emits
  //   `attribute(identifier "obj", identifier "start")`
  // so a type-only `identifier -> _ID` rule would conflate
  // `obj.start()` with `obj.stop()`. The fix is the parent-context
  // check in `shouldPreserveIdentifier`. These tests pin both
  // member access AND bare-callee semantics in Python.

  it('Python `obj.start()` vs `obj.stop()` produce DIFFERENT astShapeHash (member name preserved)', () => {
    const a = 'def f(obj):\n    obj.start()\n';
    const b = 'def f(obj):\n    obj.stop()\n';
    const na = extractFirstNode('a.py', a, 'f');
    const nb = extractFirstNode('b.py', b, 'f');
    expect(na.astHash).not.toBe(nb.astHash);
    expect(na.astShapeHash).not.toBe(nb.astShapeHash);
  });

  it('Python bare callee `start()` vs `stop()` produce DIFFERENT astShapeHash (callee preserved)', () => {
    const a = 'def f():\n    start()\n';
    const b = 'def f():\n    stop()\n';
    const na = extractFirstNode('a.py', a, 'f');
    const nb = extractFirstNode('b.py', b, 'f');
    expect(na.astHash).not.toBe(nb.astHash);
    expect(na.astShapeHash).not.toBe(nb.astShapeHash);
  });

  it('Python keyword-argument names are preserved: `g(start=1)` vs `g(stop=1)` differ', () => {
    // Codex round 2: tree-sitter-python parses `g(start=1)` as
    //   call(function: identifier "g",
    //        arguments: argument_list(
    //          keyword_argument(name: identifier "start", value: integer "1")))
    // The kwarg `name` IS semantic — it's the parameter the value
    // binds to. v1 covers this by adding `keyword_argument` to
    // SEMANTIC_PARENT_TYPES so all its identifier children stay
    // unrenamed.
    const a = 'def f():\n    g(start=1)\n';
    const b = 'def f():\n    g(stop=1)\n';
    const na = extractFirstNode('a.py', a, 'f');
    const nb = extractFirstNode('b.py', b, 'f');
    expect(na.astHash).not.toBe(nb.astHash);
    expect(na.astShapeHash).not.toBe(nb.astShapeHash);
  });

  it('Python param-rename clones share astShapeHash (Type-2 detection still works for locals)', () => {
    // The fix preserves semantic-name positions but must NOT regress
    // the core Type-2 case: renaming a parameter must still produce
    // matching astShapeHash because the parameter IS a local binding,
    // not a semantic name.
    const a = 'def f(x):\n    return x + 1\n';
    const b = 'def f(y):\n    return y + 1\n';
    const na = extractFirstNode('a.py', a, 'f');
    const nb = extractFirstNode('b.py', b, 'f');
    expect(na.astHash).not.toBe(nb.astHash);
    expect(na.astShapeHash).toBe(nb.astShapeHash);
  });
});

describe('PF-690: cross-language hash isolation', () => {
  // Equivalent function bodies in different languages MUST NOT
  // collide on either hash. The grammar's node-type vocabulary is
  // included in the token stream, so this is structural — but the
  // test pins it so a future refactor that strips language tags
  // can't accidentally merge cross-language results into one
  // duplicate cluster.
  it('TS `function f(x) { return x + 1; }` and Python `def f(x): return x + 1` produce DIFFERENT hashes', () => {
    const ts = 'function f(x: number): number {\n  return x + 1;\n}\n';
    const py = 'def f(x):\n    return x + 1\n';
    const na = extractFirstNode('a.ts', ts, 'f');
    const nb = extractFirstNode('b.py', py, 'f');
    expect(na.astHash).not.toBe(nb.astHash);
    expect(na.astShapeHash).not.toBe(nb.astShapeHash);
  });
});
