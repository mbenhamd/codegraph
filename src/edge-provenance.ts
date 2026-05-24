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

/**
 * Default low-confidence threshold for impact-radius and blast-radius
 * annotations. Edges with `confidence < 0.5` (cross-module exact-match,
 * fuzzy, partial-overlap instance-method) are the ones a user should
 * double-check against source rather than treat as ground truth.
 */
export const LOW_CONFIDENCE_THRESHOLD = 0.5;

/**
 * A single low-confidence edge example surfaced in impact / blast-radius
 * annotations. Keep fields small + JSON-serializable so MCP and CLI can
 * use the same struct directly.
 */
export interface LowConfidenceEdge {
  source: string;
  target: string;
  kind: string;
  resolvedBy?: string;
  confidence: number;
  line?: number;
}

/**
 * Summary of low-confidence edges in a subgraph (PF-606 follow-up).
 * `count` is the total edges with `confidence < threshold`. `examples`
 * is a small, deterministic sample (sorted by confidence ascending then
 * source/target/kind) so identical traversals produce identical output.
 */
export interface LowConfidenceSummary {
  count: number;
  threshold: number;
  examples: LowConfidenceEdge[];
}

/**
 * Walk edges, return a summary of those whose resolver metadata
 * reports a confidence below `threshold`. Edges with no confidence
 * metadata (contains/exports/imports synth, etc.) are not counted —
 * "unknown" is intentionally not treated as "low" so the annotation
 * stays focused on the actual uncertainty signal.
 */
export function summarizeLowConfidenceEdges(
  edges: Iterable<Edge>,
  options?: { threshold?: number; maxExamples?: number },
): LowConfidenceSummary {
  const threshold = options?.threshold ?? LOW_CONFIDENCE_THRESHOLD;
  const maxExamples = options?.maxExamples ?? 5;

  const lowConfidence: LowConfidenceEdge[] = [];
  for (const edge of edges) {
    const prov = extractEdgeProvenance(edge);
    if (prov.confidence === undefined || prov.confidence >= threshold) continue;
    lowConfidence.push({
      source: edge.source,
      target: edge.target,
      kind: edge.kind,
      confidence: prov.confidence,
      ...(prov.resolvedBy ? { resolvedBy: prov.resolvedBy } : {}),
      ...(edge.line !== undefined && edge.line !== null ? { line: edge.line } : {}),
    });
  }

  // Deterministic ordering: lowest-confidence first, then alphabetical
  // (source, target, kind) so test fixtures don't depend on iteration order.
  lowConfidence.sort((a, b) => {
    if (a.confidence !== b.confidence) return a.confidence - b.confidence;
    if (a.source !== b.source) return a.source.localeCompare(b.source);
    if (a.target !== b.target) return a.target.localeCompare(b.target);
    return a.kind.localeCompare(b.kind);
  });

  return {
    count: lowConfidence.length,
    threshold,
    examples: lowConfidence.slice(0, maxExamples),
  };
}
