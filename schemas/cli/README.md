# CodeGraph CLI JSON schemas (PF-613)

JSON Schema (draft-07) documents describing the shape of CodeGraph's
enveloped graph-intelligence `--json` outputs. Every payload that
goes through `cliJsonEnvelope` (`src/cli-json-envelope.ts`) carries
the shared **envelope** (`schemaVersion` + `tool`) plus one
tool-specific schema.

## In scope (enveloped graph-intelligence subcommands)

These eight subcommands emit enveloped JSON on the success result
path:

- `envelope.json` — shared `schemaVersion` + `tool` envelope.
- `status.json` — `codegraph status --json`.
- `search.json` — `codegraph query --json` (the CLI subcommand is
  `query`; the envelope's `tool` is `search`).
- `callers.json` — `codegraph callers --json`.
- `callees.json` — `codegraph callees --json`.
- `impact.json` — `codegraph impact --json` (includes the PF-606b
  `lowConfidenceEdges` annotation).
- `affected.json` — `codegraph affected --json`.
- `inventory.json` — `codegraph inventory --json` (wraps the
  PF-624 inventory payload under `inventory` so the inventory's own
  `schemaVersion` doesn't clobber the envelope's).
- `files.json` — `codegraph files --json`.

## Contract guarantee

Every `--json` invocation of an in-scope subcommand emits a valid
envelope on **every** result path — success, empty, not-found, and
input-validation success-with-no-input. The text branches still
print human-readable messages, but `--json` is contract-stable.

Not-found / empty paths surface extra optional fields so consumers
can branch on them without inspecting payload shape:

- `callers` / `callees` / `impact`: `notFound: true` when the
  symbol is not in the index. The result array (`callers`, `callees`,
  `affected`) is `[]` and `impact` reports `nodeCount: 0`,
  `edgeCount: 0`. Consumers can distinguish "symbol absent" from
  "symbol exists but result is empty".
- `files`: `reason` is `"not_indexed"` when the project IS
  initialized but the file index is empty (typically requires running
  `codegraph index`), or `"no_matches"` when filters left no rows.
  `files` is `[]`. A completely uninitialized project remains a
  plain-text error path with `process.exit(1)`.

`status` already emits `initialized: false` on the not-initialized
path; `affected` emits an empty envelope when no input files are
provided.

## Out of scope (separate emitters)

- `codegraph benchmark --json` does not flow through
  `cliJsonEnvelope`; its report shape is owned by
  `printBenchmarkReport` and is not covered by these schemas.
- Error paths that call `process.exit(1)` still emit a plain-text
  error to stderr; an enveloped JSON error variant is a follow-up.

## Versioning

The envelope's `schemaVersion: 1` covers the envelope CONTRACT —
the field names `schemaVersion` + `tool` — and is bumped only when
the envelope itself changes shape. The inventory payload carries
its own `schemaVersion` (from PF-624) describing the inventory
data shape; that version evolves independently of the envelope.

Per-tool schemas set `additionalProperties: true` at both the top
level and inside nested objects so payloads can grow without
breaking older consumers.

> **Schema posture:** schemas validate **known** fields (types,
> enums, required-vs-optional) but **do not reject unknown** top-level
> fields. This is intentional — adding an optional field to a future
> payload must not break consumers validating against today's schema.
> The trade-off is that emitter-side typos like `notFnd` instead of
> `notFound` are NOT caught by schema validation alone. The
> `cli-json-schemas.test.ts` suite asserts both schema validity AND
> the exact value of new optional flags (e.g.
> `expect(out.notFound).toBe(true)`) so typos surface at the emission
> boundary.

### Additive vs. breaking matrix

| Change to a per-tool payload                       | Bump envelope `schemaVersion`? |
| -------------------------------------------------- | ------------------------------ |
| Add an optional field                              | No                             |
| Add a required field                               | Yes                            |
| Remove or rename an existing field                 | Yes                            |
| Narrow a field's type (e.g. string → enum)         | Yes                            |
| Widen a field's type (e.g. add nullability)        | No                             |
| Reorder array items (without behavior change)      | No                             |
| Change an enum's allowed `tool` values             | Yes                            |

Inventory payload field changes follow the inventory schema's own
`schemaVersion`, not the envelope's, unless the wrapper key
(`inventory`) itself changes.

## Validation

`__tests__/cli-json-schemas.test.ts` validates real CLI output
against these schemas via `ajv`. The dist-binary cases are
skipped when `dist/bin/codegraph.js` is absent so contributors can
run `npm test` without a fresh build; the unconditional envelope
sanity test still locks the envelope shape on every run.

To run the full contract end-to-end (builds dist first):

```sh
npm run test:schemas
```
