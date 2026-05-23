import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, SqliteDatabase } from '../src/db/sqlite-adapter';
import { QueryBuilder } from '../src/db/queries';

describe('QueryBuilder hard filters', () => {
  let dbPath: string;
  let db: SqliteDatabase;
  let queries: QueryBuilder;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `codegraph-query-filters-${process.pid}-${Date.now()}.db`);
    ({ db } = createDatabase(dbPath));
    db.exec(fs.readFileSync(path.join(process.cwd(), 'src/db/schema.sql'), 'utf8'));
    queries = new QueryBuilder(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dbPath, { force: true });
  });

  it('finds explicit path matches outside initial candidate batches', () => {
    seedManyLocalPaymentServices();

    const textResults = queries.searchNodes('path:third_party PaymentService', {
      limit: 1,
      kinds: ['class'],
    });
    const pathOnlyResults = queries.searchNodes('path:third_party', {
      limit: 1,
      kinds: ['class'],
    });

    expect(textResults).toHaveLength(1);
    expect(textResults[0]!.node.filePath).toBe('third_party/generated/payment-service.ts');
    expect(pathOnlyResults).toHaveLength(1);
    expect(pathOnlyResults[0]!.node.filePath).toBe('third_party/generated/payment-service.ts');
  });

  it('treats SQL wildcard characters in path filters as literals', () => {
    queries.insertNode({
      id: 'hyphen-third-party-payment',
      kind: 'class',
      name: 'PaymentService',
      qualifiedName: 'PaymentService',
      filePath: 'third-party/generated/payment-service.ts',
      language: 'typescript',
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    });

    expect(queries.searchNodes('path:third_party PaymentService', {
      limit: 1,
      kinds: ['class'],
    })).toHaveLength(0);
  });

  it('treats SQL wildcard characters in fallback text terms as literals', () => {
    queries.insertNode({
      id: 'literal-helper',
      kind: 'class',
      name: 'a_b',
      qualifiedName: 'a_b',
      filePath: 'third_party/literal.ts',
      language: 'typescript',
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    });
    queries.insertNode({
      id: 'wildcard-lookalike-helper',
      kind: 'class',
      name: 'aXb',
      qualifiedName: 'aXb',
      filePath: 'third_party/lookalike.ts',
      language: 'typescript',
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    });

    const results = queries.searchNodes('path:third_party a_b', {
      limit: 10,
      kinds: ['class'],
    });

    expect(results.map((result) => result.node.name)).toContain('a_b');
    expect(results.map((result) => result.node.name)).not.toContain('aXb');
  });

  it('applies offset when hard filters fall back to SQL candidates', () => {
    queries.insertNode({
      id: 'third-party-a',
      kind: 'class',
      name: 'AService',
      qualifiedName: 'AService',
      filePath: 'third_party/a.ts',
      language: 'typescript',
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    });
    queries.insertNode({
      id: 'third-party-b',
      kind: 'class',
      name: 'BService',
      qualifiedName: 'BService',
      filePath: 'third_party/b.ts',
      language: 'typescript',
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    });

    const results = queries.searchNodes('path:third_party', {
      limit: 1,
      offset: 1,
      kinds: ['class'],
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.node.filePath).toBe('third_party/b.ts');
  });

  function seedManyLocalPaymentServices(): void {
    db.transaction(() => {
      for (let i = 0; i < 105; i++) {
        queries.insertNode({
          id: `src-${i}`,
          kind: 'class',
          name: 'PaymentService',
          qualifiedName: 'PaymentService',
          filePath: `src/payment-${String(i).padStart(3, '0')}.ts`,
          language: 'typescript',
          startLine: 1,
          endLine: 1,
          startColumn: 0,
          endColumn: 0,
          updatedAt: Date.now(),
        });
      }
      queries.insertNode({
        id: 'third-party-payment',
        kind: 'class',
        name: 'PaymentService',
        qualifiedName: 'PaymentService',
        filePath: 'third_party/generated/payment-service.ts',
        language: 'typescript',
        startLine: 1,
        endLine: 1,
        startColumn: 0,
        endColumn: 0,
        updatedAt: Date.now(),
      });
    })();
  }
});
