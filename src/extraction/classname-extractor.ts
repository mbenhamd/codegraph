/**
 * PF-696 (Phase B): JSX className → CSS selector bridge.
 *
 * Walks tree-sitter-tsx / tree-sitter-jsx ASTs after the main
 * extraction pass completes, finds `className="..."` attributes,
 * extracts DEFINITE class strings (no `possible`/`unknown` modeling
 * — see council debate, Codex two-pass review on PF-695), and emits
 * unresolved references with `referenceName: '.foo'` so the existing
 * resolution pass connects them to selector nodes by exact name.
 *
 * Scope decisions locked by the Phase B RFC:
 *
 *   1. **Definite-only extraction.** Static class strings
 *      (`className="foo bar"`), static parts of template literals
 *      (`` className={`btn ${variant}`} `` extracts `btn`), and
 *      string-literal arguments to `cn(...)` / `clsx(...)` /
 *      `classnames(...)` (`cn('foo', condition && 'bar')` extracts
 *      `'foo'`; `condition && 'bar'` is "possible" and is DROPPED).
 *      Components with any non-static class expression get a
 *      `hasDynamicClassNames` flag — single boolean per node, NOT a
 *      taxonomy of `possible`/`unknown` edges. Council debate
 *      consensus: `possible` edges are agent-trap; honest scope is
 *      "this component has dynamic classes, grep it".
 *
 *   2. **Tailwind opt-in, default off.** When `tailwind: false`,
 *      class tokens matching the heuristic `looksLikeTailwind()`
 *      are skipped. Papersflow's BEM-by-ADR styling makes this the
 *      right default; users can flip to `tailwind: true` for
 *      Tailwind-heavy projects.
 *
 *   3. **One unresolved reference per definite class token.** The
 *      existing resolver matches `referenceName: '.feature-card'`
 *      against selector nodes whose `name === '.feature-card'`. No
 *      new resolution strategy needed — the exact-match path picks
 *      them up.
 *
 *   4. **Per-component flag, not per-class.** If ANY class
 *      expression in a component is dynamic, the enclosing node
 *      gets `hasDynamicClassNames: true`. Single signal vs. an
 *      array of "possible" edges that agents would misuse.
 *
 * Out of scope (other phases / future PRs):
 *   - Vue / Svelte template className extraction (same pattern,
 *     different ASTs — own PR)
 *   - CSS-in-JS template literals (`styled.div\`…\``) — Phase C
 *     candidate, but Codex flagged "different extraction path";
 *     left for later
 *   - Tailwind `bg-primary`-style theme-aliased classes — Phase C
 *     (design tokens)
 */

import { Node as SyntaxNode, Tree } from 'web-tree-sitter';
import type { Node, UnresolvedReference } from '../types';
import { getNodeText } from './tree-sitter-helpers';

export interface ClassNameExtractionConfig {
  /**
   * When true, Tailwind-looking utility classes are kept. When
   * false (default), they're filtered out so the edge graph stays
   * focused on BEM / semantic-class projects. The filter is a
   * heuristic — see `looksLikeTailwind()`.
   */
  tailwind: boolean;
}

export interface ClassNameExtractionResult {
  /**
   * Unresolved references for definite class tokens. Each has
   * `referenceName: '.foo'`, `referenceKind: 'references'`, and
   * `fromNodeId` set to the enclosing function/component node.
   */
  references: UnresolvedReference[];
  /**
   * Set of node IDs that contain at least one dynamic className
   * expression (template literal interpolation, variable
   * reference, object literal, unrecognized function call). The
   * caller stamps `hasDynamicClassNames: true` on these nodes so
   * users can tell "the graph might be missing class references
   * here — grep it".
   */
  dynamicClassNodes: Set<string>;
}

/**
 * Tailwind utility prefix heuristic. Conservative: matches the
 * prefixes of the standard config (`bg-`, `text-`, `p-`, `m-`,
 * etc.) plus responsive (`sm:`/`md:`/`lg:`) and state (`hover:`/
 * `focus:`/`active:`/`disabled:`/`group-hover:`) modifiers. Misses
 * custom Tailwind plugins but catches the 90% case for projects
 * that mix BEM + Tailwind utilities.
 *
 * If a class matches the pattern AND has no BEM separator (`__`
 * for element, `--` for modifier), we treat it as Tailwind.
 * Mixed-convention classes like `feature-card__hover:bg-blue` (a
 * BEM element with Tailwind state) — we err on BEM because of
 * `__`.
 */
const TAILWIND_PREFIX = new RegExp(
  '^(' +
    // Responsive modifiers
    'sm:|md:|lg:|xl:|2xl:|' +
    // State modifiers
    'hover:|focus:|focus-visible:|focus-within:|active:|disabled:|visited:|first:|last:|odd:|even:|empty:|group-hover:|group-focus:|peer-hover:|peer-focus:|dark:|motion-safe:|motion-reduce:|' +
    // Utility prefixes
    'bg-|text-|font-|leading-|tracking-|p-|px-|py-|pt-|pr-|pb-|pl-|m-|mx-|my-|mt-|mr-|mb-|ml-|space-|gap-|w-|h-|min-w-|min-h-|max-w-|max-h-|flex|inline|block|hidden|grid|table|isolate|float-|clear-|object-|overflow-|overscroll-|position-|top-|right-|bottom-|left-|inset-|z-|order-|col-|row-|grid-|justify-|content-|items-|self-|place-|rounded-|border-|divide-|outline-|ring-|shadow-|opacity-|mix-blend-|filter|backdrop-|cursor-|pointer-|select-|user-|resize-|scroll-|snap-|appearance-|caret-|accent-|fill-|stroke-|transform|translate-|rotate-|scale-|skew-|origin-|transition|duration-|ease-|delay-|animate-|antialiased|subpixel-antialiased|italic|not-italic|underline|line-through|no-underline|uppercase|lowercase|capitalize|normal-case|tabular-nums|truncate' +
    ')',
);

/**
 * Returns true if a class token looks like a Tailwind utility.
 * Used to skip these when `config.tailwind === false`.
 */
function looksLikeTailwind(token: string): boolean {
  // BEM marker → not Tailwind, keep it
  if (token.includes('__') || token.includes('--')) return false;
  return TAILWIND_PREFIX.test(token);
}

/**
 * Helper-function names that wrap className composition. Their
 * string-literal arguments are extracted as definite tokens;
 * non-string arguments are treated as dynamic.
 */
const CLASSNAME_HELPERS = new Set(['cn', 'clsx', 'classnames', 'classNames', 'twMerge', 'twJoin']);

/**
 * Walk the parsed tsx/jsx tree, emit className references.
 *
 * `containingNodes` is the list of code nodes (functions, methods,
 * components, classes) emitted by the main extractor in the same
 * pass. We map each className attribute to the deepest containing
 * function-like node by line range so the unresolved reference's
 * `fromNodeId` points to the React component / function — that's
 * the unit users mean when they ask "which components use this
 * class?".
 */
export function extractJsxClassNames(
  tree: Tree,
  source: string,
  filePath: string,
  containingNodes: Node[],
  config: ClassNameExtractionConfig,
): ClassNameExtractionResult {
  const references: UnresolvedReference[] = [];
  const dynamicClassNodes = new Set<string>();

  // Pre-compute candidate-containers index for fast O(log N) lookup.
  // We want the DEEPEST function/method/component-kind node that
  // contains a given line. Sorting by startLine ASC, endLine DESC
  // gets us that ordering — earlier-starting + later-ending wins
  // unless a more specific node is later in the list.
  const containers = containingNodes
    .filter(
      (n) =>
        n.kind === 'function' ||
        n.kind === 'method' ||
        n.kind === 'component' ||
        n.kind === 'class',
    )
    .slice()
    .sort((a, b) => {
      if (a.startLine !== b.startLine) return a.startLine - b.startLine;
      return b.endLine - a.endLine;
    });

  const fileFallbackId = `file:${filePath}`;

  const walk = (node: SyntaxNode): void => {
    if (node.type === 'jsx_attribute') {
      handleJsxAttribute(node);
      // Don't descend into the attribute — its value is handled.
      return;
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) walk(child);
    }
  };

  const handleJsxAttribute = (attr: SyntaxNode): void => {
    // jsx_attribute shape:
    //   property_identifier ("className") = jsx_attribute_value
    // The value can be a string literal, jsx_expression, or absent.
    const nameNode = attr.namedChild(0);
    if (!nameNode) return;
    const name = getNodeText(nameNode, source);
    if (name !== 'className' && name !== 'class') return; // 'class' for Vue/Svelte interop

    const startLine = attr.startPosition.row + 1;
    const startCol = attr.startPosition.column;
    const fromNodeId = findContainer(startLine) ?? fileFallbackId;

    // The value is the second-or-later child. tree-sitter emits the
    // `=` as an anonymous token, so namedChildren skips it.
    const valueNode = attr.namedChild(1);
    if (!valueNode) return; // attribute with no value (boolean attribute) — irrelevant for className

    extractFromValue(valueNode, fromNodeId, startLine, startCol);
  };

  const extractFromValue = (
    valueNode: SyntaxNode,
    fromNodeId: string,
    line: number,
    col: number,
  ): void => {
    // String literal: `className="foo bar"`
    if (valueNode.type === 'string') {
      emitTokensFromString(valueNode, fromNodeId, line, col);
      return;
    }
    // JSX expression container: `className={...}`
    if (valueNode.type === 'jsx_expression') {
      const inner = valueNode.namedChild(0);
      if (!inner) return;
      extractFromExpression(inner, fromNodeId, line, col);
      return;
    }
    // Anything else — flag dynamic
    dynamicClassNodes.add(fromNodeId);
  };

  const extractFromExpression = (
    expr: SyntaxNode,
    fromNodeId: string,
    line: number,
    col: number,
  ): void => {
    // String literal inside {}: className={"foo"} (rare but legal)
    if (expr.type === 'string') {
      emitTokensFromString(expr, fromNodeId, line, col);
      return;
    }
    // Template literal: className={`btn ${variant}`}
    if (expr.type === 'template_string' || expr.type === 'template_literal') {
      emitTokensFromTemplate(expr, fromNodeId, line, col);
      return;
    }
    // Call: className={cn('foo', 'bar')}, className={clsx(...)}
    if (expr.type === 'call_expression') {
      handleHelperCall(expr, fromNodeId, line, col);
      return;
    }
    // Anything else (identifier, member_expression, conditional) → dynamic
    dynamicClassNodes.add(fromNodeId);
  };

  const handleHelperCall = (
    call: SyntaxNode,
    fromNodeId: string,
    line: number,
    col: number,
  ): void => {
    const callee = call.childForFieldName('function') ?? call.namedChild(0);
    if (!callee) {
      dynamicClassNodes.add(fromNodeId);
      return;
    }
    const calleeName = getNodeText(callee, source);
    // Bare-name helper (`cn(...)`) or member access (`utils.cn(...)`)
    const lastSegment = calleeName.includes('.')
      ? calleeName.slice(calleeName.lastIndexOf('.') + 1)
      : calleeName;
    if (!CLASSNAME_HELPERS.has(lastSegment)) {
      // Unknown function — assume it might produce classes dynamically.
      dynamicClassNodes.add(fromNodeId);
      return;
    }

    const args = call.childForFieldName('arguments') ?? call.namedChild(1);
    if (!args) return;
    for (let i = 0; i < args.namedChildCount; i++) {
      const arg = args.namedChild(i);
      if (!arg) continue;
      if (arg.type === 'string') {
        emitTokensFromString(arg, fromNodeId, line, col);
      } else if (arg.type === 'template_string' || arg.type === 'template_literal') {
        emitTokensFromTemplate(arg, fromNodeId, line, col);
      } else {
        // Conditional (`cond && 'foo'`), object literal (`{ active: cond }`),
        // identifier, etc. — definite extraction can't reach into these
        // without false-positive risk. Flag dynamic.
        dynamicClassNodes.add(fromNodeId);
      }
    }
  };

  const emitTokensFromString = (
    strNode: SyntaxNode,
    fromNodeId: string,
    line: number,
    col: number,
  ): void => {
    const raw = getNodeText(strNode, source);
    // Strip surrounding quotes. Tree-sitter `string` node text
    // includes them; the inner `string_fragment` doesn't, but
    // selecting fragments would miss empty strings. Easier to
    // strip outermost quote chars.
    const inner = raw.replace(/^["'`]/, '').replace(/["'`]$/, '');
    emitTokens(inner, fromNodeId, line, col);
  };

  const emitTokensFromTemplate = (
    templateNode: SyntaxNode,
    fromNodeId: string,
    line: number,
    col: number,
  ): void => {
    // Template strings contain `string_fragment` and
    // `template_substitution` children. The fragments are static;
    // substitutions are dynamic. Walk the named children and
    // collect static fragments only. Flag dynamic if any
    // substitution exists.
    let hasDynamic = false;
    for (let i = 0; i < templateNode.namedChildCount; i++) {
      const child = templateNode.namedChild(i);
      if (!child) continue;
      if (child.type === 'string_fragment') {
        const text = getNodeText(child, source);
        emitTokens(text, fromNodeId, line, col);
      } else if (child.type === 'template_substitution') {
        hasDynamic = true;
      }
    }
    if (hasDynamic) dynamicClassNodes.add(fromNodeId);
  };

  const emitTokens = (
    text: string,
    fromNodeId: string,
    line: number,
    col: number,
  ): void => {
    // Split on any whitespace — multiple classes per attribute are
    // space-separated.
    const tokens = text.split(/\s+/).filter((t) => t.length > 0);
    for (const token of tokens) {
      if (!config.tailwind && looksLikeTailwind(token)) continue;
      // Skip tokens that contain template-literal interpolation
      // syntax (`${`, `{`, `}`). Bare `$` is LEGAL in CSS class
      // names (e.g. `feature-card--$primary`) so we don't reject
      // it (Codex REVIEW PR #696). Newlines and tabs are already
      // stripped by the split-on-whitespace earlier.
      if (token.includes('${') || token.includes('}')) continue;
      // Prepend `.` so the reference matches selector node names like `.feature-card`.
      const referenceName = '.' + token.replace(/^\./, '');
      references.push({
        fromNodeId,
        referenceName,
        referenceKind: 'references',
        line,
        column: col,
        filePath,
        language: filePath.endsWith('.tsx') ? 'tsx' : 'jsx',
      });
    }
  };

  const findContainer = (line: number): string | null => {
    let best: Node | null = null;
    for (const c of containers) {
      if (c.startLine <= line && c.endLine >= line) {
        // Pick the deepest (smallest range) container that still
        // covers the line. Containers are sorted; we keep scanning
        // because a later, more specific match can supersede.
        if (
          !best ||
          c.endLine - c.startLine < best.endLine - best.startLine
        ) {
          best = c;
        }
      }
    }
    return best?.id ?? null;
  };

  walk(tree.rootNode);

  return { references, dynamicClassNodes };
}
