/**
 * PF-622b: pipe-stdout drain helper.
 *
 * Node's `process.stdout.write` is **asynchronous when stdout is a pipe**
 * (the common case for an MCP server launched as a child of Claude Code,
 * Cursor, opencode, etc.). Calling `process.exit(0)` immediately after a
 * `write()` drops anything still buffered — the last JSON-RPC response,
 * the final stderr diagnostic, or both.
 *
 * `drainStream` resolves when the stream's internal buffer is empty, or
 * after `timeoutMs` so a stuck pipe can never deadlock shutdown. It is
 * intentionally tiny + dependency-free so it can be unit-tested against
 * Node's `Writable` / `PassThrough` without touching the real
 * `process.stdout`.
 */

import type { Writable } from 'stream';

/**
 * Resolve when `stream` reports it has no buffered writes pending, or
 * after `timeoutMs` (whichever fires first). Never rejects.
 *
 * - Resolves immediately if `stream.writableLength === 0` AND the stream
 *   is not in "needs drain" backpressure.
 * - Otherwise waits for the next `'drain'` event.
 * - A `timeoutMs` of 0 returns synchronously after the immediate check
 *   (used by tests that want to assert the early-exit path).
 */
export function drainStream(stream: Writable, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    // Already empty + no backpressure: nothing to wait for.
    const needsDrain = (stream as Writable & { writableNeedDrain?: boolean }).writableNeedDrain;
    const buffered = stream.writableLength ?? 0;
    if (buffered === 0 && !needsDrain) {
      resolve();
      return;
    }

    if (timeoutMs <= 0) {
      // Caller asked for synchronous-only behavior; don't park on 'drain'.
      resolve();
      return;
    }

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      stream.removeListener('drain', finish);
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    stream.once('drain', finish);
  });
}
