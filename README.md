<div align="center">

# CodeGraph

### Supercharge Claude Code, Cursor, Codex, OpenCode, and Hermes Agent with Semantic Code Intelligence

**~35% cheaper · ~70% fewer tool calls · 100% local**

[![npm version](https://img.shields.io/npm/v/@colbymchenry/codegraph.svg)](https://www.npmjs.com/package/@colbymchenry/codegraph)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Self-contained](https://img.shields.io/badge/Node.js-bundled%20%C2%B7%20none%20required-brightgreen.svg)](https://nodejs.org/)

[![Windows](https://img.shields.io/badge/Windows-supported-blue.svg)](#supported-platforms)
[![macOS](https://img.shields.io/badge/macOS-supported-blue.svg)](#supported-platforms)
[![Linux](https://img.shields.io/badge/Linux-supported-blue.svg)](#supported-platforms)

[![Claude Code](https://img.shields.io/badge/Claude_Code-supported-blueviolet.svg)](#supported-agents)
[![Cursor](https://img.shields.io/badge/Cursor-supported-blueviolet.svg)](#supported-agents)
[![Codex CLI](https://img.shields.io/badge/Codex_CLI-supported-blueviolet.svg)](#supported-agents)
[![opencode](https://img.shields.io/badge/opencode-supported-blueviolet.svg)](#supported-agents)
[![Hermes Agent](https://img.shields.io/badge/Hermes_Agent-supported-blueviolet.svg)](#supported-agents)

</div>

## Get Started

**No Node.js required** — one command grabs the right build for your OS:

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh

# Windows (PowerShell)
irm https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.ps1 | iex
```

Already have Node? Use npm instead (works on any version):

```bash
npx @colbymchenry/codegraph        # zero-install, or:
npm i -g @colbymchenry/codegraph
```

<sub>CodeGraph bundles its own runtime — nothing to compile, no native build, works the same everywhere. The interactive installer auto-configures your agent(s) — Claude Code, Cursor, Codex CLI, opencode, Hermes Agent.</sub>

### Initialize Projects

```bash
cd your-project
codegraph init -i
```

<div align="center">

![1_C_VYnhpys0UHrOuOgpgoyw](https://github.com/user-attachments/assets/f168182f-4d9a-44e0-94d7-08d018cc8a3a)

</div>

### Uninstall

Changed your mind? One command removes CodeGraph from every agent it configured:

```bash
codegraph uninstall
```

<sub>Reverses the installer — strips CodeGraph's MCP server config, instructions, and permissions from each configured agent. Your project indexes (`.codegraph/`) are left untouched; remove those per-project with `codegraph uninit`. Use `--target` to remove from specific agents, or `--yes` to run non-interactively.</sub>

---

## Why CodeGraph?

When Claude Code explores a codebase, it spawns **Explore agents** that scan files with grep, glob, and Read — consuming tokens on every tool call.

**CodeGraph gives those agents a pre-indexed knowledge graph** — symbol relationships, call graphs, and code structure. Agents query the graph instantly instead of scanning files.

### Benchmark Results

Tested across **7 real-world open-source codebases** spanning 7 languages, comparing an agent (Claude Code, headless) answering one architecture question **with** and **without** CodeGraph. Each cell is the savings at the **median of 4 runs per arm**.

> **Average: 35% cheaper · 59% fewer tokens · 49% faster · 70% fewer tool calls**

| Codebase | Language | Cost | Tokens | Time | Tool calls |
|----------|----------|------|--------|------|------------|
| **VS Code** | TypeScript · ~10k files | 35% cheaper | 73% fewer | 41% faster | 72% fewer |
| **Excalidraw** | TypeScript · ~600 | 47% cheaper | 73% fewer | 60% faster | 86% fewer |
| **Django** | Python · ~2.7k | 34% cheaper | 64% fewer | 59% faster | 81% fewer |
| **Tokio** | Rust · ~700 | 52% cheaper | 81% fewer | 63% faster | 89% fewer |
| **OkHttp** | Java · ~640 | 17% cheaper | 41% fewer | 36% faster | 64% fewer |
| **Gin** | Go · ~150 | 22% cheaper | 23% fewer | 34% faster | 19% fewer |
| **Alamofire** | Swift · ~100 | 38% cheaper | 59% fewer | 51% faster | 77% fewer |

The gains scale with codebase size: on large repos the agent answers from the index in a handful of calls with **zero file reads**, while the no-CodeGraph agent fans out across grep/find/Read (and the sub-agents it spawns). On a small repo like Gin (~150 files) native search is already cheap, so the margin narrows.

<details>
<summary><strong>Full benchmark details</strong></summary>

**Methodology.** Each arm is `claude -p` (Claude Opus 4.7, Claude Code v2.1.145) run headlessly against the repo with `--strict-mcp-config`: **WITH** = CodeGraph's MCP server enabled, **WITHOUT** = an empty MCP config. Built-in Read/Grep/Bash stay available to both. Same question per repo, **4 runs per arm, median reported**. Cost = the run's `total_cost_usd`; Tokens = total tokens processed (input incl. cached + output); Time = wall-clock; Tool calls = every tool invocation, including those inside any sub-agents the model spawns. Repos cloned at `--depth 1` and indexed by the same CodeGraph build that served them.

**Queries:**
| Codebase | Query |
|----------|-------|
| VS Code | "How does the extension host communicate with the main process?" |
| Excalidraw | "How does Excalidraw render and update canvas elements?" |
| Django | "How does Django's ORM build and execute a query from a QuerySet?" |
| Tokio | "How does tokio schedule and run async tasks on its runtime?" |
| OkHttp | "How does OkHttp process a request through its interceptor chain?" |
| Gin | "How does gin route requests through its middleware chain?" |
| Alamofire | "How does Alamofire build, send, and validate a request?" |

**Raw medians — WITH → WITHOUT:**
| Codebase | Cost | Tokens | Time | Tool calls |
|----------|------|--------|------|------------|
| VS Code | $0.42 → $0.64 | 393k → 1.4M | 1m 0s → 1m 43s | 7 → 23 |
| Excalidraw | $0.54 → $1.02 | 851k → 3.2M | 1m 17s → 3m 14s | 12 → 83 |
| Django | $0.41 → $0.62 | 499k → 1.4M | 1m 0s → 2m 25s | 9 → 48 |
| Tokio | $0.50 → $1.04 | 657k → 3.4M | 1m 5s → 2m 56s | 9 → 75 |
| OkHttp | $0.36 → $0.44 | 352k → 596k | 45s → 1m 11s | 5 → 14 |
| Gin | $0.36 → $0.46 | 431k → 562k | 47s → 1m 11s | 7 → 8 |
| Alamofire | $0.61 → $0.99 | 1.1M → 2.6M | 1m 19s → 2m 41s | 15 → 64 |

**Why CodeGraph wins:** with the index available, the agent answers directly — `codegraph_context` to map the area, then one `codegraph_explore` for the relevant source — and stops, usually with zero file reads. Without it, the agent (and the Explore sub-agents it spawns) spends most of its budget on discovery (find/ls/grep) before reading the right code. CodeGraph only helps when queried *directly*, so its instructions steer agents to answer directly rather than delegate exploration to file-reading sub-agents — otherwise a sub-agent reads files regardless and CodeGraph becomes overhead.

</details>

---

## Key Features

| | |
|---|---|
| **Smart Context Building** | One tool call returns entry points, related symbols, and code snippets — no expensive exploration agents |
| **Full-Text Search** | Find code by name instantly across your entire codebase, powered by FTS5 |
| **Impact Analysis** | Trace callers, callees, and the full impact radius of any symbol before making changes |
| **Always Fresh** | File watcher uses native OS events (FSEvents/inotify/ReadDirectoryChangesW) with debounced auto-sync — the graph stays current as you code, zero config |
| **19+ Languages** | TypeScript, JavaScript, Python, Go, Rust, Java, C#, PHP, Ruby, C, C++, Swift, Kotlin, Dart, Lua, Luau, Svelte, Liquid, Pascal/Delphi |
| **Framework-aware Routes** | Recognizes web-framework routing files and links URL patterns to their handlers across 14 frameworks |
| **100% Local** | No data leaves your machine. No API keys. No external services. SQLite database only |

---

## Framework-aware Routes

CodeGraph detects web-framework routing files and emits `route` nodes linked by `references` edges to their handler classes or functions. Querying callers of a view/controller now surfaces the URL pattern that binds it.

| Framework | Shapes recognized |
|---|---|
| **Django** | `path()`, `re_path()`, `url()`, `include()` in `urls.py` (CBV `.as_view()`, dotted paths) |
| **Flask** | `@app.route('/path', methods=[...])`, blueprint routes |
| **FastAPI** | `@app.get(...)`, `@router.post(...)`, all standard methods |
| **Express** | `app.get(...)`, `router.post(...)` with middleware chains |
| **NestJS** | `@Controller` + `@Get/@Post/...`, GraphQL `@Resolver` + `@Query/@Mutation`, `@MessagePattern`/`@EventPattern`, `@SubscribeMessage` |
| **Laravel** | `Route::get()`, `Route::resource()`, `Controller@action`, tuple syntax |
| **Drupal** | `*.routing.yml` routes (`_controller`, `_form`, entity handlers); `hook_*` implementations in `.module`/`.theme`/`.install`/`.inc` |
| **Rails** | `get '/x', to: 'users#index'`, hash-rocket `=>` syntax |
| **Spring** | `@GetMapping`, `@PostMapping`, `@RequestMapping` on methods |
| **Gin / chi / gorilla / mux** | `r.GET(...)`, `router.HandleFunc(...)` |
| **Axum / actix / Rocket** | `.route("/x", get(handler))` |
| **ASP.NET** | `[HttpGet("/x")]` attributes on action methods |
| **Vapor** | `app.get("x", use: handler)` |
| **React Router** / **SvelteKit** | Route component nodes |

---

## Quick Start

### 1. Run the Installer

```bash
npx @colbymchenry/codegraph
```

The installer will:
- Ask which agent(s) to configure — auto-detects installed ones from: **Claude Code**, **Cursor**, **Codex CLI**, **opencode**, **Hermes Agent**
- Prompt to install `codegraph` on your PATH (so agents can launch the MCP server)
- Ask whether configs apply to all your projects or just this one
- Write each chosen agent's MCP server config + an instructions file (e.g. `CLAUDE.md`, `.cursor/rules/codegraph.mdc`, `~/.codex/AGENTS.md`)
- Set up auto-allow permissions when Claude Code is one of the targets
- Initialize your current project (local installs only)

**Non-interactive (scripting / CI):**

```bash
codegraph install --yes                              # auto-detect agents, install global
codegraph install --target=cursor,claude --yes       # explicit target list
codegraph install --target=auto --location=local     # detected agents, project-local
codegraph install --print-config codex               # print snippet, no file writes
```

| Flag | Values | Default |
|---|---|---|
| `--target` | `auto`, `all`, `none`, or csv (`claude,cursor,...`) | prompt |
| `--location` | `global`, `local` | prompt |
| `--yes` | (boolean) | prompt every step |
| `--no-permissions` | (boolean) skip Claude auto-allow list | permissions on |
| `--print-config <id>` | dump snippet for one agent and exit | — |

### 2. Restart Your Agent

Restart your agent (Claude Code / Cursor / Codex CLI / opencode / Hermes Agent) for the MCP server to load.

### 3. Initialize Projects

```bash
cd your-project
codegraph init -i
```

Builds the per-project knowledge graph index. Also wires up any project-local agent surfaces (e.g. Cursor's `.cursor/rules/codegraph.mdc`) so a single global `codegraph install` works in every project you open — no need to re-run the installer per project.

That's it — your agent will use CodeGraph tools automatically when a `.codegraph/` directory exists.

<details>
<summary><strong>Manual Setup (Alternative)</strong></summary>

**Install globally:**
```bash
npm install -g @colbymchenry/codegraph
```

**Add to `~/.claude.json`:**
```json
{
  "mcpServers": {
    "codegraph": {
      "type": "stdio",
      "command": "codegraph",
      "args": ["serve", "--mcp"]
    }
  }
}
```

**Add to `~/.claude/settings.json` (optional, for auto-allow):**
```json
{
  "permissions": {
    "allow": [
      "mcp__codegraph__codegraph_search",
      "mcp__codegraph__codegraph_context",
      "mcp__codegraph__codegraph_callers",
      "mcp__codegraph__codegraph_callees",
      "mcp__codegraph__codegraph_impact",
      "mcp__codegraph__codegraph_node",
      "mcp__codegraph__codegraph_explore",
      "mcp__codegraph__codegraph_files",
      "mcp__codegraph__codegraph_status"
    ]
  }
}
```

</details>

<details>
<summary><strong>Global Instructions Reference</strong></summary>

The installer automatically adds calibrated CodeGraph guidance to instruction-aware agent surfaces, such as `CLAUDE.md`, `.cursor/rules/codegraph.mdc`, and `AGENTS.md`. Some targets, such as Hermes Agent and global Cursor installs, only receive MCP configuration and rely on MCP server instructions or project-local wiring.

```markdown
This project has a CodeGraph MCP server (`codegraph_*` tools) configured. CodeGraph is a tree-sitter-parsed knowledge graph of symbols, edges, and files. Reads are sub-millisecond and return structural context grep cannot.

Use codegraph as the first pass for structural questions: what calls what, what would break, where X is defined, and what X's signature is.

Use native grep/read for literal text queries: string contents, comments, log messages, exact snippets, or after you already have a specific file open.

Verify CodeGraph results against source reads, tests, or typecheck when results are surprising, low-confidence, security/production-sensitive, or before edit-critical conclusions.

If `.codegraph/` does not exist, ask whether to run `codegraph init -i` to build the index.
```

</details>

---

## How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│                        Claude Code                               │
│                                                                  │
│  "Implement user authentication"                                 │
│           │                                                      │
│           ▼                                                      │
│  ┌─────────────────┐      ┌─────────────────┐                   │
│  │  Explore Agent  │ ──── │  Explore Agent  │                   │
│  └────────┬────────┘      └────────┬────────┘                   │
│           │                        │                             │
└───────────┼────────────────────────┼─────────────────────────────┘
            │                        │
            ▼                        ▼
┌───────────────────────────────────────────────────────────────────┐
│                     CodeGraph MCP Server                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐               │
│  │   Search    │  │   Callers   │  │   Context   │               │
│  │  "auth"     │  │  "login()"  │  │  for task   │               │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘               │
│         │                │                │                       │
│         └────────────────┼────────────────┘                       │
│                          ▼                                        │
│              ┌───────────────────────┐                            │
│              │   SQLite Graph DB     │                            │
│              │   • 387 symbols       │                            │
│              │   • 1,204 edges       │                            │
│              │   • Instant lookups   │                            │
│              └───────────────────────┘                            │
└───────────────────────────────────────────────────────────────────┘
```

1. **Extraction** — [tree-sitter](https://tree-sitter.github.io/) parses source code into ASTs. Language-specific queries extract nodes (functions, classes, methods) and edges (calls, imports, extends, implements).

2. **Storage** — Everything goes into a local SQLite database (`.codegraph/codegraph.db`) with FTS5 full-text search.

3. **Resolution** — After extraction, references are resolved: function calls → definitions, imports → source files, class inheritance, and framework-specific patterns.

4. **Auto-Sync** — The MCP server watches your project using native OS file events. Changes are debounced (2-second quiet window), filtered to source files only, and incrementally synced. The graph stays fresh as you code — no configuration needed.

---

## CLI Reference

```bash
codegraph                         # Run interactive installer
codegraph install                 # Run installer (explicit)
codegraph uninstall               # Remove CodeGraph from your agents (inverse of install)
codegraph init [path]             # Initialize in a project (--index to also index)
codegraph uninit [path]           # Remove CodeGraph from a project (--force to skip prompt)
codegraph index [path]            # Full index (--force to re-index, --quiet for less output)
codegraph sync [path]             # Incremental update
codegraph status [path]           # Show statistics
codegraph inventory [path]        # Summarize repo artifacts for rewrite planning
codegraph benchmark [path]        # Measure index and query latency (--json for reports)
codegraph query <search>          # Search symbols (--kind, --limit, --json)
codegraph files [path]            # Show file structure (--format, --filter, --max-depth, --json)
codegraph context <task>          # Build context for AI (--format, --max-nodes)
codegraph callers <symbol>        # Find what calls a function/method (--limit, --json)
codegraph callees <symbol>        # Find what a function/method calls (--limit, --json)
codegraph impact <symbol>         # Analyze what code is affected by changing a symbol (--depth, --json)
codegraph affected [files...]     # Find test files affected by changes (see below)
codegraph serve --mcp             # Start MCP server
```

### `codegraph inventory`

Summarizes rewrite-relevant repository artifacts from the current index plus
lightweight manifest/config scanning. This is the first building block for
migration, rewrite, recovery, and architecture-audit workflows where file paths
may change but packages, exported APIs, tests, routes, components, and configs
still need to be accounted for.

```bash
codegraph inventory /path/to/repo
codegraph inventory /path/to/repo --json
codegraph inventory /path/to/repo --max-artifacts 200
```

The JSON output is intentionally evidence-oriented: package manifests, config
files, route/component nodes, exported symbols, test files, and source files are
reported as stable artifacts that future multi-repo matching can compare across
old/new repos or upstream/fork rewrites.

`schemaVersion: 1` is the explicit v1 contract. Ecosystem-specific package
metadata lives under ecosystem-keyed sub-objects on `InventoryPackage`
(e.g. `npm.private`); Cargo, pyproject, and go.mod equivalents will land
under their own sub-objects (`cargo`, `python`, `go`) as the matching
metadata becomes useful.

Manifest files larger than 1 MB are skipped (returns an empty result for
that manifest) to keep the CLI safe to run on unfamiliar repositories.
Python VCS/URL dependency specifiers like `git+https://...#egg=name` are
recognized via the `#egg=` fragment; bare VCS/URL specs without `#egg=`
are dropped from the dependency list since no name is recoverable.

### `codegraph benchmark`

Measures cold indexing, warm index reuse, and, when `--query` is provided,
representative graph queries for any local repository. Use JSON output for trend
tracking across CodeGraph versions or large repos such as VS Code, PapersFlow,
or Mastra.

```bash
codegraph benchmark /path/to/repo --json                       # index/status timings
codegraph benchmark /path/to/repo --cold --force --cleanup --json
codegraph benchmark /path/to/repo \
  --query "search:createWorkflow" \
  --query "callees:createPerplexityTools" \
  --query "context:How does workflow execution run?"
```

Cold mode refuses to remove an existing `.codegraph/` index unless `--force` is
provided. `--cleanup` removes only a benchmark-owned `.codegraph/` directory; if
that directory already exists without `codegraph.db`, cleanup refuses to run
unless `--force` makes the destructive intent explicit. `--reindex` also
requires `--force` when a previous index exists.

### Edge confidence and resolver provenance

`codegraph callers` and `codegraph callees` (and their MCP counterparts
`codegraph_callers` / `codegraph_callees`) now surface the resolver
metadata stored on each graph edge so agents can distinguish strong
import/framework-resolved links from fuzzy or low-confidence matches.

Text output: each line gets a compact `[resolvedBy confidence]` suffix.
JSON output: each entry gains optional `resolvedBy` (string) and
`confidence` (number in `[0, 1]`) fields.

The `resolvedBy` values:

| Value | Meaning |
|-------|---------|
| `import` | Link followed from an import statement in the caller's file. |
| `framework` | Framework resolver (Express route → handler, etc.). |
| `qualified-name` | Fully-qualified or `Module::method` style match. |
| `exact-match` | Same-name node match; confidence varies with proximity. |
| `instance-method` | Receiver-name + method-name heuristic match. |
| `file-path` | Path-like reference resolved to a file node. |
| `fuzzy` | Last-resort lowercase-name match; lowest confidence. |

Confidence is a number in `[0, 1]`. Treat `≥ 0.9` as strong
(framework/import/qualified-name resolution the resolver is sure
about), `0.7–0.9` as likely-correct same-module matches, `0.4–0.7` as
cross-module matches worth verifying, and `< 0.4` as suggestions you
should double-check against source.

#### Scoping with `path` / `excludePath`

`codegraph_callers`, `codegraph_callees`, and `codegraph_impact` (MCP)
accept optional `path` and `excludePath` arrays of project-relative
prefixes or glob-ish patterns to constrain results to / away from
specific subtrees. Examples:

```jsonc
{ "symbol": "doSomething", "path": ["packages/api/", "apps/web/"] }
{ "symbol": "doSomething", "excludePath": ["vendor/", "**/*.test.ts"] }
```

Pattern semantics:
- `*` matches a single path segment (no `/`).
- `**` matches any depth.
- Trailing `/` makes the pattern a directory prefix.
- All other characters are matched literally (regex metacharacters are
  escaped automatically).

Filtering applies AFTER graph expansion and BEFORE ranking / output
trimming, so traversal semantics are unaffected — only what the agent
sees is scoped down. Filtered-out edges also drop out of the
PF-606b low-confidence summary so that annotation reflects the
visible scope.

#### Ranking diagnostics

`codegraph_context` accepts an optional `diagnostics: true` flag.
When set, the response includes a `Ranking Diagnostics` block listing
which path-level signals shifted the result ordering — vendor /
generated / build / source-root demotion or boost, test/spec
down-weighting. Default is off so normal responses stay compact.

Format is debug-oriented and subject to change. Treat it as a tool
for understanding why a query returned particular results; don't key
production code off the exact reason strings.

**Behavior change (PF-618):** prior versions populated the
`rankingDiagnostics` field on `TaskContext` (returned from
`buildContext(..., { format: 'json' })`) automatically whenever
path-level signals fired. With PF-618 the field is **omitted** from
the JSON payload unless `diagnostics: true` is passed. Direct
`buildContext` consumers that read the field must opt in explicitly;
MCP/CLI callers that didn't pass the flag never saw the data either
way and aren't affected.

#### Impact confidence annotation

`codegraph impact` and `codegraph_impact` (MCP) also surface a
low-confidence edge summary when the blast-radius subgraph includes
edges with `confidence < 0.5`. Text output appends a `⚠` line plus the
first few examples; JSON output adds `lowConfidenceEdges: { count,
threshold, examples }`. Treat impact results with a non-zero
`lowConfidenceEdges.count` as risk reports — the count tells you how
many edges in the impact set are weakly-resolved (fuzzy, distant
exact-match, instance-method heuristic) and need source verification
before you treat the impact as the full answer.

### MCP cross-project allowlist

When running as `codegraph serve --mcp`, the server gates the optional
`projectPath` argument every MCP tool accepts. Without configuration,
only the server's primary project root (`--path` or `rootUri`) is
allowed; tool calls that point outside it fail closed with a minimal
error that does not echo the resolved target or allowed-root paths
(probing-resistant). The structured `allowedRoots` field on the gate
result is available for server-side logging when you need it.

Add extra allowed roots when you genuinely want cross-repo queries:

```bash
codegraph serve --mcp \
  --path /repo/main \
  --allow-root /repo/secondary \
  --allow-root /repo/upstream-reference

# Or via env (':'-separated like PATH):
CODEGRAPH_MCP_ALLOW_ROOTS=/repo/secondary:/repo/upstream-reference \
  codegraph serve --mcp --path /repo/main
```

To restore the pre-PF-619 behavior (any reachable project allowed):

```bash
codegraph serve --mcp --path /repo/main --allow-any
# or
CODEGRAPH_MCP_ALLOW_ANY=1 codegraph serve --mcp --path /repo/main
```

Allowed roots are resolved through `realpath` before comparison so
symlink escapes and `..` traversal cannot smuggle a request outside
the configured roots. A request is allowed when the resolved path
equals OR is a descendant of at least one allowed root.

### `codegraph affected`

Traces import dependencies transitively to find which test files are affected by changed source files.

```bash
codegraph affected src/utils.ts src/api.ts         # Pass files as arguments
git diff --name-only | codegraph affected --stdin   # Pipe from git diff
codegraph affected src/auth.ts --filter "e2e/*"     # Custom test file pattern
```

| Option | Description | Default |
|--------|-------------|---------|
| `--stdin` | Read file list from stdin | `false` |
| `-d, --depth <n>` | Max dependency traversal depth | `5` |
| `-f, --filter <glob>` | Custom glob to identify test files | auto-detect |
| `-j, --json` | Output as JSON | `false` |
| `-q, --quiet` | Output file paths only | `false` |

**CI/hook example:**

```bash
#!/usr/bin/env bash
AFFECTED=$(git diff --name-only HEAD | codegraph affected --stdin --quiet)
if [ -n "$AFFECTED" ]; then
  npm test -- $AFFECTED
fi
```

---

## MCP Tools

When running as an MCP server, CodeGraph exposes these tools to Claude Code:

| Tool | Purpose |
|------|---------|
| `codegraph_search` | Find symbols by name across the codebase |
| `codegraph_context` | Build relevant code context for a task |
| `codegraph_callers` | Find what calls a function |
| `codegraph_callees` | Find what a function calls |
| `codegraph_impact` | Analyze what code is affected by changing a symbol |
| `codegraph_node` | Get details about a specific symbol (optionally with source code) |
| `codegraph_explore` | Return source for several related symbols grouped by file, plus a relationship map, in one call |
| `codegraph_files` | Get indexed file structure (faster than filesystem scanning) |
| `codegraph_status` | Check index health and statistics |

---

## Library Usage

```typescript
import CodeGraph from '@colbymchenry/codegraph';

const cg = await CodeGraph.init('/path/to/project');
// Or: const cg = await CodeGraph.open('/path/to/project');

await cg.indexAll({
  onProgress: (p) => console.log(`${p.phase}: ${p.current}/${p.total}`)
});

const results = cg.searchNodes('UserService');
const callers = cg.getCallers(results[0].node.id);
const context = await cg.buildContext('fix login bug', { maxNodes: 20, includeCode: true, format: 'markdown' });
const impact = cg.getImpactRadius(results[0].node.id, 2);

cg.watch();   // auto-sync on file changes
cg.unwatch(); // stop watching
cg.close();
```

---

## Configuration

There isn't any — CodeGraph is zero-config. It indexes every file whose
extension maps to a [supported language](#supported-languages) and **respects
your `.gitignore`**: in git repos via git itself, and in non-git projects by
reading `.gitignore` files directly (root and nested, the same way git would).

What that means in practice:

- Anything git ignores — `node_modules`, build output, secrets in `.env` — is
  never indexed. **To keep something out of the graph, add it to `.gitignore`.**
- CodeGraph also skips high-risk secret paths by filename without reading their
  contents: `.env` / `.env.*`, common private-key files such as `id_rsa`, and
  key material extensions such as `.key`, `.pem`, `.p8`, `.p12`, and `.pfx`.
- Source files whose basename is explicitly secret-like, such as `secrets.ts`,
  `credentials.ts`, `client.secret.ts`, or `private-key.ts`, are skipped even if
  their extension is otherwise supported. CodeGraph does not scan file contents
  for secret strings, so non-secret source should avoid those basenames.
- There's no config file to write or keep in sync, and nothing to wire up per
  language: support is automatic from the file extension.
- Files larger than 1 MB are skipped (generated bundles, minified JS, vendored
  blobs) — they cost parse budget for no useful symbols.
- `codegraph status` reports aggregate sensitive-file skip counts and categories
  only; it does not print skipped file names or contents.

> Committed files that aren't gitignored *are* indexed, even under `vendor/` or a
> committed `dist/`. If you commit a dependency or build directory you don't want
> in the graph, add it to `.gitignore`. The only built-in exception is the
> high-risk secret path policy listed above.

## Supported Platforms

Every release ships a self-contained build (bundled Node runtime — nothing to
compile) for all three desktop OSes, on both Intel/AMD (x64) and ARM (arm64):

| Platform | Architectures | Install |
|----------|---------------|---------|
| Windows | x64, arm64 | PowerShell installer or npm |
| macOS | x64, arm64 | shell installer or npm |
| Linux | x64, arm64 | shell installer or npm |

See [Get Started](#get-started) for the one-line install commands.

## Developing From Source

Use a supported Node.js release before running local validation:

```bash
nvm install
nvm use
npm ci
npm run build
npm test
npm run test:eval -- /path/to/indexed/repo
```

The source tree supports Node.js `>=22.13 <25` and pins the recommended local
version in `.nvmrc` / `.node-version`. Node 25.x is blocked by the CLI because a
V8 WASM JIT bug can crash tree-sitter grammar compilation during indexing.
Repository test scripts launch Vitest and the evaluation runner with the same
WASM-safe runtime flag used by the CLI, so prefer `npm test` /
`npm run test:eval -- <indexed-repo>` over bare `vitest` or `tsx`.
Released installs bundle their own runtime, so end users do not need this setup.

## Supported Agents

The interactive installer auto-detects and configures each of these — wiring up
the MCP server and writing its instructions file:

- **Claude Code**
- **Cursor**
- **Codex CLI**
- **opencode**
- **Hermes Agent**

## Supported Languages

| Language | Extension | Status |
|----------|-----------|--------|
| TypeScript | `.ts`, `.tsx` | Full support |
| JavaScript | `.js`, `.jsx`, `.mjs` | Full support |
| Python | `.py` | Full support |
| Go | `.go` | Full support |
| Rust | `.rs` | Full support |
| Java | `.java` | Full support |
| C# | `.cs` | Full support |
| PHP | `.php` | Full support |
| Ruby | `.rb` | Full support |
| C | `.c`, `.h` | Full support |
| C++ | `.cpp`, `.hpp`, `.cc` | Full support |
| Swift | `.swift` | Full support |
| Kotlin | `.kt`, `.kts` | Full support |
| Scala | `.scala`, `.sc` | Full support (classes, traits, methods, type aliases, Scala 3 enums) |
| Dart | `.dart` | Full support |
| Svelte | `.svelte` | Full support (script extraction, Svelte 5 runes, SvelteKit routes) |
| Vue | `.vue` | Full support (script + script-setup extraction, Nuxt page/API/middleware routes) |
| Liquid | `.liquid` | Full support |
| Pascal / Delphi | `.pas`, `.dpr`, `.dpk`, `.lpr` | Full support (classes, records, interfaces, enums, DFM/FMX form files) |
| Lua | `.lua` | Full support (functions, methods with receivers, local variables, `require` imports, call edges) |
| Luau | `.luau` | Full support (everything in Lua, plus `type`/`export type` aliases, typed signatures, and Roblox instance-path `require`) |

## Troubleshooting

**"CodeGraph not initialized"** — Run `codegraph init` in your project directory first.

**Indexing is slow** — Check that `node_modules` and other large directories are excluded. Use `--quiet` to reduce output overhead.

**MCP hits `database is locked`** — current builds shouldn't: CodeGraph bundles its own Node runtime and uses Node's built-in `node:sqlite` in WAL mode, where concurrent reads never block on a writer. If you still see it:

- **You're on an old (pre-0.9) install.** Reinstall to get the bundled runtime — `curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh` (macOS/Linux), `irm https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.ps1 | iex` (Windows), or `npm i -g @colbymchenry/codegraph@latest`.
- **`codegraph status` shows `Journal:` other than `wal`** — WAL couldn't be enabled on this filesystem (common on network shares and WSL2 `/mnt`), so reads can block on writes. Move the project (with its `.codegraph/` folder) onto a local disk.

**MCP server not connecting** — Ensure the project is initialized/indexed, verify the path in your MCP config, and check that `codegraph serve --mcp` works from the command line.

**Missing symbols** — The MCP server auto-syncs on save (wait a couple seconds). Run `codegraph sync` manually if needed. Check that the file's language is supported and isn't excluded by config patterns.

## Star History

<a href="https://www.star-history.com/?repos=colbymchenry%2Fcodegraph&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=colbymchenry/codegraph&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=colbymchenry/codegraph&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=colbymchenry/codegraph&type=date&legend=top-left" />
 </picture>
</a>

## License

MIT

---

<div align="center">

**Made for AI coding agents — Claude Code, Cursor, Codex CLI, opencode, and Hermes Agent**

[Report Bug](https://github.com/colbymchenry/codegraph/issues) · [Request Feature](https://github.com/colbymchenry/codegraph/issues)

</div>
