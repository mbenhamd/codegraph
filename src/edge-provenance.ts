/**
 * Edge-confidence + resolver-provenance helpers (PF-606).
 *
 * Resolver metadata flows through to graph outputs so agents can branch on
 * uncertainty instead of treating every edge as ground truth. Confidence is
 * a number in [0, 1]; resolvedBy is one of the strategy tags emitted by
 * `src/resolution/`:
 *
 *   - `import`          — link came from an import statement in the caller's file.
 *   - `framework`       — framework resolver (Express route → handler, Convex
 *                          entrypoint, etc.). Confidence is set by the resolver.
 *   - `qualified-name`  — fully-qualified or `Module::method` style match.
 *   - `exact-match`     — same-name node match; confidence varies with
 *                          same-file / same-module / cross-module proximity.
 *   - `instance-method` — receiver-name + method-name heuristic match.
 *   - `file-path`       — path-like reference resolved to a file node.
 *   - `fuzzy`           — last-resort lowercase-name match; lowest confidence.
 *
 * High-confidence edges (≥0.9) are framework/import/qualified-name links the
 * resolver is sure about. The display format is compact: `[import 1.00]` or
 * `[fuzzy 0.30]`. Both the MCP graph-tool formatters and the CLI graph
 * subcommands consume these helpers so the surface stays in lockstep.
 */

import type { Edge } from './types';

export interface EdgeProvenance {
  resolvedBy?: string;
  confidence?: number;
}

/**
 * Extract validated resolver metadata from an edge. Returns an empty object
 * when the edge has no metadata, when the fields are missing, or when
 * `confidence` is non-finite. Callers can spread the result safely into JSON
 * outputs because absent fields are omitted rather than set to undefined.
 */
export function extractEdgeProvenance(edge: Edge | undefined): EdgeProvenance {
  if (!edge?.metadata) return {};
  const meta = edge.metadata as { confidence?: unknown; resolvedBy?: unknown };
  const out: EdgeProvenance = {};
  if (typeof meta.resolvedBy === 'string' && meta.resolvedBy.length > 0) {
    out.resolvedBy = meta.resolvedBy;
  }
  if (typeof meta.confidence === 'number' && Number.isFinite(meta.confidence)) {
    out.confidence = meta.confidence;
  }
  return out;
}

/**
 * Render a `{ resolvedBy?, confidence? }` pair as a compact
 * `[resolvedBy 0.85]` suffix. Returns '' when both fields are absent so
 * callers can append a separator only when the suffix is non-empty.
 */
export function formatProvenance(prov: EdgeProvenance): string {
  const { resolvedBy, confidence } = prov;
  if (resolvedBy && confidence !== undefined) {
    return `[${resolvedBy} ${confidence.toFixed(2)}]`;
  }
  if (resolvedBy) return `[${resolvedBy}]`;
  if (confidence !== undefined) return `[${confidence.toFixed(2)}]`;
  return '';
}

/**
 * Convenience: extract and format an edge's resolver metadata in one call.
 */
export function formatEdgeProvenance(edge: Edge | undefined): string {
  return formatProvenance(extractEdgeProvenance(edge));
}
