# Framework resolver contract fixtures (PF-617)

Fixture-driven golden tests for `FrameworkResolver.extract()` — they
lock the FULL output shape (`{ nodes, references }`) across
ecosystems and complement the per-resolver unit tests in
`__tests__/frameworks.test.ts`.

Each fixture is one directory:

```
<fixture-name>/
├── source.<ext>      synthetic minimal source the resolver sees
├── meta.json         { resolver, sourcePath, description? }
└── expected.json     golden { nodes, references } payload
```

Goldens are deterministic: every emitted `Node.id` is built from
fixture inputs by the route extractors — strings like
`route:${sourcePath}:${line}:${method}:${routePath}` (Python,
Java, etc.) — so re-running without source changes reproduces the
same JSON byte-for-byte. The harness strips `Node.updatedAt` (a
wall-clock timestamp set by extractors) from the nodes array before
comparison; everything else is part of the contract.

## Adding a fixture

1. Create `<fixture-name>/source.<ext>` with the smallest possible
   snippet that exercises the resolver behavior. Comments are fine
   when they clarify intent.
2. Write `<fixture-name>/meta.json` with `resolver` (the registered
   resolver key — see `RESOLVERS` in
   `__tests__/framework-contract-harness.test.ts`), `sourcePath` (the
   project-relative path the resolver should see), and an optional
   `description`.
3. Capture the initial golden:

   ```sh
   UPDATE_FRAMEWORK_GOLDENS=1 npm test -- framework-contract-harness
   ```

   The harness writes `expected.json`. Read it, confirm it matches
   what the contract should be, and commit.
4. Subsequent runs (without `UPDATE_FRAMEWORK_GOLDENS`) compare
   resolver output to the golden and fail with a clear diff on
   regression.

## Refreshing a golden

When the resolver contract changes legitimately (e.g. a new edge
kind, an additional column tracked, a renamed field), run the same
`UPDATE_FRAMEWORK_GOLDENS=1` command — the harness rewrites all
`expected.json` files. Inspect the diff carefully before committing:
goldens are the strongest line of defense against accidental
contract drift.

## Registering a new resolver

If the new fixture targets a framework whose resolver isn't already
in the harness's `RESOLVERS` map, add the import + map entry at the
top of `framework-contract-harness.test.ts`. No other harness changes
are needed.
