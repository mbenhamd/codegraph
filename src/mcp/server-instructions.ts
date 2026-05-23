/**
 * Server-level instructions emitted in the MCP `initialize` response.
 *
 * MCP clients (Claude Code, Cursor, opencode, LangChain, OpenAI Agent
 * SDK, …) surface this text in the agent's system prompt automatically,
 * giving the agent a high-level playbook for the codegraph toolset
 * before it sees individual tool descriptions.
 *
 * Goals when editing this:
 *   - Tool selection by intent (which tool for which question)
 *   - Common chains (refactor planning = X then Y)
 *   - Anti-patterns (don't start with grep when codegraph_search is faster)
 *
 * Keep it tight. The agent reads this every session — long instructions
 * burn tokens. Reference only tools that exist on `main`; gate any
 * conditional tools behind feature checks if/when they ship.
 */
export const SERVER_INSTRUCTIONS = `# Codegraph — code intelligence over an indexed knowledge graph

Codegraph is a SQLite knowledge graph of symbols, edges, and files in
the workspace. Reads are sub-millisecond; the index lags writes by
about a second through the file watcher. Use it as the first pass for
structural code questions before writing or editing code.

## Prefer direct structural exploration

For "how does X work", architecture, trace, or where-is-X questions,
answer directly with 2-3 codegraph calls: \`codegraph_context\` first,
then ONE \`codegraph_explore\` for the source of the symbols it surfaces.
This usually finds the right files faster than delegating the lookup to
a separate file-reading sub-task/agent or running a broad grep/read
sweep. Reach for raw Read/Grep to inspect a specific file, confirm a
specific detail, or search literal text that codegraph does not model.

## Tool selection by intent

- **"What is the symbol named X?"** → \`codegraph_search\`
- **"What's the deal with this task / feature / area?"** → \`codegraph_context\` (PRIMARY — composes search + node + callers + callees in one call)
- **"What calls this?"** → \`codegraph_callers\`
- **"What does this call?"** → \`codegraph_callees\`
- **"What would changing this break?"** → \`codegraph_impact\`
- **"Show me this symbol's source / signature / docstring."** → \`codegraph_node\`
- **"Show me several related symbols' source / survey an area."** → \`codegraph_explore\` (ONE capped call; prefer over many codegraph_node/Read)
- **"What's in directory X?"** → \`codegraph_files\`
- **"Is the index ready / what's its size?"** → \`codegraph_status\`
- **"Where is this exact string/comment/log message?"** → native grep/read

## Common chains

- **Onboarding**: \`codegraph_context\` first. If still unclear, \`codegraph_explore\` for breadth, then \`codegraph_node\` on specific symbols.
- **Refactor planning**: \`codegraph_search\` → \`codegraph_callers\` → \`codegraph_impact\`. The blast-radius answer comes from impact, not from walking callers manually.
- **Debugging a regression**: \`codegraph_callers\` of the suspected symbol; widen with \`codegraph_impact\` if an unexpected call appears.

## Anti-patterns

- **Don't grep first for symbol lookup** — \`codegraph_search\` is usually faster and returns kind + location + signature.
- **Don't chain \`codegraph_search\` + \`codegraph_node\`** when you just want context — \`codegraph_context\` is one round-trip.
- **Don't loop \`codegraph_node\` over many symbols** — one \`codegraph_explore\` call returns them all grouped by file, while each separate call re-reads the whole context and costs far more. Use \`codegraph_node\` for a single symbol.
- **Don't query the index immediately after editing a file** — the watcher needs ~500ms to debounce + sync. Wait for the next turn.

## Limitations

- Index lags file writes by ~1 second.
- Cross-file resolution is best-effort name matching; ambiguous calls may return multiple candidates.
- No live correctness validation — that's still the TypeScript compiler / test suite / linter's job. Codegraph supplements those with structural context they don't have.
- Verify against source, tests, or typecheck when results are surprising, low-confidence, security/production-sensitive, or edit-critical.
`;
