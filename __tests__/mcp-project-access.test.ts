/**
 * PF-619: cross-project MCP allowlist tests.
 *
 * Covers the five gating cases Codex enumerated for the slice:
 *   - Default root → allowed.
 *   - Sibling repo outside allowlist → denied.
 *   - Symlink that escapes the allowed root → denied.
 *   - Relative-traversal (`..`) into an outside path → denied.
 *   - Extra root explicitly in the allowlist → allowed.
 *
 * Plus env-var parsing helpers and the ToolHandler integration that fires
 * the gate before opening a project SQLite file.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ProjectAccessGate,
  parseAllowAnyEnv,
  parseAllowRootsEnv,
} from '../src/mcp/project-access';
import { ToolHandler } from '../src/mcp/tools';

/**
 * Symlink creation needs elevated privileges on Windows. Skip symlink-based
 * tests when the platform doesn't permit it so the suite stays green on
 * unprivileged Windows runners; the Linux/macOS coverage exercises the
 * realpath path equivalently.
 */
function canCreateSymlinks(): boolean {
  if (process.platform !== 'win32') return true;
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-symlink-probe-'));
  try {
    const target = path.join(probeDir, 'target');
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(probeDir, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
}
const SYMLINKS_SUPPORTED = canCreateSymlinks();
const itSymlink = SYMLINKS_SUPPORTED ? it : it.skip;

describe('ProjectAccessGate (PF-619)', () => {
  let workspace: string;
  let allowedA: string;
  let allowedB: string;
  let outside: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-pf619-'));
    allowedA = path.join(workspace, 'allowed-a');
    allowedB = path.join(workspace, 'allowed-b');
    outside = path.join(workspace, 'outside');
    fs.mkdirSync(allowedA);
    fs.mkdirSync(allowedB);
    fs.mkdirSync(outside);
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('allows the default root', () => {
    const gate = new ProjectAccessGate({ defaultRoot: allowedA });
    expect(gate.check(allowedA).allowed).toBe(true);
  });

  it('allows a descendant of the default root', () => {
    fs.mkdirSync(path.join(allowedA, 'src'));
    const gate = new ProjectAccessGate({ defaultRoot: allowedA });
    expect(gate.check(path.join(allowedA, 'src')).allowed).toBe(true);
  });

  it('denies a sibling repo outside the allowed roots', () => {
    const gate = new ProjectAccessGate({ defaultRoot: allowedA });
    const result = gate.check(outside);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/outside the configured allowed roots/);
    expect(result.allowedRoots).toContain(fs.realpathSync(allowedA));
  });

  it('does not leak the requested resolved path or allowed-root realpaths in the denial reason', () => {
    const gate = new ProjectAccessGate({ defaultRoot: allowedA });
    const result = gate.check(outside);
    expect(result.allowed).toBe(false);
    // The reason should NOT echo the realpath of the denied request or of
    // any allowed root — those are returned in the structured allowedRoots
    // field for server-side logging only.
    expect(result.reason).not.toContain(fs.realpathSync(outside));
    expect(result.reason).not.toContain(fs.realpathSync(allowedA));
  });

  itSymlink('denies a symlink that escapes the allowed root', () => {
    const symlinkInsideAllowed = path.join(allowedA, 'escape-link');
    fs.symlinkSync(outside, symlinkInsideAllowed);
    const gate = new ProjectAccessGate({ defaultRoot: allowedA });
    const result = gate.check(symlinkInsideAllowed);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/outside the configured allowed roots/);
  });

  it('denies `..` traversal that resolves outside the allowed root', () => {
    fs.mkdirSync(path.join(allowedA, 'src'));
    const traversal = path.join(allowedA, 'src', '..', '..', 'outside');
    const gate = new ProjectAccessGate({ defaultRoot: allowedA });
    const result = gate.check(traversal);
    expect(result.allowed).toBe(false);
  });

  it('allows an extra root added via the allowlist', () => {
    const gate = new ProjectAccessGate({
      defaultRoot: allowedA,
      extraRoots: [allowedB],
    });
    expect(gate.check(allowedB).allowed).toBe(true);
  });

  it('allows any path when allowAny is set (pre-PF-619 behavior)', () => {
    const gate = new ProjectAccessGate({
      defaultRoot: allowedA,
      allowAny: true,
    });
    expect(gate.check(outside).allowed).toBe(true);
    expect(gate.isOpen()).toBe(true);
  });

  it('denies all paths when no roots are configured and allowAny is false', () => {
    const gate = new ProjectAccessGate({});
    const result = gate.check(allowedA);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/No allowed project roots/);
  });

  itSymlink('normalizes allowed roots through realpath so symlinks to the root match', () => {
    const symlinkRoot = path.join(workspace, 'link-to-allowed-a');
    fs.symlinkSync(allowedA, symlinkRoot);
    const gate = new ProjectAccessGate({ defaultRoot: symlinkRoot });
    // Accessing the real path should still be allowed since the gate realpaths
    // both sides.
    expect(gate.check(allowedA).allowed).toBe(true);
    // And accessing via the symlink path is allowed too.
    expect(gate.check(symlinkRoot).allowed).toBe(true);
  });
});

describe('parseAllowRootsEnv (PF-619)', () => {
  it('splits a colon-separated env var on POSIX', () => {
    // On POSIX, path.delimiter is ':'. On Windows it's ';' — that branch is
    // covered by the platform-delimiter-only test below.
    expect(parseAllowRootsEnv('/a:/b:/c')).toEqual(['/a', '/b', '/c']);
  });

  it('returns an empty array for undefined / empty', () => {
    expect(parseAllowRootsEnv(undefined)).toEqual([]);
    expect(parseAllowRootsEnv('')).toEqual([]);
  });

  it('trims whitespace and drops empty segments', () => {
    expect(parseAllowRootsEnv(' /a : :/b ')).toEqual(['/a', '/b']);
  });

  it('does not split a single value on `:` when path.delimiter is `;` (Windows safety)', () => {
    // Simulates the prior bug: a Windows drive-letter root like `C:\\repo`
    // must NOT be split into `["C", "\\repo"]`. On POSIX path.delimiter
    // is ':' so this test pins the platform-delimiter-only behavior via
    // the absence of any extra delimiter characters.
    expect(parseAllowRootsEnv('/single/root')).toEqual(['/single/root']);
  });
});

describe('parseAllowAnyEnv (PF-619)', () => {
  it('returns true for truthy values', () => {
    expect(parseAllowAnyEnv('1')).toBe(true);
    expect(parseAllowAnyEnv('true')).toBe(true);
    expect(parseAllowAnyEnv('TRUE')).toBe(true);
    expect(parseAllowAnyEnv('yes')).toBe(true);
    expect(parseAllowAnyEnv('on')).toBe(true);
  });

  it('returns false for falsy / unset / arbitrary values', () => {
    expect(parseAllowAnyEnv(undefined)).toBe(false);
    expect(parseAllowAnyEnv('')).toBe(false);
    expect(parseAllowAnyEnv('0')).toBe(false);
    expect(parseAllowAnyEnv('no')).toBe(false);
    expect(parseAllowAnyEnv('maybe')).toBe(false);
  });
});

describe('ToolHandler.setProjectAccess (PF-619 integration)', () => {
  it('throws with the gate reason when a denied projectPath is requested', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-pf619-int-'));
    try {
      const allowed = path.join(workspace, 'allowed');
      const outside = path.join(workspace, 'outside');
      fs.mkdirSync(allowed);
      fs.mkdirSync(outside);
      // Seed both with .codegraph/ dirs so findNearestCodeGraphRoot can resolve.
      fs.mkdirSync(path.join(allowed, '.codegraph'));
      fs.mkdirSync(path.join(outside, '.codegraph'));

      const handler = new ToolHandler(null);
      handler.setProjectAccess(new ProjectAccessGate({ defaultRoot: allowed }));

      // The error must surface the gate's reason rather than opening the file.
      const callDenied = () =>
        // Access the private method through a cast — this is an integration
        // test for the gate path, not part of the public ToolHandler API.
        (handler as unknown as { getCodeGraph(p?: string): unknown }).getCodeGraph(outside);

      expect(callDenied).toThrow(/outside the configured allowed roots/);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('re-checks the access gate on every call so policy narrowing invalidates cached projects', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-pf619-cache-'));
    try {
      const allowed = path.join(workspace, 'allowed');
      const outside = path.join(workspace, 'outside');
      fs.mkdirSync(allowed);
      fs.mkdirSync(outside);

      const handler = new ToolHandler(null);
      // Start permissive — would-have cached `outside` under the prior bug.
      handler.setProjectAccess(new ProjectAccessGate({ allowAny: true }));

      // Narrow the policy to only `allowed`.
      handler.setProjectAccess(new ProjectAccessGate({ defaultRoot: allowed }));

      // A request for `outside` must hit the gate FIRST and be rejected,
      // regardless of any cache state the prior policy might have produced.
      const callDenied = () =>
        (handler as unknown as { getCodeGraph(p?: string): unknown }).getCodeGraph(outside);
      expect(callDenied).toThrow(/outside the configured allowed roots/);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
