/**
 * PF-628: cross-platform path-resolution parity tests.
 *
 * The installer's per-target config-path helpers branch on
 * `process.platform` and environment variables (`APPDATA`,
 * `XDG_CONFIG_HOME`) to land in the right place on Win/macOS/Linux.
 * These tests run on Linux CI but mock `process.platform` and the
 * relevant env vars to assert each platform branch behaves
 * correctly. Without this, a Windows-only or XDG-specific
 * regression goes undetected until a real user on that platform
 * hits it.
 *
 * `os.homedir()` is non-configurable in Node (vi.spyOn /
 * Object.defineProperty both throw with "Cannot redefine
 * property"), so this file uses the REAL homedir for branches that
 * depend on it and asserts via path SUFFIX instead of an absolute
 * equality. Branches that produce a homedir-independent result
 * (XDG set / APPDATA set) get the tighter exact-equality
 * assertion.
 *
 * Scope is intentionally narrow: opencode's `globalConfigDir` is
 * the only installer target that branches on `process.platform`.
 * Claude / Cursor / Codex / Hermes use `os.homedir()` with
 * platform-agnostic relative paths, so they're already correct by
 * construction. If a future target adds platform-specific logic,
 * extend this file.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { opencodeTarget } from '../src/installer/targets/opencode';

// ----- Platform-mocking utilities -----

const ENV_KEYS = ['APPDATA', 'XDG_CONFIG_HOME'] as const;

interface PlatformState {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
}

function snapshot(): PlatformState {
  const env: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) env[k] = process.env[k];
  return { platform: process.platform, env };
}

function restore(state: PlatformState): void {
  Object.defineProperty(process, 'platform', {
    value: state.platform,
    writable: false,
    configurable: true,
  });
  for (const k of ENV_KEYS) {
    if (state.env[k] === undefined) delete process.env[k];
    else process.env[k] = state.env[k];
  }
}

function mockPlatform(opts: {
  platform: NodeJS.Platform;
  env?: Partial<Record<typeof ENV_KEYS[number], string | undefined>>;
}): void {
  Object.defineProperty(process, 'platform', {
    value: opts.platform,
    writable: false,
    configurable: true,
  });
  // Clear baseline platform env vars so absent values stay absent.
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function opencodeGlobalConfigPath(): string {
  // `describePaths('global')` returns the public list of files the
  // installer would touch — first entry is the config file, second
  // is the AGENTS.md instructions. We assert against the config file.
  return opencodeTarget.describePaths('global')[0]!;
}

/**
 * Assert the config-file path lives in the expected directory.
 * Extension choice (.jsonc vs .json) depends on which file already
 * exists on disk in that directory — that's content-based, not
 * platform-based, and not what PF-628 is testing. The directory
 * portion IS what branches on platform/env.
 */
function expectConfigDir(actual: string, expectedDir: string): void {
  expect(path.dirname(actual)).toBe(expectedDir);
  expect(path.basename(actual)).toMatch(/^opencode\.jsonc?$/);
}

// ----- Tests -----

describe('PF-628: opencode global config path parity across platforms', () => {
  let baseline: PlatformState;
  const realHome = os.homedir();

  beforeEach(() => {
    baseline = snapshot();
  });

  afterEach(() => {
    restore(baseline);
  });

  it('Linux without XDG_CONFIG_HOME falls back to ${HOME}/.config/opencode', () => {
    // os.homedir() is non-configurable, so this assertion uses the
    // real homedir prefix. The branch under test is the absence of
    // XDG_CONFIG_HOME → fall through to `~/.config`.
    mockPlatform({ platform: 'linux' });
    expectConfigDir(
      opencodeGlobalConfigPath(),
      path.join(realHome, '.config', 'opencode'),
    );
  });

  it('Linux WITH XDG_CONFIG_HOME honors the env var (dir-only assertion)', () => {
    mockPlatform({
      platform: 'linux',
      env: { XDG_CONFIG_HOME: '/custom/xdg' },
    });
    // The custom XDG dir doesn't exist, so configPath returns the
    // .jsonc default. Assert the directory matches.
    expectConfigDir(
      opencodeGlobalConfigPath(),
      path.join('/custom/xdg', 'opencode'),
    );
  });

  it('Linux ignores blank/whitespace XDG_CONFIG_HOME and falls back to ${HOME}/.config', () => {
    // The opencode helper guards on `.trim().length > 0` — a blank
    // env value must not produce `//opencode` or land in the wrong
    // place.
    mockPlatform({
      platform: 'linux',
      env: { XDG_CONFIG_HOME: '   ' },
    });
    expectConfigDir(
      opencodeGlobalConfigPath(),
      path.join(realHome, '.config', 'opencode'),
    );
  });

  it('macOS matches Linux semantics: ~/.config when XDG unset, custom path when set', () => {
    mockPlatform({ platform: 'darwin' });
    expectConfigDir(
      opencodeGlobalConfigPath(),
      path.join(realHome, '.config', 'opencode'),
    );

    mockPlatform({
      platform: 'darwin',
      env: { XDG_CONFIG_HOME: '/Users/alice/Library/Application Support' },
    });
    expectConfigDir(
      opencodeGlobalConfigPath(),
      path.join('/Users/alice/Library/Application Support', 'opencode'),
    );
  });

  it('Windows with APPDATA uses %APPDATA%/opencode (homedir-independent)', () => {
    mockPlatform({
      platform: 'win32',
      env: { APPDATA: 'C:\\Users\\Alice\\AppData\\Roaming' },
    });
    expectConfigDir(
      opencodeGlobalConfigPath(),
      path.join('C:\\Users\\Alice\\AppData\\Roaming', 'opencode'),
    );
  });

  it('Windows without APPDATA falls back to ${HOME}/AppData/Roaming/opencode', () => {
    mockPlatform({
      platform: 'win32',
      // APPDATA intentionally omitted — exercises the homedir fallback.
    });
    expectConfigDir(
      opencodeGlobalConfigPath(),
      path.join(realHome, 'AppData', 'Roaming', 'opencode'),
    );
  });

  it('Windows ignores XDG_CONFIG_HOME entirely (POSIX-only convention)', () => {
    // XDG_CONFIG_HOME is sometimes set on Windows via WSL or
    // cross-platform tooling — opencode must NOT honor it on win32.
    mockPlatform({
      platform: 'win32',
      env: {
        APPDATA: 'C:\\Users\\Alice\\AppData\\Roaming',
        XDG_CONFIG_HOME: '/wsl/home/.config',
      },
    });
    expectConfigDir(
      opencodeGlobalConfigPath(),
      path.join('C:\\Users\\Alice\\AppData\\Roaming', 'opencode'),
    );
    // Belt-and-suspenders: the XDG path must NOT appear in the result.
    expect(opencodeGlobalConfigPath()).not.toContain('/wsl/home/.config');
  });
});
