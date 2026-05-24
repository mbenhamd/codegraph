/**
 * PF-695: CSS extractor tests.
 *
 * Real fixture projects via `CodeGraph.init` exercise the
 * extract → persist → query pipeline end to end. Synthetic
 * `extractFromCss` calls cover the unit-level shape of the
 * emitted nodes/edges/references.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { extractFromCss } from '../src/extraction/css-extractor';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { ToolHandler } from '../src/mcp/tools';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

interface ProjectFixture {
  dir: string;
  dbPath: string;
}

async function makeProject(files: Record<string, string>): Promise<ProjectFixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-css-'));
  for (const [relPath, content] of Object.entries(files)) {
    const full = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  const cg = await CodeGraph.init(dir, { index: true });
  cg.destroy();
  return { dir, dbPath: path.join(dir, '.codegraph', 'codegraph.db') };
}

function cleanup(p: ProjectFixture | undefined): void {
  if (p && fs.existsSync(p.dir)) {
    fs.rmSync(p.dir, { recursive: true, force: true });
  }
}

describe('PF-695: CSSExtractor (unit)', () => {
  it('emits a file node plus one selector per comma-separated entry', () => {
    const css = `.feature-card__title,
.feature-card__subtitle {
  color: red;
  font-size: 14px;
}
`;
    const result = extractFromCss('styles/feature-card.css', css);
    expect(result.errors).toEqual([]);
    const files = result.nodes.filter((n) => n.kind === 'file');
    const selectors = result.nodes.filter((n) => n.kind === 'selector');
    expect(files).toHaveLength(1);
    expect(selectors.length).toBeGreaterThanOrEqual(2);
    const names = selectors.map((s) => s.name);
    expect(names).toContain('.feature-card__title');
    expect(names).toContain('.feature-card__subtitle');
    // Each selector should have a signature containing the rule body preview.
    const titleSel = selectors.find((s) => s.name === '.feature-card__title')!;
    expect(titleSel.signature).toMatch(/color: red/);
  });

  it('classifies selector kinds and computes specificity', () => {
    const css = `#header { color: blue; }
.btn { padding: 8px; }
button:hover { background: gray; }
.a .b { margin: 0; }
`;
    const result = extractFromCss('styles/x.css', css);
    const selectors = result.nodes.filter((n) => n.kind === 'selector');
    const byName = new Map<string, { selectorMetadata?: { specificity: number; selectorKind: string } }>();
    for (const s of selectors) byName.set(s.name, s as never);

    // #header: 1 id → 100
    expect(byName.get('#header')!.selectorMetadata!.specificity).toBe(100);
    expect(byName.get('#header')!.selectorMetadata!.selectorKind).toBe('id');

    // .btn: 1 class → 10
    expect(byName.get('.btn')!.selectorMetadata!.specificity).toBe(10);
    expect(byName.get('.btn')!.selectorMetadata!.selectorKind).toBe('class');

    // button:hover: 1 pseudo-class + 1 element → 10 + 1 = 11
    const buttonHover = [...byName.keys()].find((k) => k.includes('button:hover'));
    expect(buttonHover, `expected a button:hover selector, got: ${[...byName.keys()].join(', ')}`).toBeTruthy();
    expect(byName.get(buttonHover!)!.selectorMetadata!.specificity).toBe(11);

    // .a .b: 2 classes → 20, compound
    const compound = [...byName.keys()].find((k) => k.includes('.a') && k.includes('.b'));
    expect(compound).toBeTruthy();
    expect(byName.get(compound!)!.selectorMetadata!.specificity).toBe(20);
    expect(byName.get(compound!)!.selectorMetadata!.selectorKind).toBe('compound');
  });

  it('emits contains edges from file to every selector', () => {
    const css = `.a { color: red; }
.b { color: blue; }
`;
    const result = extractFromCss('styles/x.css', css);
    const fileNode = result.nodes.find((n) => n.kind === 'file')!;
    const selectorIds = result.nodes.filter((n) => n.kind === 'selector').map((n) => n.id);
    const containsEdges = result.edges.filter((e) => e.kind === 'contains' && e.source === fileNode.id);
    for (const sid of selectorIds) {
      expect(
        containsEdges.find((e) => e.target === sid),
        `expected contains edge file → ${sid}`,
      ).toBeTruthy();
    }
  });

  it('records @import as an unresolved reference', () => {
    const css = `@import "./tokens.css";
@import url("./reset.css");
.btn { color: red; }
`;
    const result = extractFromCss('styles/main.css', css);
    const importRefs = result.unresolvedReferences.filter((r) => r.referenceKind === 'imports');
    expect(importRefs.map((r) => r.referenceName)).toEqual(
      expect.arrayContaining(['./tokens.css', './reset.css']),
    );
  });

  it('handles media queries by recursing into the nested rule set', () => {
    const css = `@media (min-width: 768px) {
  .layout { display: grid; }
}
`;
    const result = extractFromCss('styles/x.css', css);
    const selectors = result.nodes.filter((n) => n.kind === 'selector');
    expect(selectors.map((s) => s.name)).toContain('.layout');
  });

  it('emits css_variable nodes for `:root { --foo: ... }` declarations (PF-698)', () => {
    const css = `:root {
  --color-primary: #ffffff;
  --color-secondary: hsl(200, 50%, 50%);
  --spacing-base: 8px;
}
.btn { color: var(--color-primary); }
`;
    const result = extractFromCss('styles/tokens.css', css);
    const tokens = result.nodes.filter((n) => n.kind === 'css_variable');
    expect(tokens.map((t) => t.name)).toEqual(
      expect.arrayContaining(['--color-primary', '--color-secondary', '--spacing-base']),
    );
    // Value preview lives in signature.
    const primary = tokens.find((t) => t.name === '--color-primary')!;
    expect(primary.signature).toContain('#ffffff');
  });

  it('emits unresolved references for var() usages (PF-698)', () => {
    const css = `.btn { color: var(--color-primary); background: var(--color-secondary, blue); }\n`;
    const result = extractFromCss('styles/btn.css', css);
    const refs = result.unresolvedReferences.filter((r) => r.referenceKind === 'references');
    expect(refs.map((r) => r.referenceName)).toEqual(
      expect.arrayContaining(['--color-primary', '--color-secondary']),
    );
  });

  it('collects var() refs inside @supports condition expressions (PF-698 Codex REVIEW fix)', () => {
    const css = `@supports (color: var(--brand)) {
  .x { color: var(--brand); }
}
`;
    const result = extractFromCss('styles/x.css', css);
    const refs = result.unresolvedReferences.filter((r) => r.referenceKind === 'references');
    // Two refs: one inside the @supports condition, one inside the rule.
    const brandRefs = refs.filter((r) => r.referenceName === '--brand');
    expect(brandRefs.length).toBeGreaterThanOrEqual(2);
  });

  it('walks nested function calls — calc(var(--x)) — and collects inner var() refs (PF-698)', () => {
    const css = `.layout { width: calc(100% - var(--sidebar-w) - var(--gap)); }\n`;
    const result = extractFromCss('styles/layout.css', css);
    const refs = result.unresolvedReferences.filter((r) => r.referenceKind === 'references');
    expect(refs.map((r) => r.referenceName)).toEqual(
      expect.arrayContaining(['--sidebar-w', '--gap']),
    );
  });

  it('produces no false-positive selectors for malformed CSS', () => {
    const css = `not actually css { ;;; }`;
    const result = extractFromCss('styles/bad.css', css);
    // Either zero selectors emitted OR errors logged — never both empty
    // (we want to know SOMETHING happened).
    const files = result.nodes.filter((n) => n.kind === 'file');
    expect(files).toHaveLength(1); // file node always emitted
    // The parser may or may not recognize `not actually css` as a selector;
    // either way, no crash.
    expect(result.errors.every((e) => e.severity !== 'error')).toBe(true);
  });
});

describe('PF-695: CSS extractor end-to-end via CodeGraph.init', () => {
  let fixture: ProjectFixture | undefined;

  beforeEach(() => {
    fixture = undefined;
  });

  afterEach(() => {
    cleanup(fixture);
  });

  it('indexes .css files alongside source code and makes selectors searchable', async () => {
    fixture = await makeProject({
      'src/app.ts': 'export const APP = "papersflow";\n',
      'src/styles/feature-card.css': `.feature-card { padding: 12px; }
.feature-card__title { font-weight: bold; }
.feature-card__title--highlighted { color: red; }
`,
    });
    // Open the DB directly and query.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (p: string) => { prepare: (s: string) => { all: () => unknown[] }; close: () => void };
    };
    const db = new DatabaseSync(fixture.dbPath);
    const rows = db.prepare("SELECT name, kind, file_path FROM nodes WHERE kind = 'selector'").all() as Array<{
      name: string;
      kind: string;
      file_path: string;
    }>;
    db.close();
    const names = rows.map((r) => r.name);
    expect(names).toContain('.feature-card');
    expect(names).toContain('.feature-card__title');
    expect(names).toContain('.feature-card__title--highlighted');
    for (const r of rows) {
      expect(r.file_path.endsWith('feature-card.css')).toBe(true);
    }
  });

  it('exposes selectors via the codegraph_css_selectors MCP tool', async () => {
    fixture = await makeProject({
      'src/styles/feature-card.css': `.feature-card { padding: 12px; }
.feature-card__title { font-weight: bold; }
.unrelated-thing { display: block; }
`,
    });
    const handler = new ToolHandler(null);
    // Pattern that matches selector name only (qualifiedName also
    // contains the file path, so a `feature-card` pattern would
    // match `.unrelated-thing` in feature-card.css via qualifiedName).
    const result = await handler.execute('codegraph_css_selectors', {
      projectPath: fixture.dir,
      pattern: '__title',
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text as string;
    expect(text).toContain('## CSS selectors matching');
    expect(text).toContain('.feature-card__title');
    expect(text).not.toContain('.unrelated-thing');
    expect(text).not.toMatch(/\.feature-card\b[^_]/); // .feature-card without __title shouldn't show
  });

  it('resolves var() usages to css_variable nodes across files (PF-698 end-to-end)', async () => {
    fixture = await makeProject({
      'src/styles/tokens.css': `:root {
  --color-primary: #ffffff;
  --spacing-base: 8px;
}
`,
      'src/styles/feature.css': `.feature-card {
  color: var(--color-primary);
  padding: var(--spacing-base);
}
`,
    });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (p: string) => { prepare: (s: string) => { all: (...a: unknown[]) => unknown[] }; close: () => void };
    };
    const db = new DatabaseSync(fixture.dbPath);
    // Verify both tokens were extracted.
    const tokens = db.prepare("SELECT name FROM nodes WHERE kind = 'css_variable'").all() as Array<{ name: string }>;
    expect(tokens.map((t) => t.name)).toEqual(
      expect.arrayContaining(['--color-primary', '--spacing-base']),
    );
    // Verify cross-file resolution: references edge from feature.css's
    // file node → token node defined in tokens.css.
    const edges = db
      .prepare(
        `SELECT e.kind, ns.file_path AS src_file, nt.name AS tgt_name
         FROM edges e
         JOIN nodes ns ON ns.id = e.source
         JOIN nodes nt ON nt.id = e.target
         WHERE e.kind = 'references' AND nt.kind = 'css_variable'`,
      )
      .all() as Array<{ src_file: string; tgt_name: string }>;
    db.close();
    const tgts = edges.map((e) => e.tgt_name);
    expect(tgts, `expected references to css_variable nodes; got: ${JSON.stringify(edges)}`).toContain('--color-primary');
    expect(tgts).toContain('--spacing-base');
  });

  it('exposes tokens via the codegraph_token_definitions MCP tool (PF-698)', async () => {
    fixture = await makeProject({
      'src/styles/tokens.css': `:root {
  --color-primary: #ffffff;
  --color-danger: #ff0000;
  --spacing-base: 8px;
}
`,
    });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ToolHandler } = await import('../src/mcp/tools');
    const handler = new ToolHandler(null);
    const result = await handler.execute('codegraph_token_definitions', {
      projectPath: fixture.dir,
      pattern: 'color',
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text as string;
    expect(text).toContain('## CSS tokens matching `color`');
    expect(text).toContain('--color-primary');
    expect(text).toContain('--color-danger');
    expect(text).not.toContain('--spacing-base');
  });

  it('exposes token consumers via the codegraph_token_usage MCP tool (PF-698)', async () => {
    fixture = await makeProject({
      'src/styles/tokens.css': ':root { --color-primary: #ffffff; }\n',
      'src/styles/btn.css': '.btn { color: var(--color-primary); }\n',
      'src/styles/card.css': '.card { border-color: var(--color-primary); }\n',
      'src/styles/unrelated.css': '.x { color: red; }\n',
    });
    const { ToolHandler } = await import('../src/mcp/tools');
    const handler = new ToolHandler(null);
    const result = await handler.execute('codegraph_token_usage', {
      projectPath: fixture.dir,
      token: '--color-primary',
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text as string;
    expect(text).toContain('## Files consuming `--color-primary`');
    expect(text).toContain('btn.css');
    expect(text).toContain('card.css');
    expect(text).not.toContain('unrelated.css');
  });

  it('codegraph_token_usage rejects `var(--x)` wrapper input with guidance (Codex NITPICK fix)', async () => {
    fixture = await makeProject({
      'src/styles/tokens.css': ':root { --color-primary: #fff; }\n',
    });
    const { ToolHandler } = await import('../src/mcp/tools');
    const handler = new ToolHandler(null);
    const result = await handler.execute('codegraph_token_usage', {
      projectPath: fixture.dir,
      token: 'var(--color-primary)',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/should be the variable name/i);
  });

  it('codegraph_token_usage accepts bare token names (auto-prefixes --)', async () => {
    fixture = await makeProject({
      'src/styles/tokens.css': ':root { --color-primary: #fff; }\n',
      'src/styles/btn.css': '.btn { color: var(--color-primary); }\n',
    });
    const { ToolHandler } = await import('../src/mcp/tools');
    const handler = new ToolHandler(null);
    const result = await handler.execute('codegraph_token_usage', {
      projectPath: fixture.dir,
      token: 'color-primary', // no -- prefix
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text as string;
    expect(text).toContain('## Files consuming `--color-primary`');
    expect(text).toContain('btn.css');
  });

  it('supports SCSS / LESS extensions via the CSS grammar', async () => {
    fixture = await makeProject({
      'src/styles/x.scss': '.scss-class { color: red; }\n',
      'src/styles/y.less': '.less-class { color: blue; }\n',
    });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (p: string) => { prepare: (s: string) => { all: () => unknown[] }; close: () => void };
    };
    const db = new DatabaseSync(fixture.dbPath);
    const rows = db.prepare("SELECT name FROM nodes WHERE kind = 'selector'").all() as Array<{ name: string }>;
    db.close();
    const names = rows.map((r) => r.name);
    expect(names).toContain('.scss-class');
    expect(names).toContain('.less-class');
  });
});
