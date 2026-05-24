/**
 * PF-622c: lifecycle polish — closes the deferred items Codex round 2
 * flagged on PF-622b plus the council recommendation from agy:
 *
 *   1. SIGHUP routing: terminal-disconnect (parent shell closed, ssh
 *      dropped) must reach the drain + exit path, not Node's default
 *      behavior which exits without running the drain.
 *   2. Drain timeout under a stuck consumer: a stream that never
 *      drains must still let shutdown complete inside the bounded
 *      timeout, never block forever.
 *   3. Listener bookkeeping: process.on(SIGINT/SIGTERM/SIGHUP) and
 *      process.stdin.on(end/close) listeners installed by
 *      MCPServer.start() are tracked on the instance, so a future
 *      "stop without exit" path (or a test that exercises multiple
 *      lifetimes) can detect leaks instead of accumulating them.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Writable } from 'stream';
import { drainStream } from '../src/mcp/stdio-drain';

describe('drainStream timeout under stuck consumer (PF-622c)', () => {
  it('resolves inside the bounded timeout when the consumer never reads', async () => {
    // HoldingWritable that never invokes its write callback simulates
    // a peer that has stopped reading the pipe (the exact scenario
    // PF-622b's drain timeout exists to guard).
    class StuckWritable extends Writable {
      override _write(_chunk: unknown, _enc: string, _cb: () => void) {
        // Deliberately never call cb — the chunk stays buffered forever.
      }
    }
    const sink = new StuckWritable({ highWaterMark: 8 });
    // Force backpressure: write past highWaterMark so writableLength > 0.
    while (sink.write(Buffer.alloc(16))) { /* keep writing */ }
    expect(sink.writableLength).toBeGreaterThan(0);

    const t0 = Date.now();
    await drainStream(sink, 60);
    const elapsed = Date.now() - t0;
    // Timeout must fire inside ~2x the budget regardless of stream state.
    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect(elapsed).toBeLessThan(400);
    // Stream itself is still stuck — drain didn't magically unblock it.
    expect(sink.writableLength).toBeGreaterThan(0);
  });

  it('a never-draining stream cannot deadlock the shutdown promise', async () => {
    class StuckWritable extends Writable {
      override _write(_chunk: unknown, _enc: string, _cb: () => void) { /* never */ }
    }
    const a = new StuckWritable({ highWaterMark: 8 });
    const b = new StuckWritable({ highWaterMark: 8 });
    while (a.write(Buffer.alloc(16))) { /* keep writing */ }
    while (b.write(Buffer.alloc(16))) { /* keep writing */ }

    // Mirrors MCPServer.doStop's Promise.all([drainStream(stdout),
    // drainStream(stderr)]) — both must resolve via timeout.
    const t0 = Date.now();
    await Promise.all([drainStream(a, 60), drainStream(b, 60)]);
    expect(Date.now() - t0).toBeLessThan(400);
  });
});

describe('MCPServer.start() signal listener wiring (PF-622c)', () => {
  // Snapshot listener counts before each test so we can assert
  // MCPServer.start() bumps each by exactly 1 — regardless of what
  // the harness already had registered.
  let baseline: {
    sigint: number;
    sigterm: number;
    sighup: number;
    stdinEnd: number;
    stdinClose: number;
  };
  const ENV_PPID_BACKUP = process.env.CODEGRAPH_PPID_POLL_MS;

  beforeEach(() => {
    // Disable the ppidWatchdog interval so the test doesn't leave a
    // dangling timer (it's `.unref()`'d in production, but explicit
    // disable makes the test obviously side-effect free).
    process.env.CODEGRAPH_PPID_POLL_MS = '0';
    baseline = {
      sigint: process.listenerCount('SIGINT'),
      sigterm: process.listenerCount('SIGTERM'),
      sighup: process.listenerCount('SIGHUP'),
      stdinEnd: process.stdin.listenerCount('end'),
      stdinClose: process.stdin.listenerCount('close'),
    };
  });

  afterEach(() => {
    if (ENV_PPID_BACKUP === undefined) delete process.env.CODEGRAPH_PPID_POLL_MS;
    else process.env.CODEGRAPH_PPID_POLL_MS = ENV_PPID_BACKUP;
  });

  it('attaches one listener each to SIGINT / SIGTERM / SIGHUP and stdin end/close', async () => {
    // Real MCPServer instance — exercises the PR's actual production
    // wiring (`process.on('SIGHUP', this.signalHandler)`). Stubbing
    // `transport.start` is what keeps this an isolated unit test
    // (no readline on stdin, no real CodeGraph open).
    //
    // We dynamically import here so vitest evaluates the module
    // after the env override above lands.
    const { MCPServer } = await import('../src/mcp/index');
    const server = new MCPServer({ projectPath: null });
    const transport = (server as unknown as { transport: { start: (...a: unknown[]) => void } }).transport;
    const realTransportStart = transport.start.bind(transport);
    transport.start = () => { /* no real readline */ };

    try {
      await server.start();
      expect(process.listenerCount('SIGINT')).toBe(baseline.sigint + 1);
      expect(process.listenerCount('SIGTERM')).toBe(baseline.sigterm + 1);
      expect(process.listenerCount('SIGHUP')).toBe(baseline.sighup + 1);
      expect(process.stdin.listenerCount('end')).toBe(baseline.stdinEnd + 1);
      expect(process.stdin.listenerCount('close')).toBe(baseline.stdinClose + 1);

      // The tracked handler refs MUST be wired on the instance so a
      // future stop-without-exit path (or this test's cleanup) can
      // remove the listeners. If `signalHandler` were left null,
      // MCPServer.start() didn't run the PF-622c path at all.
      const internals = server as unknown as {
        signalHandler: (() => void) | null;
        stdinHandler: (() => void) | null;
      };
      expect(internals.signalHandler).toBeTypeOf('function');
      expect(internals.stdinHandler).toBeTypeOf('function');
    } finally {
      // Clean up so the test doesn't leak listeners into the suite.
      const internals = server as unknown as {
        signalHandler: (() => void) | null;
        stdinHandler: (() => void) | null;
      };
      if (internals.signalHandler) {
        process.off('SIGINT', internals.signalHandler);
        process.off('SIGTERM', internals.signalHandler);
        process.off('SIGHUP', internals.signalHandler);
      }
      if (internals.stdinHandler) {
        process.stdin.off('end', internals.stdinHandler);
        process.stdin.off('close', internals.stdinHandler);
      }
      transport.start = realTransportStart;
    }

    // Counts return to baseline after removal — the cleanup
    // assertion proves the wired handlers ARE the same references
    // we stored on the instance, not anonymous closures the test
    // can't reach.
    expect(process.listenerCount('SIGINT')).toBe(baseline.sigint);
    expect(process.listenerCount('SIGTERM')).toBe(baseline.sigterm);
    expect(process.listenerCount('SIGHUP')).toBe(baseline.sighup);
    expect(process.stdin.listenerCount('end')).toBe(baseline.stdinEnd);
    expect(process.stdin.listenerCount('close')).toBe(baseline.stdinClose);
  });
});
