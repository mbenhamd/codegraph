/**
 * PF-690: Per-symbol fingerprints for duplicate detection + drift analysis.
 *
 * Council RFC outcome (Codex + agy consensus, with one push back from agy
 * that I underweighted the cost): the tree-sitter AST is already in
 * memory at extract time, so computing hashes during the existing
 * traversal is microseconds per symbol. Storing the hashes on the nodes
 * table makes every later sweep (duplicates, drift, diff) into a
 * `WHERE ast_hash = ?` index lookup instead of an O(N) reparse.
 *
 * v1 scope: Type-1 + Type-2 clone detection only. NOT Type-3
 * (statement-level reordering) or Type-4 (semantic-equivalent
 * rewrite). Council was explicit: "we detect Type-1 + Type-2, NOT
 * Type-3+ in v1". Anyone reading downstream tools must treat these
 * fingerprints as structural signals, not intent-equivalence proof.
 *
 * Three v1 fingerprints emitted per node:
 *
 *   - `astHash`     — Type-1. SHA-256 of the normalized AST token
 *                     stream with identifiers AND literals preserved
 *                     exactly as written. Detects "same code, only
 *                     whitespace/comments differ".
 *   - `astShapeHash`— Type-2. Same stream but with local identifiers
 *                     replaced by a `_ID` placeholder. Detects
 *                     "same code, renamed locals". Property/field/type
 *                     identifiers are PRESERVED so member-name semantics
 *                     (`.toString()`, `obj.foo`) survive.
 *   - `sigHash`     — SHA-256 of the node's signature string when
 *                     present. Cheap derived field; cached here so
 *                     signature-drift queries are a single column read
 *                     instead of a per-row compute.
 *
 * The fourth fingerprint discussed in the RFC — `callPatternHash` —
 * depends on resolved outgoing edges and is reserved for
 * post-resolution population by a later PR. This file is the
 * extract-time data infrastructure only; no resolution-side
 * writer exists yet.
 *
 * Whitespace, comments, and trivia tokens (commas, semicolons, braces)
 * are stripped before hashing so cosmetic edits don't invalidate
 * fingerprints. Tree-sitter exposes a `isNamed` flag that distinguishes
 * structural nodes (named) from anonymous lexical tokens — we keep
 * only named nodes plus their text/placeholder for leaves.
 */

import * as crypto from 'crypto';
import type { Node as SyntaxNode } from 'web-tree-sitter';

/**
 * Tree-sitter node types that we always skip when computing
 * fingerprints. These are comments + their language-specific
 * variants. Keeping any of them in the token stream would mean a
 * doc-comment edit invalidates the fingerprint — directly contrary
 * to v1's "Type-1 = whitespace/comment insensitive" definition.
 */
const COMMENT_NODE_TYPES = new Set<string>([
  'comment',
  'line_comment',
  'block_comment',
  'doc_comment',
  'shebang_line',
]);

/**
 * Tree-sitter node types whose `text` MAY be replaced with a stable
 * `_ID` placeholder for `astShapeHash`. Renaming only fires when
 * `shouldPreserveIdentifier` ALSO returns false for the same node.
 * Other leaf types (`property_identifier`, `field_identifier`,
 * `type_identifier`, literals, keywords) are never renamed and
 * always emit their actual text.
 *
 * Codex pass 1 BLOCKER: type-only check is INSUFFICIENT for Python.
 * `tree-sitter-python` parses `obj.start()` as
 * `attribute(identifier "obj", identifier "start")` — BOTH children
 * are plain `identifier`, not `property_identifier`. Without
 * context-aware preservation, `obj.start()` and `obj.stop()` would
 * conflate. The parent-context check below fixes that.
 */
const RENAMED_IDENTIFIER_TYPES = new Set<string>(['identifier']);

/**
 * Parent node types in which an `identifier` child carries semantic
 * meaning and must NOT be renamed. Hit-list approach (rather than
 * binding-aware scope tracking) keeps v1 simple while still catching
 * the cross-language failure modes Codex pass 1 flagged.
 *
 *  - `attribute`           Python member access: `obj.start()` →
 *                          `attribute(identifier "obj", identifier
 *                          "start")`. Both children are plain
 *                          `identifier`; renaming would conflate
 *                          `obj.start()` with `obj.stop()`. We
 *                          preserve BOTH for safety (loses Type-2
 *                          detection on the receiver name, but
 *                          never produces a semantic false positive).
 *  - `member_expression`,
 *    `subscript_expression` JS/TS member access via plain identifier
 *                          (some grammar shapes emit `identifier`
 *                          rather than `property_identifier`).
 *  - `module`              Top-level module reference.
 *  - `type_identifier`     Defensive — type names should never get
 *                          here as plain `identifier`, but if a
 *                          grammar slips one through, preserve it.
 */
const SEMANTIC_PARENT_TYPES = new Set<string>([
  'attribute',
  'member_expression',
  'subscript_expression',
  'module',
  'type_identifier',
  // Codex round 2 finding: Python `g(start=1)` parses as
  // `keyword_argument(name: identifier "start", value: integer)`.
  // The `name` field IS part of the call contract — `g(start=1)`
  // and `g(stop=1)` must NOT share astShapeHash.
  //
  // v1 trade-off (Codex round 3 confirmed acceptable, deferred to a
  // follow-up): set-membership rather than field-specific check
  // means any identifier LEAF whose direct parent is
  // `keyword_argument` is preserved — including a value-side
  // identifier like `g(start=count)`, where `count` is a local
  // that would ideally be renamed by Type-2. A tighter
  // `parent.childForFieldName('name')` check would only preserve
  // the name child; we accept the over-preservation in v1 because
  // the cost is "miss some Type-2 detection" (false negative on
  // duplicates), not the "conflate semantic names" failure mode
  // (false positive) the BLOCKER guarded against.
  'keyword_argument',
]);

/**
 * Return true when the `identifier` leaf at `node` sits in a
 * semantic-name position under `parent` and must NOT be renamed.
 *
 * Rules, in order:
 *   1. Parent type starts with `import` — covers `import_statement`,
 *      `import_from_statement`, `import_specifier`, etc. across
 *      languages. Module + symbol names are part of the contract.
 *   2. Parent type starts with `type_` or is `generic_type` — type
 *      names, parameters, arguments. Renaming would conflate
 *      `Array<User>` with `Array<Admin>`.
 *   3. Parent type is in `SEMANTIC_PARENT_TYPES` — see Set comment.
 *   4. Parent is `call` / `call_expression` AND `node` IS the
 *      parent's `function`-field child (the callee, not an argument).
 *      Catches bare-call semantics: `start()` vs `stop()` must NOT
 *      conflate even when both are `identifier` callees in Python.
 *   5. Otherwise the identifier is treated as a local-ish use and
 *      gets renamed.
 */
function shouldPreserveIdentifier(node: SyntaxNode, parent: SyntaxNode | null): boolean {
  if (!parent) return false;
  const parentType = parent.type;
  if (parentType.startsWith('import')) return true;
  if (parentType.startsWith('type_') || parentType === 'generic_type') return true;
  if (SEMANTIC_PARENT_TYPES.has(parentType)) return true;
  if (parentType === 'call' || parentType === 'call_expression') {
    const fnField = parent.childForFieldName('function');
    if (fnField && fnField.id === node.id) return true;
  }
  return false;
}

/**
 * Build the deterministic token stream for `node`'s subtree.
 *
 * @param node Tree-sitter syntax node rooted at the symbol body.
 * @param source Full source file text (used to extract leaf text).
 * @param renameLocals When true, identifier leaves in non-semantic
 *                     positions are replaced with `_ID`. Semantic
 *                     positions (member access, callee, type, import)
 *                     are preserved regardless of this flag.
 */
function emitTokenStream(
  node: SyntaxNode,
  source: string,
  renameLocals: boolean,
): string[] {
  const tokens: string[] = [];
  const walk = (n: SyntaxNode, parent: SyntaxNode | null): void => {
    if (COMMENT_NODE_TYPES.has(n.type)) return;
    // Emit the node's structural type so two snippets with different
    // syntactic shapes produce different streams even if their leaf
    // text would have coincided.
    tokens.push(n.type);
    if (n.namedChildCount === 0) {
      // Leaf — emit the actual text so identical literals/identifiers
      // map to identical tokens. Rename ONLY when the caller asked
      // for it AND the leaf is a plain `identifier` AND the parent
      // context confirms this isn't a semantic-name position.
      const isRenameable = RENAMED_IDENTIFIER_TYPES.has(n.type);
      const preserve = isRenameable && shouldPreserveIdentifier(n, parent);
      const text = renameLocals && isRenameable && !preserve
        ? '_ID'
        : source.slice(n.startIndex, n.endIndex);
      tokens.push(text);
      return;
    }
    for (let i = 0; i < n.namedChildCount; i++) {
      const child = n.namedChild(i);
      if (child) walk(child, n);
    }
  };
  walk(node, null);
  return tokens;
}

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Compute Type-1 ast-hash for a tree-sitter subtree. Identifiers AND
 * literals are preserved exactly. Two snippets produce the same hash
 * iff they have the same AST shape, identifiers, and literals — i.e.
 * they differ only in whitespace, comments, or trivia.
 */
export function computeAstHash(node: SyntaxNode, source: string): string {
  // Use a delimiter that cannot appear inside a single token to keep
  // the concatenation injective. Tree-sitter type names are
  // identifier-shaped, and we control the leaf text we wrote in;
  // ASCII 31 (Unit Separator) is the cleanest choice and never
  // appears in real source.
  const tokens = emitTokenStream(node, source, /* renameLocals */ false);
  return sha256Hex(tokens.join('\x1f'));
}

/**
 * Compute Type-2 ast-shape-hash. Same as `computeAstHash` but with
 * local `identifier` leaves replaced by a `_ID` placeholder. Catches
 * renamed-locals clones; preserves member/type identifier semantics.
 */
export function computeAstShapeHash(node: SyntaxNode, source: string): string {
  const tokens = emitTokenStream(node, source, /* renameLocals */ true);
  return sha256Hex(tokens.join('\x1f'));
}

/**
 * SHA-256 of the symbol's signature string. Returns null when no
 * signature is available — keeping the column nullable matches the
 * schema and avoids spurious "drift" diffs against rows that simply
 * never had a signature recorded.
 */
export function computeSigHash(signature: string | undefined): string | null {
  if (!signature) return null;
  return sha256Hex(signature);
}
