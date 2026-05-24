/**
 * PF-696 (Phase B): JSX className → CSS selector bridge tests.
 *
 * Two layers:
 *   1. Unit tests over the `extractJsxClassNames` walker against
 *      hand-built `Tree` parses (no DB, no resolver). Pin the
 *      definite-extraction rules.
 *   2. End-to-end fixtures via `CodeGraph.init` exercise the full
 *      pipeline: JSX file references resolve to selector nodes from
 *      the indexed CSS file.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars, getParser } from '../src/extraction/grammars';
import { extractJsxClassNames } from '../src/extraction/classname-extractor';
import type { Node } from '../src/types';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

interface ProjectFixture {
  dir: string;
  dbPath: string;
}

async function makeProject(files: Record<string, string>): Promise<ProjectFixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-pf696-'));
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

/**
 * Build a minimal container Node list pretending one big function
 * wraps the whole JSX. The walker uses this to attribute references
 * to a containing node; tests just need a non-null target.
 */
function dummyContainers(filePath: string, line: number): Node[] {
  return [
    {
      id: `function:test-component`,
      kind: 'function',
      name: 'TestComponent',
      qualifiedName: `${filePath}::TestComponent`,
      filePath,
      language: 'tsx',
      startLine: 1,
      endLine: line + 100,
      startColumn: 0,
      endColumn: 0,
      updatedAt: 0,
    },
  ];
}

function parse(source: string, lang: 'tsx' | 'jsx' = 'tsx'): { tree: ReturnType<NonNullable<ReturnType<typeof getParser>>['parse']>; source: string } {
  const parser = getParser(lang === 'tsx' ? 'tsx' : 'javascript');
  if (!parser) throw new Error(`No parser for ${lang}`);
  const tree = parser.parse(source);
  return { tree, source };
}

describe('PF-696: extractJsxClassNames (unit)', () => {
  it('extracts space-separated classes from a static string', () => {
    const src = `export function Card() {
  return <div className="feature-card feature-card__title">x</div>;
}
`;
    const { tree } = parse(src);
    const result = extractJsxClassNames(tree!, src, 'src/Card.tsx', dummyContainers('src/Card.tsx', 5), { tailwind: false });
    const names = result.references.map((r) => r.referenceName);
    expect(names).toContain('.feature-card');
    expect(names).toContain('.feature-card__title');
    expect(result.dynamicClassNodes.size).toBe(0);
  });

  it('extracts static parts of template literals and flags the node dynamic', () => {
    const src = "export function Btn() { const v = 'primary'; return <button className={`btn btn-${v}`}>x</button>; }\n";
    const { tree } = parse(src);
    const result = extractJsxClassNames(tree!, src, 'src/Btn.tsx', dummyContainers('src/Btn.tsx', 5), { tailwind: false });
    const names = result.references.map((r) => r.referenceName);
    expect(names).toContain('.btn');
    // The template substitution makes the component dynamic.
    expect(result.dynamicClassNodes.has('function:test-component')).toBe(true);
  });

  it('extracts string-literal args from cn() and clsx()', () => {
    const src = "import cn from 'classnames'; export function Card() { return <div className={cn('feature-card', 'feature-card__title')}>x</div>; }\n";
    const { tree } = parse(src);
    const result = extractJsxClassNames(tree!, src, 'src/Card.tsx', dummyContainers('src/Card.tsx', 5), { tailwind: false });
    const names = result.references.map((r) => r.referenceName);
    expect(names).toContain('.feature-card');
    expect(names).toContain('.feature-card__title');
  });

  it('drops non-string args from cn() and flags dynamic (no possible edges)', () => {
    // `condition && 'maybe-class'` is the "possible" case Codex's
    // opposing-case argued AGAINST modeling. We don't emit `.maybe-class`.
    const src = "export function Card({active}: {active: boolean}) { return <div className={cn('always', active && 'maybe-class')}>x</div>; }\n";
    const { tree } = parse(src);
    const result = extractJsxClassNames(tree!, src, 'src/Card.tsx', dummyContainers('src/Card.tsx', 5), { tailwind: false });
    const names = result.references.map((r) => r.referenceName);
    expect(names).toContain('.always');
    expect(names).not.toContain('.maybe-class');
    expect(result.dynamicClassNodes.has('function:test-component')).toBe(true);
  });

  it('drops Tailwind utility classes by default and keeps BEM ones', () => {
    const src = `export function Card() { return <div className="bg-blue-500 feature-card text-sm p-4">x</div>; }\n`;
    const { tree } = parse(src);
    const result = extractJsxClassNames(tree!, src, 'src/Card.tsx', dummyContainers('src/Card.tsx', 5), { tailwind: false });
    const names = result.references.map((r) => r.referenceName);
    expect(names).toContain('.feature-card');
    expect(names).not.toContain('.bg-blue-500');
    expect(names).not.toContain('.text-sm');
    expect(names).not.toContain('.p-4');
  });

  it('keeps Tailwind classes when tailwind: true', () => {
    const src = `export function Card() { return <div className="bg-blue-500 text-sm">x</div>; }\n`;
    const { tree } = parse(src);
    const result = extractJsxClassNames(tree!, src, 'src/Card.tsx', dummyContainers('src/Card.tsx', 5), { tailwind: true });
    const names = result.references.map((r) => r.referenceName);
    expect(names).toContain('.bg-blue-500');
    expect(names).toContain('.text-sm');
  });

  it('flags dynamic when className is an identifier or member expression', () => {
    const src = `export function Card({ cls }: { cls: string }) { return <div className={cls}>x</div>; }\n`;
    const { tree } = parse(src);
    const result = extractJsxClassNames(tree!, src, 'src/Card.tsx', dummyContainers('src/Card.tsx', 5), { tailwind: false });
    expect(result.references).toHaveLength(0);
    expect(result.dynamicClassNodes.has('function:test-component')).toBe(true);
  });

  it('keeps tokens with bare `$` (e.g. `feature-card--$primary` — Codex REVIEW fix)', () => {
    const src = `export function Card() { return <div className="feature-card--$primary">x</div>; }\n`;
    const { tree } = parse(src);
    const result = extractJsxClassNames(tree!, src, 'src/Card.tsx', dummyContainers('src/Card.tsx', 5), { tailwind: false });
    const names = result.references.map((r) => r.referenceName);
    expect(names).toContain('.feature-card--$primary');
  });

  it('still rejects tokens containing template-literal syntax (`${` or `}`)', () => {
    // Defense in depth — template literals normally come in via the
    // template_string node type and emit static fragments only, but
    // if a fragment ever leaks `${`/`}` characters through (parse
    // recovery on malformed JSX, escape sequences) we drop the token
    // rather than emit a garbage reference.
    const src = "export function Card() { return <div className={'\\$\\{x\\}'}>x</div>; }\n";
    const { tree } = parse(src);
    const result = extractJsxClassNames(tree!, src, 'src/Card.tsx', dummyContainers('src/Card.tsx', 5), { tailwind: false });
    // Implementation may or may not see this depending on tree-sitter's
    // string-escape handling; the contract is "no `${`/`}` tokens reach references".
    for (const r of result.references) {
      expect(r.referenceName.includes('${')).toBe(false);
      expect(r.referenceName.includes('}')).toBe(false);
    }
  });

  it('does not emit references for attributes other than className', () => {
    const src = `export function Card() { return <div id="x" data-foo="bar">y</div>; }\n`;
    const { tree } = parse(src);
    const result = extractJsxClassNames(tree!, src, 'src/Card.tsx', dummyContainers('src/Card.tsx', 5), { tailwind: false });
    expect(result.references).toHaveLength(0);
    expect(result.dynamicClassNodes.size).toBe(0);
  });
});

describe('PF-696: end-to-end via CodeGraph.init', () => {
  let fixture: ProjectFixture | undefined;

  beforeEach(() => {
    fixture = undefined;
  });

  afterEach(() => {
    cleanup(fixture);
  });

  it('resolves JSX className references to selector nodes in the indexed CSS', async () => {
    fixture = await makeProject({
      'src/styles/feature-card.css': `.feature-card { padding: 12px; }
.feature-card__title { font-weight: bold; }
`,
      'src/components/Card.tsx':
        'export function Card() {\n' +
        '  return <article className="feature-card">\n' +
        '    <h2 className="feature-card__title">Hello</h2>\n' +
        '  </article>;\n' +
        '}\n',
    });
    // Read DB directly: assert references to selector nodes exist.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (p: string) => { prepare: (s: string) => { all: (...a: unknown[]) => unknown[] }; close: () => void };
    };
    const db = new DatabaseSync(fixture.dbPath);
    const edges = db
      .prepare(`SELECT e.kind, e.source, e.target, ns.name AS src_name, nt.name AS tgt_name, nt.kind AS tgt_kind
                FROM edges e
                JOIN nodes ns ON ns.id = e.source
                JOIN nodes nt ON nt.id = e.target
                WHERE e.kind = 'references' AND nt.kind = 'selector'`)
      .all() as Array<{ src_name: string; tgt_name: string; tgt_kind: string }>;
    db.close();
    const targets = edges.map((e) => e.tgt_name);
    expect(targets, `expected references to selector nodes; got edges: ${JSON.stringify(edges)}`).toContain('.feature-card');
    expect(targets).toContain('.feature-card__title');
  });
});

describe('PF-696: Phase B MCP tools', () => {
  let fixture: ProjectFixture | undefined;

  beforeEach(() => {
    fixture = undefined;
  });

  afterEach(() => {
    cleanup(fixture);
  });

  it('codegraph_component_styles surfaces a component\'s CSS classes', async () => {
    fixture = await makeProject({
      'src/styles/feature.css': `.feature-card { padding: 12px; }
.feature-card__title { font-weight: bold; }
`,
      'src/components/Card.tsx':
        'export function Card() {\n' +
        '  return <article className="feature-card">\n' +
        '    <h2 className="feature-card__title">Hello</h2>\n' +
        '  </article>;\n' +
        '}\n',
    });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ToolHandler } = await import('../src/mcp/tools');
    const handler = new ToolHandler(null);
    const result = await handler.execute('codegraph_component_styles', {
      projectPath: fixture.dir,
      component: 'Card',
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text as string;
    expect(text).toContain('## CSS classes applied by `Card`');
    expect(text).toContain('.feature-card');
    expect(text).toContain('.feature-card__title');
  });

  it('codegraph_class_consumers surfaces JSX consumers of a class', async () => {
    fixture = await makeProject({
      'src/styles/feature.css': '.feature-card__title { font-weight: bold; }\n',
      'src/components/Card.tsx':
        'export function Card() {\n' +
        '  return <h2 className="feature-card__title">Hi</h2>;\n' +
        '}\n',
      'src/components/Other.tsx':
        'export function OtherComponent() {\n' +
        '  return <span className="feature-card__title">Title</span>;\n' +
        '}\n',
    });
    const { ToolHandler } = await import('../src/mcp/tools');
    const handler = new ToolHandler(null);
    const result = await handler.execute('codegraph_class_consumers', {
      projectPath: fixture.dir,
      className: '.feature-card__title',
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text as string;
    expect(text).toContain('## Components consuming `.feature-card__title`');
    // Both Card and OtherComponent should appear.
    expect(text).toMatch(/Card/);
    expect(text).toMatch(/OtherComponent/);
  });

  it('codegraph_class_consumers accepts bare class names (auto-prefixes .)', async () => {
    fixture = await makeProject({
      'src/styles/feature.css': '.feature-card { padding: 12px; }\n',
      'src/components/Card.tsx':
        'export function Card() {\n' +
        '  return <div className="feature-card">x</div>;\n' +
        '}\n',
    });
    const { ToolHandler } = await import('../src/mcp/tools');
    const handler = new ToolHandler(null);
    const result = await handler.execute('codegraph_class_consumers', {
      projectPath: fixture.dir,
      className: 'feature-card', // no leading dot
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text as string;
    expect(text).toContain('## Components consuming `.feature-card`');
    expect(text).toMatch(/Card/);
  });

  it('codegraph_unused_selectors lists CSS classes never referenced by JSX', async () => {
    fixture = await makeProject({
      'src/styles/feature.css': `.used { color: red; }
.never-referenced { color: blue; }
.also-unused { color: green; }
`,
      'src/components/Card.tsx':
        'export function Card() {\n' +
        '  return <div className="used">x</div>;\n' +
        '}\n',
    });
    const { ToolHandler } = await import('../src/mcp/tools');
    const handler = new ToolHandler(null);
    const result = await handler.execute('codegraph_unused_selectors', {
      projectPath: fixture.dir,
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text as string;
    expect(text).toContain('## CSS selectors with zero JSX consumers');
    expect(text).toContain('.never-referenced');
    expect(text).toContain('.also-unused');
    expect(text).not.toMatch(/^- `\.used`/m); // .used has a consumer; shouldn't be listed
  });
});
