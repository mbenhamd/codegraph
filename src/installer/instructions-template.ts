/**
 * Agent-instructions template — the markdown body each agent target
 * writes into its conventional instructions file (CLAUDE.md /
 * AGENTS.md / codegraph.mdc / etc.).
 *
 * The body content is identical across agents because the codegraph
 * usage advice is agent-agnostic — only the destination filename and
 * any optional frontmatter (Cursor `.mdc`) varies per target.
 *
 * The legacy `claude-md-template.ts` re-exports these names for
 * backwards compatibility with downstream importers.
 */

/** Markers used by the marker-based section replacement. */
export const CODEGRAPH_SECTION_START = '<!-- CODEGRAPH_START -->';
export const CODEGRAPH_SECTION_END = '<!-- CODEGRAPH_END -->';

/**
 * The full marker-delimited block written into each agent's
 * instructions file. Includes the start/end markers so the section
 * can be detected and replaced on re-install.
 */
export const INSTRUCTIONS_TEMPLATE = `${CODEGRAPH_SECTION_START}
## CodeGraph

This project has a CodeGraph MCP server (\`codegraph_*\` tools) configured. CodeGraph is a tree-sitter-parsed knowledge graph of symbols, edges, and files. Reads are sub-millisecond and return structural context grep cannot.

### When to prefer codegraph over native search

Use codegraph as the **first pass for structural** questions — what calls what, what would break, where is X defined, what is X's signature. Use native grep/read for **literal text** queries (string contents, comments, log messages), exact snippets, or after you already have a specific file open.

| Question | Tool |
|---|---|
| "Where is X defined?" / "Find symbol named X" | \`codegraph_search\` |
| "What calls function Y?" | \`codegraph_callers\` |
| "What does Y call?" | \`codegraph_callees\` |
| "What would break if I changed Z?" | \`codegraph_impact\` |
| "Show me Y's signature / source / docstring" | \`codegraph_node\` |
| "Give me focused context for a task/area" | \`codegraph_context\` |
| "See several related symbols' source at once" | \`codegraph_explore\` |
| "What files exist under path/" | \`codegraph_files\` |
| "Is the index healthy?" | \`codegraph_status\` |

### Rules of thumb

- **Answer directly for structural exploration.** For "how does X work" / architecture / trace questions, start with 2-3 codegraph calls: \`codegraph_context\` first, then ONE \`codegraph_explore\` for the source of the symbols it surfaces. This usually gives the right files faster than delegating to another agent or running a broad grep/read sweep.
- **Verify when it matters.** CodeGraph is a fast structural index, not a source of truth. Confirm with source reads, tests, or typecheck when results are surprising, low-confidence, security/production-sensitive, or before edit-critical conclusions.
- **Don't grep first for symbol lookup.** When looking up a symbol by name, \`codegraph_search\` is usually faster and returns kind + location + signature in one call. Use grep/read when the target is literal text rather than a symbol.
- **Don't chain \`codegraph_search\` + \`codegraph_node\`** when you just want context — \`codegraph_context\` is one call.
- **Don't loop \`codegraph_node\` over many symbols** — one \`codegraph_explore\` call returns several symbols' source grouped in a single capped call, while each separate node/Read call re-reads the whole context and costs far more.
- **Index lag**: the file watcher debounces ~500ms behind writes; don't re-query immediately after editing a file in the same turn.

### If \`.codegraph/\` doesn't exist

The MCP server returns "not initialized." Ask the user: *"I notice this project doesn't have CodeGraph initialized. Want me to run \`codegraph init -i\` to build the index?"*
${CODEGRAPH_SECTION_END}`;

/**
 * Backwards-compat alias. Existing downstream code may import
 * `CLAUDE_MD_TEMPLATE` from this module via the re-export shim in
 * `claude-md-template.ts`.
 */
export const CLAUDE_MD_TEMPLATE = INSTRUCTIONS_TEMPLATE;
