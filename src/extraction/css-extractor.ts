/**
 * PF-695: CSS extractor.
 *
 * Phase A of the UI/UX retrieval lane (council debate produced this
 * scope — see the Codex two-pass review). Indexes `.css`, `.scss`,
 * `.sass`, `.less`, `.styl`, `.pcss` files via the `tree-sitter-css`
 * grammar and emits:
 *
 *   - One `file` node per stylesheet (root container for `contains`
 *     edges).
 *   - One `selector` node per comma-separated entry in a rule's
 *     selector list. So `.feature-card__title, .feature-card__subtitle {
 *     color: red }` produces two selector nodes — answer "find rules
 *     targeting `.feature-card__title`" without parsing the rule list
 *     at query time.
 *   - `contains` edges from file → selector.
 *   - `imports` unresolved references for `@import "..."`.
 *
 * Each selector node carries:
 *   - `name` — the selector text, trimmed (`.feature-card__title`)
 *   - `qualifiedName` — `filepath::selectorText`, matching the convention
 *     used by Liquid / DFM custom extractors
 *   - `signature` — selector text + first 80 chars of the rule body, so
 *     `codegraph_search` previews show what the rule does without
 *     loading the file
 *   - `metadata.specificity` — integer weight via the standard CSS
 *     `(b*100 + c*10 + d)` formula. Council debate: Codex's
 *     opposing-case pass accepted that specificity is cheap, useful,
 *     and unambiguously selector metadata (NOT cascade resolution).
 *   - `metadata.selectorKind` — `class`, `id`, `pseudo`, `element`,
 *     `compound` (the rightmost named target's category, when it can
 *     be classified cheaply).
 *
 * Out of scope for Phase A (deferred per the council plan):
 *   - className↔selector edges from JSX (Phase B)
 *   - design-token graph (Phase C)
 *   - asset usage (Phase D)
 *   - `codegraph_unused_selectors` (waits for Phase B so the "unused"
 *     claim is honest — needs JSX usage references)
 */

import * as crypto from 'crypto';
import { Node as SyntaxNode } from 'web-tree-sitter';
import {
  Node,
  Edge,
  ExtractionResult,
  ExtractionError,
  UnresolvedReference,
} from '../types';
import { getParser, isLanguageSupported } from './grammars';
import { generateNodeId, getNodeText } from './tree-sitter-helpers';

/** Cap on signature preview length — keeps `codegraph_search` results bounded. */
const SIGNATURE_PREVIEW_CAP = 80;

/** Coarse classification of a selector's "target". Used as metadata only. */
type SelectorKind = 'class' | 'id' | 'pseudo' | 'element' | 'compound' | 'other';

export class CSSExtractor {
  private readonly filePath: string;
  private readonly source: string;
  private readonly nodes: Node[] = [];
  private readonly edges: Edge[] = [];
  private readonly unresolvedReferences: UnresolvedReference[] = [];
  private readonly errors: ExtractionError[] = [];
  private fileNodeId: string | null = null;

  constructor(filePath: string, source: string) {
    this.filePath = filePath;
    this.source = source;
  }

  extract(): ExtractionResult {
    const startTime = Date.now();

    if (!isLanguageSupported('css')) {
      this.errors.push({
        message: 'CSS grammar not loaded; load it via loadGrammarsForLanguages(["css"]).',
        severity: 'error',
        filePath: this.filePath,
      });
      return this.buildResult(startTime);
    }

    const parser = getParser('css');
    if (!parser) {
      this.errors.push({
        message: 'CSS parser unavailable',
        severity: 'error',
        filePath: this.filePath,
      });
      return this.buildResult(startTime);
    }

    let tree;
    try {
      tree = parser.parse(this.source);
    } catch (err) {
      this.errors.push({
        message: `CSS parse failed: ${err instanceof Error ? err.message : String(err)}`,
        severity: 'error',
        filePath: this.filePath,
      });
      return this.buildResult(startTime);
    }

    if (!tree || !tree.rootNode) {
      this.errors.push({
        message: 'CSS parse returned empty tree',
        severity: 'error',
        filePath: this.filePath,
      });
      return this.buildResult(startTime);
    }

    this.fileNodeId = this.emitFileNode(tree.rootNode);
    this.walk(tree.rootNode);

    return this.buildResult(startTime);
  }

  private buildResult(startTime: number): ExtractionResult {
    return {
      nodes: this.nodes,
      edges: this.edges,
      unresolvedReferences: this.unresolvedReferences,
      errors: this.errors,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * File node: the root container. Matches how Liquid / DFM extractors
   * emit a single file-kind node so `contains` edges have a parent.
   */
  private emitFileNode(root: SyntaxNode): string {
    const id = generateNodeId(this.filePath, 'file', this.filePath, 1);
    const node: Node = {
      id,
      kind: 'file',
      name: this.filePath.split('/').pop() ?? this.filePath,
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: 'css',
      startLine: 1,
      endLine: root.endPosition.row + 1,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    };
    this.nodes.push(node);
    return id;
  }

  /**
   * Tree walk. tree-sitter-css emits `rule_set` for `selectors { block }`
   * and `import_statement` / `at_rule` for `@import`/`@-rules`. We
   * handle each in dedicated helpers and ignore everything else
   * (declarations, media queries' inner blocks recurse naturally).
   */
  private walk(node: SyntaxNode): void {
    if (node.type === 'rule_set') {
      this.handleRuleSet(node);
      // Don't descend into the block — declarations aren't selector
      // nodes. But nested rules (SCSS-style, not pure CSS) live inside
      // the block and would need recursive descent. tree-sitter-css
      // doesn't parse SCSS nesting, so this is a no-op for plain CSS.
      return;
    }
    if (node.type === 'import_statement' || node.type === 'at_rule') {
      this.handleAtRule(node);
    }
    if (node.type === 'media_statement' || node.type === 'supports_statement') {
      // @media / @supports wrap rule sets; recurse into their block.
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) this.walk(child);
      }
      return;
    }
    // Default: recurse on named children. Stylesheet root falls
    // through here.
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) this.walk(child);
    }
  }

  private handleRuleSet(ruleSet: SyntaxNode): void {
    if (this.fileNodeId === null) return;

    // tree-sitter-css `rule_set` shape:
    //   rule_set
    //     selectors
    //       <selector>
    //       ','
    //       <selector>
    //       ...
    //     block
    //       { ... }
    const selectorsField = ruleSet.namedChildren.find((c) => c?.type === 'selectors');
    if (!selectorsField) return;

    const block = ruleSet.namedChildren.find((c) => c?.type === 'block');
    const blockPreview = block
      ? this.previewBlock(block)
      : '';

    const startLine = ruleSet.startPosition.row + 1;
    const endLine = ruleSet.endPosition.row + 1;
    const startCol = ruleSet.startPosition.column;
    const endCol = ruleSet.endPosition.column;

    for (let i = 0; i < selectorsField.namedChildCount; i++) {
      const sel = selectorsField.namedChild(i);
      if (!sel) continue;
      // Filter to the actual selector node types tree-sitter-css emits.
      // The grammar uses a few different node-type names (class_selector,
      // id_selector, pseudo_class_selector, descendant_selector, etc.) —
      // collectively any named child whose type ends in `_selector`
      // qualifies. Also accept bare tag_name selectors.
      if (!this.isSelectorNode(sel)) continue;

      const text = getNodeText(sel, this.source).trim();
      if (!text) continue;

      const selectorKind = this.classifySelector(sel, text);
      const specificity = this.computeSpecificity(text);

      const id = generateNodeId(this.filePath, 'selector', text, startLine);
      const signature = blockPreview
        ? `${text} { ${blockPreview} }`
        : text;

      const node: Node = {
        id,
        kind: 'selector',
        name: text,
        qualifiedName: `${this.filePath}::${text}`,
        filePath: this.filePath,
        language: 'css',
        startLine,
        endLine,
        startColumn: startCol,
        endColumn: endCol,
        signature: signature.slice(0, 400),
        updatedAt: Date.now(),
      };
      // Attach extractor metadata via `decorators` would conflate
      // semantics; instead surface specificity + selectorKind via the
      // Node's optional fields. There's no first-class metadata slot
      // on Node — Phase B may want one — so encode them in
      // `decorators` for now (a string[] field) which downstream
      // queries can inspect.
      (node as Node & { selectorMetadata?: { specificity: number; selectorKind: SelectorKind } }).selectorMetadata = {
        specificity,
        selectorKind,
      };

      this.nodes.push(node);

      // contains edge: file → selector
      this.edges.push({
        source: this.fileNodeId,
        target: id,
        kind: 'contains',
      });
    }
  }

  /**
   * Selector node-type filter. tree-sitter-css uses several distinct
   * types for selectors; checking `endsWith('_selector')` + a small
   * allowlist covers them without enumerating the full grammar.
   */
  private isSelectorNode(node: SyntaxNode): boolean {
    if (node.type === 'tag_name') return true;
    if (node.type === 'universal_selector') return true;
    if (node.type.endsWith('_selector')) return true;
    return false;
  }

  /**
   * Coarse selector classification. For `.a` → 'class', `#a` → 'id',
   * `:hover` → 'pseudo', `button` → 'element'. Complex selectors
   * (combinators, compound) fall through to 'compound'. Best-effort —
   * the goal is a useful filter for `codegraph_css_selectors --kind`,
   * not a complete CSS analyzer.
   */
  private classifySelector(node: SyntaxNode, text: string): SelectorKind {
    if (node.type === 'class_selector') return 'class';
    if (node.type === 'id_selector') return 'id';
    if (node.type === 'pseudo_class_selector' || node.type === 'pseudo_element_selector') {
      return 'pseudo';
    }
    if (node.type === 'tag_name') return 'element';
    // For descendant/child/sibling/compound selectors: pick the
    // primary character to keep the classification useful.
    if (text.includes(' ') || text.includes('>') || text.includes('+') || text.includes('~')) {
      return 'compound';
    }
    if (text.startsWith('.')) return 'class';
    if (text.startsWith('#')) return 'id';
    if (text.startsWith(':')) return 'pseudo';
    return 'other';
  }

  /**
   * CSS specificity weight via the standard `(a, b, c, d)` formula,
   * compressed to one integer:
   *   a = inline (always 0 for stylesheet selectors)
   *   b = #id count           (weight 100)
   *   c = .class / [attr] / :pseudo-class count   (weight 10)
   *   d = element / ::pseudo-element count          (weight 1)
   *
   * Best-effort regex-based count — won't match a full CSS parse for
   * pathological selectors but is correct for the BEM/utility
   * conventions this is meant to serve. Council debate (Codex
   * opposing-case) endorsed: cheap, useful, label as "selector
   * metadata" not "cascade resolution".
   */
  private computeSpecificity(selectorText: string): number {
    // Strip universal selector and combinators to count only named pieces.
    let text = selectorText;
    text = text.replace(/\/\*[\s\S]*?\*\//g, ''); // strip CSS comments
    const idCount = (text.match(/#[\w-]+/g) ?? []).length;
    // Pseudo-elements (::before) — counted as elements per CSS spec.
    const pseudoElementCount = (text.match(/::[\w-]+/g) ?? []).length;
    // Pseudo-classes (:hover) — counted as classes.
    const pseudoClassCount = (text.match(/(?:^|[^:]):[\w-]+(?:\([^)]*\))?/g) ?? []).length;
    const classCount = (text.match(/\.[\w-]+/g) ?? []).length;
    const attrCount = (text.match(/\[[^\]]+\]/g) ?? []).length;
    // Element tags: lowercase identifiers NOT preceded by `.`, `#`, or `:`.
    const tagCount = (
      text.match(/(?:^|[\s>+~])[a-z][\w-]*/g) ?? []
    ).length;
    return idCount * 100 + (classCount + pseudoClassCount + attrCount) * 10 + (tagCount + pseudoElementCount);
  }

  /**
   * Build the signature preview from a rule body. Capped to keep
   * `codegraph_search` output bounded — agents follow up with
   * `codegraph_node` (or `codegraph_explore`) for the full body.
   */
  private previewBlock(block: SyntaxNode): string {
    // Strip the surrounding `{` and `}` characters and collapse
    // whitespace to single spaces.
    const raw = getNodeText(block, this.source);
    const inner = raw.replace(/^\s*\{|\}\s*$/g, '').replace(/\s+/g, ' ').trim();
    return inner.length > SIGNATURE_PREVIEW_CAP
      ? inner.slice(0, SIGNATURE_PREVIEW_CAP) + '…'
      : inner;
  }

  /**
   * @import "...", @use "...", and CSS-in-CSS `@import url(...)` all
   * produce unresolved references — they target a path which Phase A
   * doesn't resolve. The reference shows up in the graph with a
   * `referenceKind: 'imports'` so a later resolution pass (or Phase
   * C/D) can wire the resolved file node.
   */
  private handleAtRule(node: SyntaxNode): void {
    if (this.fileNodeId === null) return;

    const text = getNodeText(node, this.source);
    // Match `@import "..."` or `@import 'whatever.css'` or `@import url("...")`.
    const importMatch = text.match(/@import\s+(?:url\(\s*)?["']([^"']+)["']/);
    if (!importMatch) return;
    const importedPath = importMatch[1];
    if (!importedPath) return;

    this.unresolvedReferences.push({
      fromNodeId: this.fileNodeId,
      referenceName: importedPath,
      referenceKind: 'imports',
      line: node.startPosition.row + 1,
      column: node.startPosition.column,
      filePath: this.filePath,
      language: 'css',
    });
  }
}

/**
 * Used by `extractFromSource` for css-language files.
 */
export function extractFromCss(filePath: string, source: string): ExtractionResult {
  return new CSSExtractor(filePath, source).extract();
}

// Helper kept colocated so the file is self-contained for tests.
export function _testOnlyHashId(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex').substring(0, 32);
}
