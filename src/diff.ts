/**
 * PF-691: DB-vs-DB diff primitive.
 *
 * Compares two `.codegraph/codegraph.db` files and reports
 * structural deltas at the file, node, and edge level. Designed
 * as a primitive that other tools (codegraph_duplicates,
 * codegraph_explain, drift-detection downstream consumers) can
 * call, and exposed as the `codegraph diff` CLI subcommand.
 *
 * Council RFC outcome (Codex + agy consensus): codegraph stays
 * VCS-agnostic. The diff operates on already-built DB files; the
 * caller handles git checkouts. Calling `git stash` / `git
 * checkout` from a graph index tool would be destructive and
 * unsafe — agy called the alternative "a massive anti-pattern".
 *
 * Output shape: added / removed / changed for files, nodes, and
 * edges. For changed nodes, `changedFields` lists which tracked
 * fields differ; for changed edges, `changedFields` lists which
 * of metadata/provenance differ (PR #39 round 3 closure on the
 * "edge-metadata-not-compared" gap).
 *
 * Nodes are matched by `id` across the two databases — IDs are
 * deterministic functions of `filePath + kind + name + line` per
 * `generateNodeId`. Note: line-sensitive matching means a
 * prepended file header shifts every node ID and produces mass
 * remove/add churn rather than `changedNodes`. This is a
 * pre-existing CodeGraph design decision (not introduced here);
 * downstream consumers wanting move-stable matching should diff
 * by `(filePath, qualifiedName)` after consuming this output.
 *
 * Edges are matched by canonical identity `(source, target, kind,
 * line, col)` per the PR #17 UNIQUE INDEX. Auto-incrementing
 * edge IDs are NOT used for matching — those are per-DB
 * artifacts.
 *
 * Fingerprint coverage caveat: only tree-sitter-extracted nodes
 * carry `ast_hash`/`ast_shape_hash`/`sig_hash`. Liquid, Vue,
 * Svelte, and YAML/Drupal extractors emit nodes with NULL
 * fingerprints, so body-only changes inside those file types
 * won't surface in `changedNodes`. The diff output includes a
 * `fingerprintCoverage` field so consumers can detect when their
 * DB has gaps and treat the diff as fingerprint-blind for those
 * rows.
 */

import * as fs from 'fs';
import type { Node } from './types';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => SqliteReadOnly };

interface SqliteReadOnly {
  prepare(sql: string): { all(...args: unknown[]): unknown[]; get(...args: unknown[]): unknown };
  close(): void;
}

/**
 * Columns whose values the diff captures from the `nodes` table.
 * Each entry pairs the snake_case SQL column with the camelCase
 * field in the `Node` shape. Fingerprint columns (PR #38, schema
 * v6) are at the tail — when diffing an older v5 backup that lacks
 * those columns, `loadNodes` projects them as NULL so the rest of
 * the diff still works.
 */
const NODE_COLUMNS: ReadonlyArray<{ sql: string; field: keyof Node }> = [
  { sql: 'id', field: 'id' },
  { sql: 'kind', field: 'kind' },
  { sql: 'name', field: 'name' },
  { sql: 'qualified_name', field: 'qualifiedName' },
  { sql: 'file_path', field: 'filePath' },
  { sql: 'language', field: 'language' },
  { sql: 'start_line', field: 'startLine' },
  { sql: 'end_line', field: 'endLine' },
  { sql: 'start_column', field: 'startColumn' },
  { sql: 'end_column', field: 'endColumn' },
  { sql: 'signature', field: 'signature' },
  { sql: 'ast_hash', field: 'astHash' },
  { sql: 'ast_shape_hash', field: 'astShapeHash' },
  { sql: 'sig_hash', field: 'sigHash' },
  { sql: 'call_pattern_hash', field: 'callPatternHash' },
];

/**
 * Node-level change record. `changedFields` enumerates the
 * specific columns that differ between the old and new versions
 * — `astHash` means the function body changed; `sigHash` or
 * `signature` means the contract changed; `qualifiedName` means
 * the symbol moved within its file.
 */
export interface NodeChange {
  id: string;
  name: string;
  kind: string;
  filePath: string;
  changedFields: string[];
  old: NodeSnapshot;
  new: NodeSnapshot;
}

/**
 * Minimal snapshot of a node row carried in the diff output.
 * Excludes large/derived fields the diff doesn't compare
 * (decorators JSON, typeParameters JSON, full docstring) so the
 * JSON payload stays bounded.
 */
export interface NodeSnapshot {
  qualifiedName: string;
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
  signature?: string | null;
  astHash?: string | null;
  astShapeHash?: string | null;
  sigHash?: string | null;
  callPatternHash?: string | null;
}

/**
 * Canonical edge identity per PR #17 UNIQUE INDEX. Used as the
 * Map key when matching edges across databases. NULL line/col
 * folded to a single bucket for matching, but the public output
 * preserves `null` semantics (PR #39 round 3 NITPICK fix).
 */
export interface EdgeIdentity {
  source: string;
  target: string;
  kind: string;
  line: number | null;
  col: number | null;
}

/**
 * Edge change record — same canonical identity as `EdgeIdentity`
 * plus `changedFields` listing which of `metadata` / `provenance`
 * differs between the two rows. PR #39 round 3 added this when
 * Codex flagged that two DBs could differ in resolver provenance
 * (used by `codegraph explain`) and the diff would report
 * nothing.
 */
export interface EdgeChange extends EdgeIdentity {
  changedFields: string[];
  old: { metadata: Record<string, unknown> | null; provenance: string | null };
  new: { metadata: Record<string, unknown> | null; provenance: string | null };
}

/**
 * File-level change record. Covers add/remove/content-change at
 * the file granularity — important because adding a file with
 * zero indexed symbols (e.g., a `.json` config) would produce
 * empty node/edge deltas otherwise (PR #39 round 3 BLOCKER fix).
 */
export interface FileChange {
  path: string;
  language: string;
  contentHash?: string;
  size?: number;
  nodeCount?: number;
}

export interface FileContentChange {
  path: string;
  language: string;
  changedFields: string[];
  old: { contentHash: string; size: number; nodeCount: number };
  new: { contentHash: string; size: number; nodeCount: number };
}

export interface DiffResult {
  /** Files present in new DB but not in old. */
  addedFiles: FileChange[];
  /** Files present in old DB but not in new. */
  removedFiles: FileChange[];
  /** Files in both DBs whose content_hash / size / node_count differ. */
  changedFiles: FileContentChange[];
  /** Nodes present in new DB but not in old DB (by node ID). */
  addedNodes: NodeSnapshot[];
  /** Nodes present in old DB but not in new DB (by node ID). */
  removedNodes: NodeSnapshot[];
  /** Nodes whose ID exists in both DBs but one or more tracked
   *  fields differ. `changedFields` lists which. */
  changedNodes: NodeChange[];
  /** Edges present in new DB but not in old DB. */
  addedEdges: EdgeIdentity[];
  /** Edges present in old DB but not in new DB. */
  removedEdges: EdgeIdentity[];
  /** Edges in both DBs whose `metadata` or `provenance` differ. */
  changedEdges: EdgeChange[];
  /** Summary counts so consumers can render a quick header without
   *  walking the arrays. */
  summary: {
    addedFiles: number;
    removedFiles: number;
    changedFiles: number;
    addedNodes: number;
    removedNodes: number;
    changedNodes: number;
    addedEdges: number;
    removedEdges: number;
    changedEdges: number;
  };
  /**
   * Fingerprint coverage on each side, so consumers can tell
   * whether body-level changes for synthesized-extractor file
   * types (Liquid/Vue/Svelte/YAML) might be silently absent from
   * `changedNodes`. `nodesWithAstHash / totalNodes` per DB.
   */
  fingerprintCoverage: {
    old: { totalNodes: number; nodesWithAstHash: number };
    new: { totalNodes: number; nodesWithAstHash: number };
  };
}

function snapshotNode(n: Node): NodeSnapshot {
  return {
    qualifiedName: n.qualifiedName,
    filePath: n.filePath,
    startLine: n.startLine,
    endLine: n.endLine,
    language: n.language,
    signature: n.signature ?? null,
    astHash: n.astHash ?? null,
    astShapeHash: n.astShapeHash ?? null,
    sigHash: n.sigHash ?? null,
    callPatternHash: n.callPatternHash ?? null,
  };
}

/**
 * Field names whose changes are tracked in `NodeChange.changedFields`.
 * Adding a field here requires updating the JSON schema downstream
 * tools validate against — keep this list stable.
 */
const TRACKED_FIELDS = [
  'qualifiedName',
  'filePath',
  'startLine',
  'endLine',
  'language',
  'signature',
  'astHash',
  'astShapeHash',
  'sigHash',
  'callPatternHash',
] as const;

function nodeChangedFields(oldN: Node, newN: Node): string[] {
  const changed: string[] = [];
  const oldRec = oldN as unknown as Record<string, unknown>;
  const newRec = newN as unknown as Record<string, unknown>;
  for (const f of TRACKED_FIELDS) {
    const a = oldRec[f] ?? null;
    const b = newRec[f] ?? null;
    if (a !== b) changed.push(f);
  }
  return changed;
}

/**
 * Sentinel used INSIDE the Map key so NULL line/col fold to a
 * single bucket matching the PF-625 UNIQUE INDEX. Never leaks
 * into the public output — `edgeIdentityForOutput` translates
 * back to `null`.
 */
const NULL_SENTINEL = -1;

function edgeIdentityKey(row: { source: string; target: string; kind: string; line: number | null; col: number | null }): string {
  const line = row.line ?? NULL_SENTINEL;
  const col = row.col ?? NULL_SENTINEL;
  return `${row.source}\x1f${row.target}\x1f${row.kind}\x1f${line}\x1f${col}`;
}

function edgeIdentityForOutput(row: {
  source: string;
  target: string;
  kind: string;
  line: number | null;
  col: number | null;
}): EdgeIdentity {
  return {
    source: row.source,
    target: row.target,
    kind: row.kind,
    line: row.line,
    col: row.col,
  };
}

interface EdgeRow {
  source: string;
  target: string;
  kind: string;
  line: number | null;
  col: number | null;
  metadata: string | null;
  provenance: string | null;
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

/**
 * Open a `.codegraph/codegraph.db` in true read-only, immutable
 * mode. Avoids the production `DatabaseConnection.open` path,
 * which sets `journal_mode = WAL` and runs forward migrations —
 * both mutate the file on disk, defeating the point of comparing
 * two historical snapshots (Codex pass 1 BLOCKER, PR #39).
 *
 * Uses the SQLite `file:…?immutable=1` URI flag rather than just
 * `readOnly: true` because a WAL-mode DB opened only read-only
 * still requires SQLite to create `-shm`/`-wal` shared-memory
 * sidecars to coordinate readers. `immutable=1` tells SQLite the
 * file will never change, so it skips all locking and sidecar
 * creation entirely — diffing a DB leaves the directory bit-for-
 * bit unchanged.
 *
 * Wraps SQLite-level errors so a random text file with a `.db`
 * extension produces a "not a valid SQLite database" message
 * instead of the raw SQLITE_NOTADB error (PR #39 round 3 REVIEW
 * fix).
 */
function openReadOnly(dbPath: string): SqliteReadOnly {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database not found: ${dbPath}`);
  }
  // Per SQLite URI rules, `?`, `#`, and `%` in a file path must be
  // percent-encoded; everything else passes through. encodeURI()
  // leaves the path separator `/` alone but doesn't touch `?`/`#`,
  // so handle those explicitly. CodeGraph DB paths in practice
  // don't contain these characters, but defending the URI parser
  // is cheaper than guessing.
  const escaped = dbPath.replace(/%/g, '%25').replace(/\?/g, '%3F').replace(/#/g, '%23');
  try {
    const db = new DatabaseSync(`file:${escaped}?immutable=1`, { readOnly: true });
    // node:sqlite opens lazily — a non-SQLite file only errors when
    // the first statement runs. Force that here so the "Invalid
    // CodeGraph database" wrap is the surface error rather than
    // a raw "file is not a database" leaking out of deep query code.
    db.prepare('SELECT 1').get();
    return db;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid CodeGraph database at ${dbPath}: ${msg}`);
  }
}

/**
 * Probe the `nodes` table for which columns physically exist. The
 * fingerprint columns (`ast_hash`, `ast_shape_hash`, `sig_hash`,
 * `call_pattern_hash`) were added in schema v6 (PR #38); a v5
 * backup won't have them. Returns the set of column names present
 * so `loadNodes` can build a SELECT that projects missing columns
 * as NULL instead of failing with `no such column`.
 */
function nodeColumnsPresent(db: SqliteReadOnly): Set<string> {
  const rows = db.prepare(`PRAGMA table_info('nodes')`).all() as Array<{ name: string }>;
  if (rows.length === 0) {
    throw new Error('Database has no `nodes` table — not a CodeGraph database, or corrupt.');
  }
  return new Set(rows.map((r) => r.name));
}

/**
 * Map every node row from `db` (raw shape) into a `Node` object so
 * downstream comparison uses the same field names the rest of the
 * codebase does. Builds the SELECT dynamically against the columns
 * that physically exist in this DB, so a v5 backup (no fingerprint
 * columns) loads cleanly with null fingerprints — fingerprint
 * fields just won't surface in `changedFields` for those rows.
 */
function loadNodes(db: SqliteReadOnly): Map<string, Node> {
  const present = nodeColumnsPresent(db);
  const projections = NODE_COLUMNS.map(({ sql }) =>
    present.has(sql) ? sql : `NULL AS ${sql}`,
  ).join(', ');
  const rows = db.prepare(`SELECT ${projections} FROM nodes`).all() as Array<Record<string, unknown>>;
  const out = new Map<string, Node>();
  for (const r of rows) {
    out.set(r.id as string, {
      id: r.id as string,
      kind: r.kind as Node['kind'],
      name: r.name as string,
      qualifiedName: r.qualified_name as string,
      filePath: r.file_path as string,
      language: r.language as Node['language'],
      startLine: r.start_line as number,
      endLine: r.end_line as number,
      startColumn: (r.start_column as number | null) ?? 0,
      endColumn: (r.end_column as number | null) ?? 0,
      signature: (r.signature as string | null) ?? undefined,
      astHash: r.ast_hash as string | null,
      astShapeHash: r.ast_shape_hash as string | null,
      sigHash: r.sig_hash as string | null,
      callPatternHash: r.call_pattern_hash as string | null,
      updatedAt: 0, // not tracked in diff
    });
  }
  return out;
}

/**
 * Load full edge rows (not just identities) so the matched-edge
 * comparison path can detect `metadata` / `provenance` drift.
 * Keyed by canonical-identity string so `changedEdges` can pair
 * old and new rows by the same shape as added/removed.
 */
function loadEdges(db: SqliteReadOnly): Map<string, EdgeRow> {
  const rows = db
    .prepare('SELECT source, target, kind, line, col, metadata, provenance FROM edges')
    .all() as Array<{
    source: string;
    target: string;
    kind: string;
    line: number | null;
    col: number | null;
    metadata: string | null;
    provenance: string | null;
  }>;
  const out = new Map<string, EdgeRow>();
  for (const r of rows) {
    out.set(edgeIdentityKey(r), r);
  }
  return out;
}

interface FileRow {
  path: string;
  content_hash: string;
  language: string;
  size: number;
  node_count: number;
}

function loadFiles(db: SqliteReadOnly): Map<string, FileRow> {
  const rows = db
    .prepare('SELECT path, content_hash, language, size, node_count FROM files')
    .all() as FileRow[];
  const out = new Map<string, FileRow>();
  for (const r of rows) out.set(r.path, r);
  return out;
}

function fileSnapshot(r: FileRow): FileChange {
  return {
    path: r.path,
    language: r.language,
    contentHash: r.content_hash,
    size: r.size,
    nodeCount: r.node_count,
  };
}

function countFingerprintCoverage(nodes: Map<string, Node>): { totalNodes: number; nodesWithAstHash: number } {
  let withHash = 0;
  for (const n of nodes.values()) {
    if (n.astHash) withHash++;
  }
  return { totalNodes: nodes.size, nodesWithAstHash: withHash };
}

/**
 * Stable string form for `metadata` / `provenance` comparison.
 * Re-serializes parsed metadata so semantically-identical JSON
 * with different key order or whitespace compares equal.
 */
function metadataKey(metadata: Record<string, unknown> | null): string {
  if (metadata === null) return '';
  const keys = Object.keys(metadata).sort();
  const sorted: Record<string, unknown> = {};
  for (const k of keys) sorted[k] = metadata[k];
  return JSON.stringify(sorted);
}

function edgeChangedFields(oldRow: EdgeRow, newRow: EdgeRow): string[] {
  const changed: string[] = [];
  if (metadataKey(parseMetadata(oldRow.metadata)) !== metadataKey(parseMetadata(newRow.metadata))) {
    changed.push('metadata');
  }
  if ((oldRow.provenance ?? null) !== (newRow.provenance ?? null)) {
    changed.push('provenance');
  }
  return changed;
}

/**
 * Compute structural diff between two `.codegraph/codegraph.db`
 * files. Both DBs are opened in true SQLite read-only mode — no
 * WAL switch, no migrations, no `-shm`/`-wal` sidecar creation —
 * so diffing arbitrary historical backups never mutates them. v5
 * backups (pre-PR #38) are supported transparently: missing
 * fingerprint columns project as NULL and simply don't appear in
 * `changedFields` for those rows.
 */
export function diffDatabases(oldDbPath: string, newDbPath: string): DiffResult {
  const oldDb = openReadOnly(oldDbPath);
  // If opening the new DB throws, close the already-opened old DB
  // before propagating — otherwise the SQLite handle leaks (Codex
  // PR review P2 finding).
  let newDb: SqliteReadOnly;
  try {
    newDb = openReadOnly(newDbPath);
  } catch (err) {
    oldDb.close();
    throw err;
  }
  try {
    const oldNodes = loadNodes(oldDb);
    const newNodes = loadNodes(newDb);

    const addedNodes: NodeSnapshot[] = [];
    const removedNodes: NodeSnapshot[] = [];
    const changedNodes: NodeChange[] = [];

    for (const [id, n] of newNodes) {
      const oldN = oldNodes.get(id);
      if (!oldN) {
        addedNodes.push(snapshotNode(n));
        continue;
      }
      const fields = nodeChangedFields(oldN, n);
      if (fields.length > 0) {
        changedNodes.push({
          id,
          name: n.name,
          kind: n.kind,
          filePath: n.filePath,
          changedFields: fields,
          old: snapshotNode(oldN),
          new: snapshotNode(n),
        });
      }
    }
    for (const [id, n] of oldNodes) {
      if (!newNodes.has(id)) {
        removedNodes.push(snapshotNode(n));
      }
    }

    const oldEdges = loadEdges(oldDb);
    const newEdges = loadEdges(newDb);
    const addedEdges: EdgeIdentity[] = [];
    const removedEdges: EdgeIdentity[] = [];
    const changedEdges: EdgeChange[] = [];
    for (const [key, e] of newEdges) {
      const oldRow = oldEdges.get(key);
      if (!oldRow) {
        addedEdges.push(edgeIdentityForOutput(e));
        continue;
      }
      const fields = edgeChangedFields(oldRow, e);
      if (fields.length > 0) {
        changedEdges.push({
          ...edgeIdentityForOutput(e),
          changedFields: fields,
          old: { metadata: parseMetadata(oldRow.metadata), provenance: oldRow.provenance },
          new: { metadata: parseMetadata(e.metadata), provenance: e.provenance },
        });
      }
    }
    for (const [key, e] of oldEdges) {
      if (!newEdges.has(key)) removedEdges.push(edgeIdentityForOutput(e));
    }

    const oldFiles = loadFiles(oldDb);
    const newFiles = loadFiles(newDb);
    const addedFiles: FileChange[] = [];
    const removedFiles: FileChange[] = [];
    const changedFiles: FileContentChange[] = [];
    for (const [path, f] of newFiles) {
      const oldF = oldFiles.get(path);
      if (!oldF) {
        addedFiles.push(fileSnapshot(f));
        continue;
      }
      const fields: string[] = [];
      if (oldF.content_hash !== f.content_hash) fields.push('contentHash');
      if (oldF.size !== f.size) fields.push('size');
      if (oldF.node_count !== f.node_count) fields.push('nodeCount');
      if (fields.length > 0) {
        changedFiles.push({
          path,
          language: f.language,
          changedFields: fields,
          old: { contentHash: oldF.content_hash, size: oldF.size, nodeCount: oldF.node_count },
          new: { contentHash: f.content_hash, size: f.size, nodeCount: f.node_count },
        });
      }
    }
    for (const [path, f] of oldFiles) {
      if (!newFiles.has(path)) removedFiles.push(fileSnapshot(f));
    }

    return {
      addedFiles,
      removedFiles,
      changedFiles,
      addedNodes,
      removedNodes,
      changedNodes,
      addedEdges,
      removedEdges,
      changedEdges,
      summary: {
        addedFiles: addedFiles.length,
        removedFiles: removedFiles.length,
        changedFiles: changedFiles.length,
        addedNodes: addedNodes.length,
        removedNodes: removedNodes.length,
        changedNodes: changedNodes.length,
        addedEdges: addedEdges.length,
        removedEdges: removedEdges.length,
        changedEdges: changedEdges.length,
      },
      fingerprintCoverage: {
        old: countFingerprintCoverage(oldNodes),
        new: countFingerprintCoverage(newNodes),
      },
    };
  } finally {
    oldDb.close();
    newDb.close();
  }
}
