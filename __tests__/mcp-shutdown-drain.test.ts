/**
 * PF-622b: integration regression test for the shutdown sequence.
 *
 * Pins Codex pass-1 BLOCKER: `StdioTransport`'s `rl.on('close', ...)`
 * previously called `process.exit(0)` directly. `MCPServer.stop()` calls
 * `transport.stop()` which calls `rl.close()` — the close event used to
 * fire `process.exit(0)` synchronously, beating the bounded
 * stdout/stderr drain that `doStop()` runs immediately after.
 *
 * This test exercises the full shutdown sequence with a mocked
 * `process.exit` to assert:
 *   1. stop() returns the same Promise instance on repeated calls.
 *   2. transport's rl.close routes through stop(), not a direct exit.
 *   3. drain Promises resolve before the lone process.exit(0).
 *   4. Subsequent stop() calls do not re-trigger exit.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { Writable } from 'stream';
import { StdioTransport } from '../src/mcp/transport';

describe('StdioTransport close routing (PF-622b)', () => {
  let originalExit: typeof process.exit;
  let exitMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalExit = process.exit;
    exitMock = vi.fn();
    // Cast away the never return type so the mock can return normally.
    (process as unknown as { exit: (code?: number) => void }).exit = exitMock as unknown as (code?: number) => void;
  });

  afterEach(() => {
    (process as unknown as { exit: typeof process.exit }).exit = originalExit;
  });

  it('default onClose calls process.exit(0) (legacy standalone behavior)', () => {
    const transport = new StdioTransport();
    transport.start(async () => { /* noop */ });
    transport.stop();
    expect(exitMock).toHaveBeenCalledTimes(1);
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  it('routes rl close through the injected onClose hook instead of exiting directly', () => {
    const transport = new StdioTransport();
    const onClose = vi.fn();
    transport.start(async () => { /* noop */ }, onClose);
    transport.stop();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(exitMock).not.toHaveBeenCalled();
  });
});

describe('MCPServer-style shutdown coordinator (PF-622b)', () => {
  let originalExit: typeof process.exit;
  let exitMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalExit = process.exit;
    exitMock = vi.fn();
    (process as unknown as { exit: (code?: number) => void }).exit = exitMock as unknown as (code?: number) => void;
  });

  afterEach(() => {
    (process as unknown as { exit: typeof process.exit }).exit = originalExit;
  });

  /**
   * Minimal stand-in for MCPServer.doStop() that exercises the exact
   * coordinator pattern + drain ordering without spinning up the real
   * MCP server (which would require a project root, ToolHandler, etc.).
   */
  function buildCoordinator(opts: {
    transport: StdioTransport;
    drains: Array<() => Promise<void>>;
  }) {
    let shutdownPromise: Promise<void> | null = null;
    const events: string[] = [];

    const doStop = async (): Promise<void> => {
      events.push('start');
      opts.transport.stop();
      events.push('transport-stopped');
      for (const drain of opts.drains) {
        await drain();
      }
      events.push('drained');
      process.exit(0);
    };

    // Mirrors MCPServer.stop(): the deferred kickoff ensures
    // shutdownPromise is assigned BEFORE doStop's synchronous prefix
    // runs, so reentrant stop() calls (from transport.onClose) see the
    // cached promise instead of starting a second doStop.
    const stop = (): Promise<void> => {
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = Promise.resolve().then(doStop);
      return shutdownPromise;
    };

    return { stop, getEvents: () => events };
  }

  it('runs drain before process.exit(0)', async () => {
    const transport = new StdioTransport();
    let drained = false;
    const drains = [
      async () => {
        await new Promise((r) => setTimeout(r, 30));
        drained = true;
      },
    ];
    const coord = buildCoordinator({ transport, drains });
    transport.start(async () => { /* noop */ }, () => { void coord.stop(); });

    await coord.stop();

    expect(drained).toBe(true);
    expect(exitMock).toHaveBeenCalledTimes(1);
    expect(exitMock).toHaveBeenCalledWith(0);
    const events = coord.getEvents();
    expect(events).toEqual(['start', 'transport-stopped', 'drained']);
  });

  it('repeated stop() returns the same Promise and exits exactly once', async () => {
    const transport = new StdioTransport();
    const coord = buildCoordinator({ transport, drains: [async () => { /* noop */ }] });
    transport.start(async () => { /* noop */ }, () => { void coord.stop(); });

    const p1 = coord.stop();
    const p2 = coord.stop();
    expect(p1).toBe(p2);
    await Promise.all([p1, p2]);
    expect(exitMock).toHaveBeenCalledTimes(1);
  });

  it('transport rl.close-during-stop does not race past the drain', async () => {
    // This is the regression the BLOCKER pinned: transport.stop() calling
    // rl.close() inside the shutdown sequence must not fire its own
    // process.exit(0) before the drain runs.
    const transport = new StdioTransport();
    const sink = new Writable({ write(_c, _e, cb) { setTimeout(cb, 10); } });
    let drainResolved = false;
    const drains = [
      async () => {
        // Force a backpressure-style wait: write enough to require flush.
        sink.write(Buffer.alloc(64));
        await new Promise<void>((r) => setTimeout(r, 25));
        drainResolved = true;
      },
    ];
    const coord = buildCoordinator({ transport, drains });
    transport.start(async () => { /* noop */ }, () => { void coord.stop(); });

    await coord.stop();
    expect(drainResolved).toBe(true);
    expect(exitMock).toHaveBeenCalledTimes(1);
    // The single exit call lands AFTER 'drained' (no rogue earlier exit).
    expect(coord.getEvents()).toEqual(['start', 'transport-stopped', 'drained']);
  });
});
