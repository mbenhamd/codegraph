/**
 * Project-access allowlist policy (PF-619).
 *
 * MCP tools accept a `projectPath` argument so AI agents can query graphs
 * outside the server's primary project. Without a policy, that argument lets
 * a client open any indexed project visible to the server process — a much
 * broader surface than most users intend for an always-on local server.
 *
 * The policy is a fail-closed allowlist:
 *
 *   - The default root passed to the server (CLI `--path` or MCP `rootUri`)
 *     is always allowed.
 *   - Additional roots come from the `--allow-root <path>` CLI flag
 *     (repeatable) or the `CODEGRAPH_MCP_ALLOW_ROOTS` env var (colon-
 *     separated, like PATH).
 *   - Setting `--allow-any` or `CODEGRAPH_MCP_ALLOW_ANY=1` restores the
 *     pre-PF-619 behavior of opening any reachable project. Use only when
 *     the server is intentionally exposed to multi-repo workflows.
 *
 * Paths are normalized through `realpath` before comparison so symlink
 * escapes and `..` traversal can't smuggle the requested path outside the
 * configured roots. A request is allowed when its resolved path equals OR
 * is a descendant of at least one allowed root.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface ProjectAccessPolicy {
  /**
   * The primary project root the server was launched with. Always allowed.
   * `null` when the server didn't have a default project at construction —
   * extra allowed roots still apply.
   */
  defaultRoot?: string | null;
  /** Additional roots (e.g. from `--allow-root` or env var). */
  extraRoots?: string[];
  /**
   * When true, every requested path is allowed — restores the pre-PF-619
   * behavior. Off by default; turn on with `--allow-any` or
   * `CODEGRAPH_MCP_ALLOW_ANY=1` when you intentionally expose the server
   * to arbitrary multi-repo workflows.
   */
  allowAny?: boolean;
}

export interface AccessCheckResult {
  allowed: boolean;
  reason?: string;
  allowedRoots?: string[];
}

export class ProjectAccessGate {
  private allowedRoots: string[];
  private allowAny: boolean;

  constructor(policy: ProjectAccessPolicy) {
    this.allowAny = policy.allowAny ?? false;
    const roots: string[] = [];
    if (policy.defaultRoot) {
      const real = tryRealpath(policy.defaultRoot);
      if (real) roots.push(real);
    }
    for (const extra of policy.extraRoots ?? []) {
      const real = tryRealpath(extra);
      if (real) roots.push(real);
    }
    this.allowedRoots = uniquePaths(roots);
  }

  /** Returns the configured allowed roots (after realpath normalization). */
  getAllowedRoots(): string[] {
    return [...this.allowedRoots];
  }

  /** Whether the policy is set to allow any path. */
  isOpen(): boolean {
    return this.allowAny;
  }

  /**
   * Check whether `requestedPath` is allowed. The path is resolved with
   * `realpath` before comparison so symlinks and `..` cannot smuggle the
   * target outside an allowed root. Returns `allowed: false` with the list
   * of allowed roots when the path is denied so callers can surface the
   * remediation hint in error messages.
   */
  check(requestedPath: string): AccessCheckResult {
    if (this.allowAny) {
      return { allowed: true };
    }
    if (this.allowedRoots.length === 0) {
      return {
        allowed: false,
        reason: 'No allowed project roots are configured for this MCP server.',
        allowedRoots: [],
      };
    }
    const real = tryRealpath(requestedPath);
    if (!real) {
      return {
        allowed: false,
        reason: `Could not resolve project path: ${requestedPath}`,
        allowedRoots: this.allowedRoots,
      };
    }
    for (const root of this.allowedRoots) {
      if (real === root || real.startsWith(root + path.sep)) {
        return { allowed: true };
      }
    }
    return {
      allowed: false,
      // Minimal user-facing message: do not include the resolved real path
      // of the requested target or the realpath'd allowed roots, since an
      // untrusted MCP client could otherwise probe canonical filesystem
      // layout via denial responses. The `allowedRoots` field below is
      // populated for programmatic consumers (server logs, diagnostics)
      // that already have host access.
      reason:
        `Project path is outside the configured allowed roots. ` +
        `Configure CODEGRAPH_MCP_ALLOW_ROOTS or pass --allow-root to ` +
        `\`codegraph serve --mcp\`.`,
      allowedRoots: this.allowedRoots,
    };
  }
}

function tryRealpath(p: string): string | null {
  try {
    return fs.realpathSync(path.resolve(p));
  } catch {
    return null;
  }
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

/**
 * Parse the `CODEGRAPH_MCP_ALLOW_ROOTS` env var into an array of extra
 * allowed roots. Uses the platform path delimiter — `:` on POSIX and `;` on
 * Windows — exclusively, so a single Windows drive-letter root like
 * `C:\repo` is not split into `["C", "\repo"]`.
 */
export function parseAllowRootsEnv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(path.delimiter)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Parse a truthy env value (`1`, `true`, `yes`, case-insensitive). */
export function parseAllowAnyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}
