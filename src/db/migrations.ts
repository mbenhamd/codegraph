/**
 * Database Migrations
 *
 * Schema versioning and migration support.
 */

import { SqliteDatabase } from './sqlite-adapter';

/**
 * Current schema version
 */
export const CURRENT_SCHEMA_VERSION = 6;

/**
 * Migration definition
 */
interface Migration {
  version: number;
  description: string;
  up: (db: SqliteDatabase) => void;
}

/**
 * All migrations in order
 *
 * Note: Version 1 is the initial schema, handled by schema.sql
 * Future migrations go here.
 */
const migrations: Migration[] = [
  {
    version: 2,
    description: 'Add project metadata, provenance tracking, and unresolved ref context',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        ALTER TABLE unresolved_refs ADD COLUMN file_path TEXT NOT NULL DEFAULT '';
        ALTER TABLE unresolved_refs ADD COLUMN language TEXT NOT NULL DEFAULT 'unknown';
        ALTER TABLE edges ADD COLUMN provenance TEXT DEFAULT NULL;
        CREATE INDEX IF NOT EXISTS idx_unresolved_file_path ON unresolved_refs(file_path);
        CREATE INDEX IF NOT EXISTS idx_edges_provenance ON edges(provenance);
      `);
    },
  },
  {
    version: 3,
    description: 'Add lower(name) expression index for memory-efficient case-insensitive lookups',
    up: (db) => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_nodes_lower_name ON nodes(lower(name));
      `);
    },
  },
  {
    version: 4,
    description:
      'Drop redundant idx_edges_source / idx_edges_target (covered by source_kind / target_kind composites)',
    up: (db) => {
      db.exec(`
        DROP INDEX IF EXISTS idx_edges_source;
        DROP INDEX IF EXISTS idx_edges_target;
      `);
    },
  },
  {
    version: 5,
    description:
      'Enforce edge uniqueness on (source, target, kind, line, col) and clean existing duplicates (PF-625)',
    up: (db) => {
      // Step 1: collapse existing duplicates BEFORE creating the unique
      // index. Keep MIN(id) for each canonical-identity group; delete
      // the rest. Without this, the CREATE UNIQUE INDEX would fail on
      // any DB that ran prior versions of synthesizeReExportEdges or
      // re-indexed across file watch restarts.
      db.exec(`
        DELETE FROM edges WHERE id NOT IN (
          SELECT MIN(id) FROM edges
          GROUP BY source, target, kind, COALESCE(line, -1), COALESCE(col, -1)
        );
      `);
      // Step 2: enforce the canonical identity going forward. COALESCE
      // folds NULL line/col into a single bucket so file-level / synth
      // edges collapse to one row.
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_unique
          ON edges(source, target, kind, COALESCE(line, -1), COALESCE(col, -1));
      `);
    },
  },
  {
    version: 6,
    description:
      'Add per-symbol fingerprint columns (ast_hash, ast_shape_hash, sig_hash, call_pattern_hash) for duplicate detection + drift analysis (PF-690)',
    up: (db) => {
      // All four columns nullable: existing rows stay NULL until the
      // next index sweep backfills them. New nodes get populated at
      // creation. No behavior change for code paths that don't read
      // these columns yet — they are pure data infrastructure for
      // future duplicate / diff / explain CLIs.
      //
      // Codex round 4 REVIEW: make each ALTER TABLE idempotent via
      // `PRAGMA table_info`. Two processes opening a v5 database
      // simultaneously could both read version 5, both enter this
      // migration, and the second's `ALTER TABLE ADD COLUMN` would
      // fail with "duplicate column" — even though the resulting
      // schema is fine. Pre-checking via `table_info` collapses the
      // second open's migration into a no-op for already-applied
      // columns. `CREATE INDEX IF NOT EXISTS` below is already
      // idempotent.
      const cols = db
        .prepare("PRAGMA table_info('nodes')")
        .all() as Array<{ name: string }>;
      const hasCol = (name: string): boolean => cols.some((c) => c.name === name);
      if (!hasCol('ast_hash')) {
        db.exec('ALTER TABLE nodes ADD COLUMN ast_hash TEXT DEFAULT NULL');
      }
      if (!hasCol('ast_shape_hash')) {
        db.exec('ALTER TABLE nodes ADD COLUMN ast_shape_hash TEXT DEFAULT NULL');
      }
      if (!hasCol('sig_hash')) {
        db.exec('ALTER TABLE nodes ADD COLUMN sig_hash TEXT DEFAULT NULL');
      }
      if (!hasCol('call_pattern_hash')) {
        db.exec('ALTER TABLE nodes ADD COLUMN call_pattern_hash TEXT DEFAULT NULL');
      }
      // Lookup indexes: duplicate-detection sweeps will
      // `WHERE ast_hash = ?` and `WHERE ast_shape_hash = ?` heavily,
      // so prepay the index cost rather than full-table-scanning
      // every duplicates query later. Partial-index on NOT NULL
      // keeps the indexes tight — existing rows that never get a
      // hash don't occupy index space.
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_nodes_ast_hash ON nodes(ast_hash) WHERE ast_hash IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_nodes_ast_shape_hash ON nodes(ast_shape_hash) WHERE ast_shape_hash IS NOT NULL;
      `);
    },
  },
];

/**
 * Get the current schema version from the database
 */
export function getCurrentVersion(db: SqliteDatabase): number {
  try {
    const row = db
      .prepare('SELECT MAX(version) as version FROM schema_versions')
      .get() as { version: number | null } | undefined;
    return row?.version ?? 0;
  } catch {
    // Table doesn't exist yet
    return 0;
  }
}

/**
 * Record a migration as applied
 */
function recordMigration(db: SqliteDatabase, version: number, description: string): void {
  db.prepare(
    'INSERT INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)'
  ).run(version, Date.now(), description);
}

/**
 * Run all pending migrations
 */
export function runMigrations(db: SqliteDatabase, fromVersion: number): void {
  const pending = migrations.filter((m) => m.version > fromVersion);

  if (pending.length === 0) {
    return;
  }

  // Sort by version
  pending.sort((a, b) => a.version - b.version);

  // Run each migration in a transaction
  for (const migration of pending) {
    db.transaction(() => {
      migration.up(db);
      recordMigration(db, migration.version, migration.description);
    })();
  }
}

/**
 * Check if the database needs migration
 */
export function needsMigration(db: SqliteDatabase): boolean {
  const current = getCurrentVersion(db);
  return current < CURRENT_SCHEMA_VERSION;
}

/**
 * Get list of pending migrations
 */
export function getPendingMigrations(db: SqliteDatabase): Migration[] {
  const current = getCurrentVersion(db);
  return migrations
    .filter((m) => m.version > current)
    .sort((a, b) => a.version - b.version);
}

/**
 * Get migration history from database
 */
export function getMigrationHistory(
  db: SqliteDatabase
): Array<{ version: number; appliedAt: number; description: string | null }> {
  const rows = db
    .prepare('SELECT version, applied_at, description FROM schema_versions ORDER BY version')
    .all() as Array<{ version: number; applied_at: number; description: string | null }>;

  return rows.map((row) => ({
    version: row.version,
    appliedAt: row.applied_at,
    description: row.description,
  }));
}
