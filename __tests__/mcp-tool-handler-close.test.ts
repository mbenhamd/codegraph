/**
 * PF-622: ToolHandler.closeAll() lifecycle regression test.
 *
 * The cross-project cache stores a single CodeGraph instance under
 * multiple keys (resolved root + caller-supplied path). `CodeGraph.close()`
 * is not idempotent — `db.close()` and `fileLock.release()` both throw
 * on a double-call. Without referential-identity dedup, `closeAll()`
 * would call `close()` twice on the same instance and abort
 * mid-shutdown, leaking the rest of the cache.
 *
 * This test pokes the private projectCache to install a single mock
 * instance under two keys and asserts:
 *   1. `close()` is invoked exactly once.
 *   2. A throw from one `close()` does not block closing the rest.
 *   3. The cache is emptied at the end.
 */

import { describe, it, expect, vi } from 'vitest';
import { ToolHandler } from '../src/mcp/tools';

interface CacheBackdoor {
  projectCache: Map<string, { close: () => void }>;
}

describe('ToolHandler.closeAll lifecycle (PF-622)', () => {
  it('closes a cg cached under two keys exactly once', () => {
    const handler = new ToolHandler(null);
    const cg = { close: vi.fn() };
    const cache = (handler as unknown as CacheBackdoor).projectCache;
    cache.set('/projects/foo', cg);
    cache.set('/projects/foo/src', cg);
    expect(cache.size).toBe(2);

    handler.closeAll();

    expect(cg.close).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(0);
  });

  it('continues closing the remaining cache when one cg.close() throws and logs to stderr', () => {
    const handler = new ToolHandler(null);
    const cgA = { close: vi.fn().mockImplementation(() => { throw new Error('boom A'); }) };
    const cgB = { close: vi.fn() };
    const cache = (handler as unknown as CacheBackdoor).projectCache;
    cache.set('/projects/a', cgA);
    cache.set('/projects/a/src', cgA);
    cache.set('/projects/b', cgB);

    // Replace process.stderr.write with a capture function. vitest's
    // default stderr handling can otherwise swallow our spy.
    const captured: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(() => handler.closeAll()).not.toThrow();
    } finally {
      process.stderr.write = originalWrite;
    }

    expect(cgA.close).toHaveBeenCalledTimes(1);
    expect(cgB.close).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(0);
    // PF-622: failed cg.close() must log so genuine close regressions
    // stay visible during shutdown.
    const joined = captured.join('');
    expect(joined).toMatch(/Failed to close cached project/);
    expect(joined).toMatch(/boom A/);
  });

  it('closes distinct cg instances exactly once each', () => {
    const handler = new ToolHandler(null);
    const cgA = { close: vi.fn() };
    const cgB = { close: vi.fn() };
    const cgC = { close: vi.fn() };
    const cache = (handler as unknown as CacheBackdoor).projectCache;
    cache.set('/a', cgA);
    cache.set('/a/sub', cgA);
    cache.set('/b', cgB);
    cache.set('/c', cgC);
    cache.set('/c/sub1', cgC);
    cache.set('/c/sub2', cgC);

    handler.closeAll();

    expect(cgA.close).toHaveBeenCalledTimes(1);
    expect(cgB.close).toHaveBeenCalledTimes(1);
    expect(cgC.close).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(0);
  });
});
