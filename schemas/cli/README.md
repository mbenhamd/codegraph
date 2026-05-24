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

## Out of scope (separate emitters)

- `codegraph benchmark --json` does not flow through
  `cliJsonEnvelope`; its report shape is owned by `printBenchmarkReport`
  and is not covered by these schemas.
- Some subcommands print a plain-text "no result" line and return
  without emitting any JSON when the symbol/file is missing or the
  result is empty (e.g. `callers`/`callees`/`impact` with an unknown
  symbol; `files` with no matches). These not-found branches are
  intentional and are not exercised by the contract tests. Wrapping
  them in an enveloped empty payload would be a follow-up PR, not
  part of this contract slice.

## Versioning

The envelope's `schemaVersion: 1` covers the envelope CONTRACT —
the field names `schemaVersion` + `tool` — and is bumped only when
the envelope itself changes shape. The inventory payload carries
its own `schemaVersion` (from PF-624) describing the inventory
data shape; that version evolves independently of the envelope.

Per-tool schemas set `additionalProperties: true` at both the top
level and inside nested objects so payloads can grow without
breaking older consumers.

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
