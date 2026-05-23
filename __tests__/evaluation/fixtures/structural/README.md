# Structural Eval Fixture

This fixture intentionally has no `node_modules`; framework detection currently
uses `package.json` and source patterns only. Keep it small and deterministic so
`npm run test:eval:structural` can build a temporary indexed copy during PR
validation.
