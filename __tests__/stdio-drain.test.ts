/**
 * PF-622b: unit tests for the stdio drain helper.
 *
 * Uses Node's `Writable` so we can deterministically control buffer
 * state without touching the real `process.stdout`. Covers:
 *   1. Already-empty stream resolves immediately.
 *   2. Buffered writes resolve when the consumer finally drains them.
 *   3. A stuck stream is bounded by `timeoutMs` and never deadlocks.
 *   4. `timeoutMs: 0` returns without parking on `drain`.
 */

import { describe, it, expect } from 'vitest';
import { Writable } from 'stream';
import { drainStream } from '../src/mcp/stdio-drain';

/** Minimal writable that holds chunks until told to drain. */
class HoldingWritable extends Writable {
  private pending: Array<() => void> = [];
  constructor() {
    super({ highWaterMark: 8 });
  }
  override _write(_chunk: unknown, _enc: string, cb: () => void) {
    // Park the chunk until releaseAll().
    this.pending.push(cb);
  }
  releaseAll() {
    const cbs = this.pending;
    this.pending = [];
    for (const cb of cbs) cb();
  }
}

describe('drainStream (PF-622b)', () => {
  it('resolves immediately when buffer is empty', async () => {
    const sink = new Writable({ write(_c, _e, cb) { cb(); } });
    const t0 = Date.now();
    await drainStream(sink, 2000);
    expect(Date.now() - t0).toBeLessThan(50);
  });

  it('resolves only after the stream drains its buffer', async () => {
    const sink = new HoldingWritable();
    // Fill past highWaterMark to force backpressure.
    while (sink.write(Buffer.alloc(16))) { /* keep writing */ }
    expect(sink.writableLength).toBeGreaterThan(0);

    let resolved = false;
    const p = drainStream(sink, 2000).then(() => { resolved = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(false);

    sink.releaseAll();
    await p;
    expect(resolved).toBe(true);
  });

  it('respects timeoutMs when the stream never drains', async () => {
    const sink = new HoldingWritable();
    while (sink.write(Buffer.alloc(16))) { /* keep writing */ }
    expect(sink.writableLength).toBeGreaterThan(0);

    const t0 = Date.now();
    await drainStream(sink, 50);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(500);
  });

  it('returns synchronously on timeoutMs=0 even with pending bytes', async () => {
    const sink = new HoldingWritable();
    while (sink.write(Buffer.alloc(16))) { /* keep writing */ }
    expect(sink.writableLength).toBeGreaterThan(0);

    const t0 = Date.now();
    await drainStream(sink, 0);
    expect(Date.now() - t0).toBeLessThan(50);
  });
});
