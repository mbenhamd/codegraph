/**
 * PF-692: clone detection primitive over PF-690 fingerprint columns.
 *
 * Groups symbols by `ast_hash` (Type-1 — exact, rename-locals
 * normalized) and `ast_shape_hash` (Type-2 — structure-only) and
 * reports clone-sets. Designed as the second consumer of the
 * fingerprint columns landed in PR #38; the first was `codegraph
 * diff` (PR #39).
 *
 * Surface and defaults are locked by council RFC (Codex):
 *   - `--kind` defaults to `function,method`. Class-level clones
 *     are often framework-shaped duplicates and noisier than
 *     useful at this layer.
 *   - `--min-lines` defaults to 10. This is the standard CPD/jscpd
 *     floor — filters one-liner accessors / validators / wrappers
 *     that would flood the output and make the tool feel broken.
 *   - Shape groups whose member set EQUALS an exact group are
 *     suppressed. A Type-1 clone is by definition also a Type-2
 *     clone, so reporting both inflates the summary and adds no
 *     new information. Genuine Type-2 findings — groups whose
 *     members include at least one symbol that no exact-hash
 *     neighbor shares — are kept.
 *   - Groups sort by `len(members) DESC`, then by maximum line
 *     span DESC (largest individual symbol within the group),
 *     then by fingerprint ASC for stable output.
 *   - Uses `endLine - startLine + 1` for the size filter — an
 *     approximate, language-agnostic line count read straight off
 *     the indexed `nodes` row. Blank/comment lines inside the body
 *     count toward the threshold; an exact non-blank/non-comment
 *     count would require a source rescan and isn't worth it for
 *     a coarse noise filter.
 *
 * Read-only safety: opens the DB via `file:…?immutable=1` URI
 * (Codex BLOCKER from PR #39 round 1; same fix here). The diff
 * tool already proved this avoids `-shm`/`-wal` sidecar creation
 * even on WAL-mode DBs. v5 DBs (pre-PR #38, no fingerprint
 * columns) fail with a clear "requires schema v6+" message
 * instead of producing empty groups silently.
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

/** Default kinds when `--kind` is omitted. Locked by RFC. */
export const DEFAULT_DUPLICATE_KINDS: ReadonlyArray<string> = ['function', 'method'];

/** Default minimum line span for a clone to count. Locked by RFC. */
export const DEFAULT_MIN_LINES = 10;

/** Hash group kinds we emit. */
export type DuplicateGroupKind = 'exact' | 'shape';

/**
 * A single symbol participating in a clone group. Columns are
 * kept narrow — the diff schema already proved these are the
 * fields downstream consumers actually want.
 */
export interface DuplicateMember {
  id: string;
  qualifiedName: string;
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
  symbolKind: string;
}

/**
 * A clone group — two or more symbols that share the same
 * fingerprint after the size and kind filters apply.
 */
export interface DuplicateGroup {
  kind: DuplicateGroupKind;
  fingerprint: string;
  members: DuplicateMember[];
  /**
   * Distinct file count across all members. Lets consumers
   * distinguish "two implementations of the same function in
   * different files" (likely refactor candidate) from "an
   * accessor pattern repeated in the same class" (often
   * legitimate). PR #40 round 2 REVIEW fix.
   */
  fileCount: number;
  /**
   * For Type-2 shape groups: indicates whether at least one of
   * this group's members ALSO belongs to a Type-1 exact group
   * with the same body. Lets users see "this shape group exists
   * because A and B are exact-identical AND C has the same shape
   * but different exact hash". Always `false` for exact (Type-1)
   * groups. PR #40 round 2 REVIEW fix.
   */
  coveredByExactGroup: boolean;
}

export interface DuplicatesOptions {
  /** Symbol kinds to include. Defaults to function + method. */
  kinds?: ReadonlyArray<string>;
  /** Minimum `endLine - startLine + 1` to keep a row. Defaults to 10. */
  minLines?: number;
}

export interface DuplicatesResult {
  groups: DuplicateGroup[];
  summary: {
    exactGroups: number;
    shapeGroups: number;
    exactNodes: number;
    shapeNodes: number;
    /**
     * Fingerprint coverage at the time of this query: how many
     * nodes (matching the requested kinds + min-lines) carry an
     * astHash vs how many are eligible. Surfaced so consumers can
     * tell whether a "no duplicates" result is real or an
     * artefact of partial coverage.
     */
    fingerprintCoverage: FingerprintCoverageRow;
  };
}

interface NodeRow {
  id: string;
  qualified_name: string;
  file_path: string;
  start_line: number;
  end_line: number;
  language: string;
  kind: string;
  ast_hash: string | null;
  ast_shape_hash: string | null;
}

function openReadOnly(dbPath: string): SqliteReadOnly {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database not found: ${dbPath}`);
  }
  // `pathToFileURL` is the canonical Node API for "filesystem path
  // → `file://` URL" — it correctly percent-encodes spaces, `?`,
  // `#`, `%`, non-ASCII codepoints, and Windows drive letters, all
  // of which the hand-rolled escape in `diff.ts` would miss. Same
  // `immutable=1` flag tells SQLite to skip locking + sidecar
  // creation entirely.
  const uri = pathToFileURL(dbPath).href + '?immutable=1';
  return new DatabaseSync(uri, { readOnly: true });
}

/**
 * Reject v5 databases up front so users see a clear message
 * instead of an empty `groups` array. The fingerprint columns
 * are NULL on v5 rows, so a naive query would silently return
 * nothing and look broken.
 */
function assertSchemaSupportsFingerprints(db: SqliteReadOnly): void {
  const cols = db.prepare(`PRAGMA table_info('nodes')`).all() as Array<{ name: string }>;
  if (cols.length === 0) {
    throw new Error('Database has no `nodes` table — not a CodeGraph database, or corrupt.');
  }
  const names = new Set(cols.map((c) => c.name));
  if (!names.has('ast_hash') || !names.has('ast_shape_hash')) {
    throw new Error(
      'duplicates requires schema v6+ (PR #38 fingerprint columns). Re-run `codegraph index` to upgrade this DB.',
    );
  }
}

/**
 * Coverage report for the requested kinds — how many eligible
 * nodes carry fingerprints. Migrating to v6 only ADDED the
 * columns; existing rows stay NULL until re-extracted (see
 * `migrations.ts`). A user running `codegraph duplicates` on a
 * migrated-but-not-reindexed DB would see "no duplicates" and
 * think their code is clone-free, when really the index is just
 * blind. Surface the gap as an explicit error rather than a
 * silent empty result (PR #40 round 2 BLOCKER fix).
 */
export interface FingerprintCoverageRow {
  eligible: number;
  withAstHash: number;
}

function fingerprintCoverage(
  db: SqliteReadOnly,
  kinds: ReadonlyArray<string>,
  minLines: number,
): FingerprintCoverageRow {
  const { sql: kindSql, params: kindParams } = kindClause(kinds);
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS eligible,
         SUM(CASE WHEN ast_hash IS NOT NULL THEN 1 ELSE 0 END) AS withAstHash
       FROM nodes
       WHERE ${kindSql}
         AND (end_line - start_line + 1) >= ?`,
    )
    .get(...kindParams, minLines) as { eligible: number | null; withAstHash: number | null };
  return {
    eligible: row.eligible ?? 0,
    withAstHash: row.withAstHash ?? 0,
  };
}

/**
 * Returns true when ANY node anywhere in the DB has an ast_hash —
 * lets us distinguish "DB needs re-indexing" (no fingerprints
 * anywhere) from "user requested unfingerprintable kinds" (some
 * fingerprints exist, just not for the requested kinds). Codex PR
 * review P2 fix.
 */
function dbHasAnyFingerprint(db: SqliteReadOnly): boolean {
  const row = db
    .prepare(`SELECT 1 AS has FROM nodes WHERE ast_hash IS NOT NULL LIMIT 1`)
    .get() as { has?: number } | undefined;
  return !!row;
}

function assertFingerprintCoverage(
  db: SqliteReadOnly,
  kinds: ReadonlyArray<string>,
  cov: FingerprintCoverageRow,
): void {
  if (cov.eligible === 0) {
    // No nodes match the kind+min-lines filter at all. Different
    // condition from a missing fingerprint — just return empty.
    return;
  }
  if (cov.withAstHash > 0) return;

  // Zero fingerprinted nodes among the requested kinds. Distinguish
  // two cases: (1) DB has fingerprints SOMEWHERE — user asked for a
  // kind that isn't fingerprinted (framework-extractor nodes don't
  // go through `createNode`'s hash path); (2) DB has zero
  // fingerprints anywhere — likely migrated-not-reindexed.
  if (dbHasAnyFingerprint(db)) {
    throw new Error(
      `duplicates: 0 of ${cov.eligible} eligible nodes for kinds=${kinds.join(',')} ` +
        `have fingerprints, but this DB does have fingerprints for OTHER kinds. ` +
        `The requested kinds aren't fingerprinted (e.g., framework-extractor ` +
        `nodes like 'component'/'route' are emitted without tree-sitter hashing). ` +
        `Try --kind=function,method.`,
    );
  }
  throw new Error(
    `duplicates: 0 of ${cov.eligible} eligible nodes have fingerprints, ` +
      `and this DB has NO fingerprinted nodes at all. ` +
      `This usually means the DB was migrated to v6 but not re-indexed. ` +
      `Run \`codegraph index\` to refresh fingerprints.`,
  );
}

function rowToMember(r: NodeRow): DuplicateMember {
  return {
    id: r.id,
    qualifiedName: r.qualified_name,
    filePath: r.file_path,
    startLine: r.start_line,
    endLine: r.end_line,
    language: r.language,
    symbolKind: r.kind,
  };
}

/**
 * Build the `kind IN (?, ?, ?)` clause + parameter list for the
 * SELECT. SQLite prepared statements need each parameter
 * positionally; this helper keeps the call site readable.
 */
function kindClause(kinds: ReadonlyArray<string>): { sql: string; params: string[] } {
  if (kinds.length === 0) {
    // Empty `--kind=` from a user would otherwise return no rows;
    // surface the misuse rather than silently producing []groups.
    throw new Error('duplicates: --kind list cannot be empty.');
  }
  const placeholders = kinds.map(() => '?').join(', ');
  return { sql: `kind IN (${placeholders})`, params: kinds.slice() };
}

/**
 * Compute clone groups in `db` over the given hash column. The
 * size filter lives in the WHERE clause so SQLite can use the
 * `idx_nodes_ast_hash` / `idx_nodes_ast_shape_hash` indexes
 * efficiently; the GROUP BY HAVING count(*) > 1 enforces that
 * only multi-member groups come back.
 */
function loadGroups(
  db: SqliteReadOnly,
  column: 'ast_hash' | 'ast_shape_hash',
  kinds: ReadonlyArray<string>,
  minLines: number,
): Map<string, DuplicateMember[]> {
  const { sql: kindSql, params: kindParams } = kindClause(kinds);
  const sql = `
    SELECT id, qualified_name, file_path, start_line, end_line,
           language, kind, ast_hash, ast_shape_hash
    FROM nodes
    WHERE ${column} IS NOT NULL
      AND ${kindSql}
      AND (end_line - start_line + 1) >= ?
      AND ${column} IN (
        SELECT ${column} FROM nodes
        WHERE ${column} IS NOT NULL
          AND ${kindSql}
          AND (end_line - start_line + 1) >= ?
        GROUP BY ${column}
        HAVING COUNT(*) > 1
      )
    ORDER BY ${column}, file_path, start_line, id
  `;
  const params = [...kindParams, minLines, ...kindParams, minLines];
  const rows = db.prepare(sql).all(...params) as NodeRow[];
  const out = new Map<string, DuplicateMember[]>();
  for (const r of rows) {
    const key = column === 'ast_hash' ? r.ast_hash : r.ast_shape_hash;
    if (!key) continue; // defensive — `IS NOT NULL` already filtered
    if (!out.has(key)) out.set(key, []);
    out.get(key)!.push(rowToMember(r));
  }
  return out;
}

/**
 * Member set as a stable string key for subset checks. Sorting
 * by id makes two equal-membership groups produce identical keys
 * regardless of row order.
 */
function memberSetKey(members: DuplicateMember[]): string {
  return members
    .map((m) => m.id)
    .sort()
    .join('\x1f');
}

/**
 * Suppress shape groups whose member set is exactly equal to an
 * exact group's. RFC fork 1 — Type-1 implies Type-2, so the shape
 * group duplicates information already in the exact group.
 *
 * Note: we drop only on EXACT set equality, not strict subset.
 * A genuine Type-2 finding has at least one member that's not in
 * any Type-1 group (different exact hash but same shape) — that's
 * the real value of shape detection and must NOT be dropped.
 */
function suppressShapeCoveredByExact(
  exact: Map<string, DuplicateMember[]>,
  shape: Map<string, DuplicateMember[]>,
): Map<string, DuplicateMember[]> {
  const exactKeys = new Set<string>();
  for (const members of exact.values()) {
    exactKeys.add(memberSetKey(members));
  }
  const out = new Map<string, DuplicateMember[]>();
  for (const [hash, members] of shape) {
    if (!exactKeys.has(memberSetKey(members))) {
      out.set(hash, members);
    }
  }
  return out;
}

/**
 * Compare two groups for the RFC fork 5 sort order:
 *   primary:    member count DESC (biggest clone set first)
 *   secondary:  max line span DESC (largest individual symbol)
 *   tertiary:   first member filePath ASC (human-meaningful — same
 *               clone reproducibly appears at the same output
 *               position across rebuilds — PR #40 round 2 REVIEW
 *               fix replacing the previous SHA-256 tie-break)
 *   quaternary: first member startLine ASC
 *   quinary:    fingerprint ASC (final fallback for true ties)
 */
function compareGroups(a: DuplicateGroup, b: DuplicateGroup): number {
  if (a.members.length !== b.members.length) {
    return b.members.length - a.members.length;
  }
  const spanA = Math.max(...a.members.map((m) => m.endLine - m.startLine + 1));
  const spanB = Math.max(...b.members.map((m) => m.endLine - m.startLine + 1));
  if (spanA !== spanB) return spanB - spanA;
  // Members are already sorted by file_path/start_line/id in the SQL.
  // HAVING COUNT(*) > 1 guarantees at least 2 members per group,
  // so members[0] is always defined — assert non-undefined for TS.
  const aFirst = a.members[0]!;
  const bFirst = b.members[0]!;
  if (aFirst.filePath !== bFirst.filePath) {
    return aFirst.filePath < bFirst.filePath ? -1 : 1;
  }
  if (aFirst.startLine !== bFirst.startLine) {
    return aFirst.startLine - bFirst.startLine;
  }
  if (a.fingerprint < b.fingerprint) return -1;
  if (a.fingerprint > b.fingerprint) return 1;
  return 0;
}

function distinctFileCount(members: DuplicateMember[]): number {
  const files = new Set<string>();
  for (const m of members) files.add(m.filePath);
  return files.size;
}

/**
 * Public entry point. Opens `dbPath` read-only, computes Type-1
 * and Type-2 clone groups under the supplied options, deduplicates
 * Type-2 groups that fully overlap Type-1 groups, and returns the
 * sorted result.
 */
export function findDuplicates(
  dbPath: string,
  opts: DuplicatesOptions = {},
): DuplicatesResult {
  const kinds = opts.kinds ?? DEFAULT_DUPLICATE_KINDS;
  const minLines = opts.minLines ?? DEFAULT_MIN_LINES;

  const db = openReadOnly(dbPath);
  try {
    assertSchemaSupportsFingerprints(db);
    const coverage = fingerprintCoverage(db, kinds, minLines);
    assertFingerprintCoverage(db, kinds, coverage);

    const exact = loadGroups(db, 'ast_hash', kinds, minLines);
    const shapeRaw = loadGroups(db, 'ast_shape_hash', kinds, minLines);
    const shape = suppressShapeCoveredByExact(exact, shapeRaw);

    // Collect member ids that belong to any exact group so shape
    // supersets can annotate `coveredByExactGroup` (PR #40 round 2
    // REVIEW fix). A genuine Type-2 finding has at least one
    // member NOT in an exact group.
    const idsInExactGroup = new Set<string>();
    for (const members of exact.values()) {
      for (const m of members) idsInExactGroup.add(m.id);
    }

    const groups: DuplicateGroup[] = [];
    let exactNodes = 0;
    let shapeNodes = 0;
    for (const [fingerprint, members] of exact) {
      groups.push({
        kind: 'exact',
        fingerprint,
        members,
        fileCount: distinctFileCount(members),
        coveredByExactGroup: false,
      });
      exactNodes += members.length;
    }
    for (const [fingerprint, members] of shape) {
      const anyMemberIsExact = members.some((m) => idsInExactGroup.has(m.id));
      groups.push({
        kind: 'shape',
        fingerprint,
        members,
        fileCount: distinctFileCount(members),
        coveredByExactGroup: anyMemberIsExact,
      });
      // Count ONLY shape-ONLY members (those not already covered
      // by an exact group). Otherwise shape-superset cases like
      // {A.f exact, B.f exact, A.g shape} would inflate
      // `shapeNodes` by re-counting A.f + B.f (Codex PR review P2
      // double-counting fix).
      for (const m of members) {
        if (!idsInExactGroup.has(m.id)) shapeNodes++;
      }
    }
    groups.sort(compareGroups);

    return {
      groups,
      summary: {
        exactGroups: exact.size,
        shapeGroups: shape.size,
        exactNodes,
        shapeNodes,
        fingerprintCoverage: coverage,
      },
    };
  } finally {
    db.close();
  }
}
