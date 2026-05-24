/**
 * PF-691: DB-vs-DB diff primitive.
 *
 * Compares two `.codegraph/codegraph.db` files and reports
 * structural deltas at the node + edge level. Designed as a
 * primitive that other tools (codegraph_duplicates,
 * codegraph_explain, drift-detection downstream consumers) can
 * call, and exposed as the `codegraph diff` CLI subcommand.
 *
 * Council RFC outcome (Codex + agy consensus): codegraph stays
 * VCS-agnostic. The diff operates on already-built DB files; the
 * caller handles git checkouts. Calling `git stash` / `git
 * checkout` from a graph index tool would be destructive and
 * unsafe — agy called the alternative "a massive anti-pattern".
 *
 * Output shape: added / removed / changed for both nodes and
 * edges. For changed nodes, the `changedFields` array lists which
 * specific fields differ — `astHash`, `sigHash`, `signature`,
 * `qualifiedName`, etc. Downstream drift tools key off these
 * field names to classify the kind of drift (body change vs
 * contract change vs rename).
 *
 * Nodes are matched by `id` across the two databases — IDs are
 * deterministic functions of `filePath + qualifiedName + line`
 * per `generateNodeId`, so a node that didn't move retains the
 * same ID across reindexes. Renames or file moves naturally
 * surface as "removed in old" + "added in new" pairs.
 *
 * Edges are matched by canonical identity `(source, target, kind,
 * line, col)` per the PR #17 UNIQUE INDEX. Auto-incrementing
 * edge IDs are NOT used for matching — those are per-DB
 * artifacts.
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
 * collapse to a single bucket via `COALESCE(line, -1)` semantics
 * so file-level imports + synthesized re-export edges match
 * cleanly.
 */
export interface EdgeIdentity {
  source: string;
  target: string;
  kind: string;
  line: number; // -1 when NULL
  col: number; // -1 when NULL
}

export interface DiffResult {
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
  /** Summary counts so consumers can render a quick header without
   *  walking the arrays. */
  summary: {
    addedNodes: number;
    removedNodes: number;
    changedNodes: number;
    addedEdges: number;
    removedEdges: number;
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

function edgeIdentityKey(e: EdgeIdentity): string {
  return `${e.source}\x1f${e.target}\x1f${e.kind}\x1f${e.line}\x1f${e.col}`;
}

function edgeRowToIdentity(row: {
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
    line: row.line ?? -1,
    col: row.col ?? -1,
  };
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
 * The file existence check is explicit so the error string stays
 * `not found` (the diff test relies on this) regardless of
 * whatever lower-level SQLite error a missing path would produce.
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
  return new DatabaseSync(`file:${escaped}?immutable=1`, { readOnly: true });
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
      startColumn: r.start_column as number,
      endColumn: r.end_column as number,
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

function loadEdgeIdentities(db: SqliteReadOnly): Map<string, EdgeIdentity> {
  const rows = db.prepare('SELECT source, target, kind, line, col FROM edges').all() as Array<{
    source: string;
    target: string;
    kind: string;
    line: number | null;
    col: number | null;
  }>;
  const out = new Map<string, EdgeIdentity>();
  for (const r of rows) {
    const id = edgeRowToIdentity(r);
    out.set(edgeIdentityKey(id), id);
  }
  return out;
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
  const newDb = openReadOnly(newDbPath);
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

    const oldEdges = loadEdgeIdentities(oldDb);
    const newEdges = loadEdgeIdentities(newDb);
    const addedEdges: EdgeIdentity[] = [];
    const removedEdges: EdgeIdentity[] = [];
    for (const [key, e] of newEdges) {
      if (!oldEdges.has(key)) addedEdges.push(e);
    }
    for (const [key, e] of oldEdges) {
      if (!newEdges.has(key)) removedEdges.push(e);
    }

    return {
      addedNodes,
      removedNodes,
      changedNodes,
      addedEdges,
      removedEdges,
      summary: {
        addedNodes: addedNodes.length,
        removedNodes: removedNodes.length,
        changedNodes: changedNodes.length,
        addedEdges: addedEdges.length,
        removedEdges: removedEdges.length,
      },
    };
  } finally {
    oldDb.close();
    newDb.close();
  }
}
