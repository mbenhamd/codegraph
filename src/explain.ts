/**
 * PF-693: `codegraph explain` — single-edge resolution trace.
 *
 * Third consumer of the CLI envelope/cli-tools family added in
 * PRs #39 (diff) and #40 (duplicates). Answers the question
 * "WHY does codegraph think this edge resolves here?" by
 * surfacing every persisted provenance breadcrumb:
 *
 *   - The edge itself (source, target, kind, line, col)
 *   - The source node (qualifiedName, filePath, startLine)
 *   - The target node (qualifiedName, filePath, startLine)
 *   - Extractor provenance: the `edges.provenance` column
 *     (tree-sitter / scip / heuristic — which extractor laid
 *     down the reference in the first place)
 *   - Resolver provenance: the `metadata.resolvedBy` strategy
 *     tag (import / framework / qualified-name / exact-match /
 *     instance-method / file-path / fuzzy) and `metadata.confidence`
 *   - The raw metadata JSON for forward-compatible inspection
 *
 * Council RFC outcome (Codex):
 *   - Fork A: accept BOTH a positional integer `edgeId` and
 *     canonical `--source/--target/--kind/--line/--col` flags.
 *     Edge ids are index-local (reset on rebuild) but the happy
 *     path from callers/callees JSON output is excellent;
 *     canonical flags are the rebuild-stable form.
 *   - Fork D: `--rerun` is OUT of scope — re-resolution requires
 *     loading the parser + extractors + resolver chain, which is
 *     a different diagnostic mode with its own flake surface.
 *   - Fork E: canonical lookups error on ambiguity with a clear
 *     "use --line N --col N" hint. Explain explains ONE edge.
 *
 * Schema gate: no hard v6 requirement. The `provenance`, `metadata`,
 * `line`, `col` columns existed in v5. We tolerate missing resolver
 * metadata by returning `resolvedBy: null` + `confidence: null`.
 * Only a truly non-CodeGraph DB (missing `edges` table) fails.
 *
 * Read-only safety: `pathToFileURL(dbPath).href + '?immutable=1'`,
 * the same pattern locked in by PRs #39 and #40 — prevents
 * `-shm`/`-wal` sidecar creation even on WAL-mode DBs.
 */

import * as fs from 'fs';
import { pathToFileURL } from 'url';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (
    path: string,
    opts?: { readOnly?: boolean },
  ) => SqliteReadOnly;
};

interface SqliteReadOnly {
  prepare(sql: string): {
    all(...args: unknown[]): unknown[];
    get(...args: unknown[]): unknown;
  };
  close(): void;
}

/**
 * Minimal node snapshot — only the fields a user needs to
 * orient themselves at the call site or the target. Kept narrow
 * so the JSON payload stays bounded.
 */
export interface ExplainNode {
  id: string;
  qualifiedName: string;
  filePath: string;
  startLine: number;
  language: string;
  kind: string;
}

export interface ExplainResult {
  /** Edge primary key (integer, index-local — not stable across rebuilds). */
  edgeId: number;
  source: string;
  target: string;
  kind: string;
  line: number | null;
  col: number | null;
  /** Source extractor tag from `edges.provenance` column. */
  extractorProvenance: string | null;
  /** Resolver strategy tag from `metadata.resolvedBy`. */
  resolvedBy: string | null;
  /** Resolver confidence ∈ [0, 1], from `metadata.confidence`. */
  confidence: number | null;
  /** Full `metadata` JSON for forward-compatible inspection. */
  metadata: Record<string, unknown> | null;
  /** Source node, when the row still exists. Hard FK guarantees
   *  this in v6, but defend against rare orphan rows. */
  sourceNode: ExplainNode | null;
  /** Target node, same caveat. */
  targetNode: ExplainNode | null;
}

/**
 * Canonical-identity lookup. `kind` is required because (source,
 * target) alone is not actually canonical — the same pair can be
 * connected by `calls` AND `references` edges simultaneously, and
 * "the canonical form" should disambiguate before lookup, not
 * fall through to the ambiguity error. `line` and `col` remain
 * optional disambiguators for multi-call-site cases.
 */
export interface ExplainCanonical {
  source: string;
  target: string;
  kind: string;
  line?: number;
  col?: number;
}

interface EdgeRow {
  id: number;
  source: string;
  target: string;
  kind: string;
  metadata: string | null;
  line: number | null;
  col: number | null;
  provenance: string | null;
}

interface NodeRow {
  id: string;
  qualified_name: string;
  file_path: string;
  start_line: number;
  language: string;
  kind: string;
}

function openReadOnly(dbPath: string): SqliteReadOnly {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database not found: ${dbPath}`);
  }
  const uri = pathToFileURL(dbPath).href + '?immutable=1';
  return new DatabaseSync(uri, { readOnly: true });
}

/**
 * Reject DBs that don't have the CodeGraph `edges` AND `nodes`
 * tables (i.e. not a CodeGraph database). The resolver metadata
 * columns (provenance, metadata) have existed since v5, so no v6
 * gate is needed.
 *
 * Checking both tables avoids false-positives on arbitrary SQLite
 * DBs that happen to have a table named `edges` — without `nodes`
 * the source/target lookups would fail later with a less helpful
 * error.
 */
function assertCodeGraphDb(db: SqliteReadOnly): void {
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('edges', 'nodes')`,
    )
    .all() as Array<{ name: string }>;
  const present = new Set(tables.map((t) => t.name));
  if (!present.has('edges') || !present.has('nodes')) {
    throw new Error('Database has no `edges`/`nodes` tables — not a CodeGraph database, or corrupt.');
  }
}

function rowToNode(r: NodeRow | undefined): ExplainNode | null {
  if (!r) return null;
  return {
    id: r.id,
    qualifiedName: r.qualified_name,
    filePath: r.file_path,
    startLine: r.start_line,
    language: r.language,
    kind: r.kind,
  };
}

function parseMetadata(raw: string | null): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return null;
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function edgeToResult(db: SqliteReadOnly, edge: EdgeRow): ExplainResult {
  const metadata = parseMetadata(edge.metadata);
  let resolvedBy: string | null = null;
  let confidence: number | null = null;
  if (metadata) {
    if (typeof metadata.resolvedBy === 'string') resolvedBy = metadata.resolvedBy;
    // Confidence is a probability ∈ [0, 1] per the resolver contract;
    // values outside that range or non-finite are dropped to null so
    // the top-level `confidence` field always validates against the
    // JSON schema's bounded type.
    if (
      typeof metadata.confidence === 'number' &&
      Number.isFinite(metadata.confidence) &&
      metadata.confidence >= 0 &&
      metadata.confidence <= 1
    ) {
      confidence = metadata.confidence;
    }
  }

  const nodeStmt = db.prepare(
    `SELECT id, qualified_name, file_path, start_line, language, kind FROM nodes WHERE id = ?`,
  );
  const sourceNode = rowToNode(nodeStmt.get(edge.source) as NodeRow | undefined);
  const targetNode = rowToNode(nodeStmt.get(edge.target) as NodeRow | undefined);

  return {
    edgeId: edge.id,
    source: edge.source,
    target: edge.target,
    kind: edge.kind,
    line: edge.line,
    col: edge.col,
    extractorProvenance: edge.provenance,
    resolvedBy,
    confidence,
    metadata,
    sourceNode,
    targetNode,
  };
}

/**
 * Look up an edge by its `edges.id` primary key. Throws if no
 * edge has that id — the user almost certainly copy-pasted the
 * wrong value or is looking at output from a since-rebuilt DB.
 */
export function explainEdgeById(dbPath: string, edgeId: number): ExplainResult {
  if (!Number.isInteger(edgeId) || edgeId < 1) {
    throw new Error(`edgeId must be a positive integer, got: ${edgeId}`);
  }
  const db = openReadOnly(dbPath);
  try {
    assertCodeGraphDb(db);
    const row = db
      .prepare('SELECT id, source, target, kind, metadata, line, col, provenance FROM edges WHERE id = ?')
      .get(edgeId) as EdgeRow | undefined;
    if (!row) {
      throw new Error(
        `No edge with id ${edgeId} in this index. Edge ids reset on rebuild — re-fetch from \`codegraph callers --json\`.`,
      );
    }
    return edgeToResult(db, row);
  } finally {
    db.close();
  }
}

/**
 * Look up an edge by its canonical (source, target, kind, line,
 * col) identity. Per RFC fork E, ambiguity is an error with a
 * hint to disambiguate via `--line N --col N` — `explain`
 * explains ONE edge.
 */
export function explainEdgeByCanonical(
  dbPath: string,
  ident: ExplainCanonical,
): ExplainResult {
  const db = openReadOnly(dbPath);
  try {
    assertCodeGraphDb(db);

    const where: string[] = ['source = ?', 'target = ?', 'kind = ?'];
    const params: Array<string | number> = [ident.source, ident.target, ident.kind];
    if (ident.line !== undefined) {
      where.push('line = ?');
      params.push(ident.line);
    }
    if (ident.col !== undefined) {
      where.push('col = ?');
      params.push(ident.col);
    }

    const rows = db
      .prepare(
        `SELECT id, source, target, kind, metadata, line, col, provenance
         FROM edges
         WHERE ${where.join(' AND ')}
         ORDER BY line, col, id`,
      )
      .all(...params) as EdgeRow[];

    if (rows.length === 0) {
      throw new Error(
        `No edge matches source=${ident.source}, target=${ident.target}, kind=${ident.kind}${
          ident.line !== undefined ? `, line=${ident.line}` : ''
        }${ident.col !== undefined ? `, col=${ident.col}` : ''}.`,
      );
    }
    if (rows.length > 1) {
      const sample = rows
        .slice(0, 5)
        .map((r) => `id=${r.id} line=${r.line ?? 'null'} col=${r.col ?? 'null'}`)
        .join('; ');
      throw new Error(
        `Ambiguous: ${rows.length} edges match. Disambiguate with --line N --col N. ` +
          `First matches: ${sample}.`,
      );
    }
    return edgeToResult(db, rows[0] as EdgeRow);
  } finally {
    db.close();
  }
}

/**
 * Render a concise human-readable narrative of an `ExplainResult`
 * for terminal output. The JSON payload remains the durable
 * contract; this helper just makes the common "why this edge?"
 * debugging case readable without piping through `jq`.
 */
export function formatExplainNarrative(r: ExplainResult): string {
  const at = r.line !== null ? `:${r.line}${r.col !== null ? `:${r.col}` : ''}` : '';
  const srcLabel = r.sourceNode
    ? `${r.sourceNode.qualifiedName} (${r.sourceNode.filePath}${at})`
    : r.source;
  const tgtLabel = r.targetNode
    ? `${r.targetNode.qualifiedName} (${r.targetNode.filePath}:${r.targetNode.startLine})`
    : r.target;
  const confidence =
    r.confidence !== null ? r.confidence.toFixed(2) : 'unknown';
  const resolvedBy = r.resolvedBy ?? 'unknown';
  const extractor = r.extractorProvenance ?? 'unknown';
  return (
    `edge #${r.edgeId} [${r.kind}]\n` +
    `  ${srcLabel}\n` +
    `  → ${tgtLabel}\n` +
    `  resolver:   ${resolvedBy} (confidence ${confidence})\n` +
    `  extractor:  ${extractor}`
  );
}
