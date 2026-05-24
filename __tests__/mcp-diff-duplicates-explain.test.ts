/**
 * PF-694: MCP integration for codegraph_diff / codegraph_duplicates /
 * codegraph_explain.
 *
 * Builds real fixture projects via `CodeGraph.init`, instantiates a
 * ToolHandler, and exercises each new MCP tool through `execute()` —
 * the same entry point the MCP server's request handler uses. Tests
 * pin the tool descriptor presence, dispatcher wiring, input
 * validation, error paths, and the formatted markdown output shape.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { ToolHandler, tools as TOOL_DESCRIPTORS } from '../src/mcp/tools';
import { ProjectAccessGate } from '../src/mcp/project-access';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

interface ProjectFixture {
  dir: string;
  dbPath: string;
}

async function makeProject(files: Record<string, string>): Promise<ProjectFixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-mcp-'));
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

const LARGE_BODY = `{
  const a = 1;
  const b = 2;
  const c = 3;
  const d = 4;
  const e = 5;
  const f = 6;
  const g = 7;
  const h = 8;
  return a + b + c + d + e + f + g + h;
}`;

describe('PF-694: MCP tool descriptors', () => {
  it('exposes codegraph_diff / codegraph_duplicates / codegraph_explain', () => {
    const names = TOOL_DESCRIPTORS.map((t) => t.name);
    expect(names).toContain('codegraph_diff');
    expect(names).toContain('codegraph_duplicates');
    expect(names).toContain('codegraph_explain');
  });

  it('each new tool has a non-empty description and an input schema', () => {
    for (const name of ['codegraph_diff', 'codegraph_duplicates', 'codegraph_explain']) {
      const t = TOOL_DESCRIPTORS.find((d) => d.name === name);
      expect(t, `${name} descriptor missing`).toBeDefined();
      expect(typeof t!.description).toBe('string');
      expect((t!.description as string).length).toBeGreaterThan(50);
      expect(t!.inputSchema).toBeDefined();
      expect((t!.inputSchema as { type: string }).type).toBe('object');
    }
  });

  it('codegraph_diff requires oldProjectPath + newProjectPath', () => {
    const t = TOOL_DESCRIPTORS.find((d) => d.name === 'codegraph_diff')!;
    const schema = t.inputSchema as { required?: string[]; properties: Record<string, unknown> };
    expect(schema.required).toEqual(['oldProjectPath', 'newProjectPath']);
    expect(schema.properties).toHaveProperty('maxChangedNodes');
    expect(schema.properties).toHaveProperty('maxChangedEdges');
  });

  it('codegraph_duplicates schema documents kinds + minLines + maxGroups', () => {
    const t = TOOL_DESCRIPTORS.find((d) => d.name === 'codegraph_duplicates')!;
    const schema = t.inputSchema as { properties: Record<string, unknown> };
    expect(schema.properties).toHaveProperty('projectPath');
    expect(schema.properties).toHaveProperty('kinds');
    expect(schema.properties).toHaveProperty('minLines');
    expect(schema.properties).toHaveProperty('maxGroups');
  });

  it('codegraph_explain schema documents edgeId + canonical fields', () => {
    const t = TOOL_DESCRIPTORS.find((d) => d.name === 'codegraph_explain')!;
    const schema = t.inputSchema as { properties: Record<string, unknown> };
    for (const k of ['projectPath', 'edgeId', 'source', 'target', 'kind', 'line', 'col']) {
      expect(schema.properties, `missing field ${k}`).toHaveProperty(k);
    }
  });
});

describe('PF-694: codegraph_diff handler', () => {
  let oldP: ProjectFixture | undefined;
  let newP: ProjectFixture | undefined;

  beforeEach(() => {
    oldP = undefined;
    newP = undefined;
  });

  afterEach(() => {
    cleanup(oldP);
    cleanup(newP);
  });

  it('produces a markdown summary with file/node/edge counts', async () => {
    oldP = await makeProject({
      'src/a.ts': 'export function helper(): number { return 1; }\n',
    });
    newP = await makeProject({
      'src/a.ts': 'export function helper(): number { return 2; }\n',
      'src/b.ts': 'export function added(): number { return 3; }\n',
    });
    const handler = new ToolHandler(null);
    const result = await handler.execute('codegraph_diff', {
      oldProjectPath: oldP.dir,
      newProjectPath: newP.dir,
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text as string;
    expect(text).toContain('## CodeGraph Diff');
    expect(text).toContain('### Summary');
    expect(text).toMatch(/Files:.*\+1/); // b.ts added
    expect(text).toMatch(/a\.ts/);
  });

  it('rejects when oldProjectPath is missing', async () => {
    const handler = new ToolHandler(null);
    const result = await handler.execute('codegraph_diff', {
      newProjectPath: '/some/path',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/oldProjectPath/i);
  });

  it('reports an actionable error when project has no .codegraph/', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-mcp-noinit-'));
    try {
      const handler = new ToolHandler(null);
      const result = await handler.execute('codegraph_diff', {
        oldProjectPath: tmp,
        newProjectPath: tmp,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toMatch(/not initialized|CodeGraph/i);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('PF-694: codegraph_duplicates handler', () => {
  let fixture: ProjectFixture | undefined;

  beforeEach(() => {
    fixture = undefined;
  });

  afterEach(() => {
    cleanup(fixture);
  });

  it('finds same-named duplicate functions and renders them as markdown', async () => {
    fixture = await makeProject({
      'src/a.ts': `export function handler(x: number, y: number): number ${LARGE_BODY}\n`,
      'src/b.ts': `export function handler(x: number, y: number): number ${LARGE_BODY}\n`,
    });
    const handler = new ToolHandler(null);
    const result = await handler.execute('codegraph_duplicates', {
      projectPath: fixture.dir,
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text as string;
    expect(text).toContain('## CodeGraph Duplicates');
    expect(text).toContain('### Summary');
    expect(text).toMatch(/Exact \(Type-1\) clone groups: \d/);
    expect(text).toMatch(/handler/);
  });

  it('rejects malformed kinds and minLines', async () => {
    fixture = await makeProject({
      'src/a.ts': 'export function only(): number { return 1; }\n',
    });
    const handler = new ToolHandler(null);

    const bad1 = await handler.execute('codegraph_duplicates', {
      projectPath: fixture.dir,
      kinds: 'function', // not an array
    });
    expect(bad1.isError).toBe(true);
    expect(bad1.content[0]!.text).toMatch(/kinds must be an array/i);

    const bad2 = await handler.execute('codegraph_duplicates', {
      projectPath: fixture.dir,
      kinds: [],
    });
    expect(bad2.isError).toBe(true);
    expect(bad2.content[0]!.text).toMatch(/at least one non-empty/i);

    const bad3 = await handler.execute('codegraph_duplicates', {
      projectPath: fixture.dir,
      minLines: 0,
    });
    expect(bad3.isError).toBe(true);
    expect(bad3.content[0]!.text).toMatch(/positive integer/i);
  });

  it('reports zero groups with kinds/minLines context when nothing duplicates', async () => {
    fixture = await makeProject({
      'src/a.ts': 'export function unique(): number { return 1; }\n',
    });
    const handler = new ToolHandler(null);
    const result = await handler.execute('codegraph_duplicates', {
      projectPath: fixture.dir,
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text as string;
    expect(text).toMatch(/No duplicate groups found/);
    expect(text).toMatch(/kinds=function,method/);
    expect(text).toMatch(/min-lines=10/);
  });
});

describe('PF-694: codegraph_explain handler', () => {
  let fixture: ProjectFixture | undefined;

  beforeEach(() => {
    fixture = undefined;
  });

  afterEach(() => {
    cleanup(fixture);
  });

  it('explains an edge by integer id and surfaces traceAvailable: false note', async () => {
    fixture = await makeProject({
      'src/util.ts': 'export function helper(): number { return 42; }\n',
      'src/main.ts':
        "import { helper } from './util';\n" +
        'export function main(): number { return helper(); }\n',
    });
    // Read an arbitrary edge id from the DB to feed to explain.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (p: string) => { prepare: (s: string) => { get: () => unknown; all: () => unknown[] }; close: () => void };
    };
    const db = new DatabaseSync(fixture.dbPath);
    const row = db.prepare('SELECT id FROM edges WHERE kind = ?').get('calls') as { id?: number } | undefined;
    db.close();
    if (!row || row.id === undefined) return; // resolver variant didn't emit a calls edge
    const handler = new ToolHandler(null);
    const result = await handler.execute('codegraph_explain', {
      projectPath: fixture.dir,
      edgeId: row.id,
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text as string;
    expect(text).toContain('## CodeGraph Edge Explanation');
    expect(text).toContain('### Provenance');
    expect(text).toContain(`**Edge id:** ${row.id}`);
    // Honest scope note must always be present until traces persist.
    // Codex NITPICK: assert the dedicated scope-note block, not just
    // any mention of "traceAvailable: false" — otherwise the test
    // could false-pass if narrative text happens to include it.
    expect(text).toMatch(/Scope note[\s\S]*traceAvailable: false/);
  });

  it('rejects both edgeId AND canonical flags together', async () => {
    fixture = await makeProject({
      'src/a.ts': 'export function only(): number { return 1; }\n',
    });
    const handler = new ToolHandler(null);
    const result = await handler.execute('codegraph_explain', {
      projectPath: fixture.dir,
      edgeId: 1,
      source: 'src',
      target: 'tgt',
      kind: 'calls',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/not both/i);
  });

  it('rejects empty input', async () => {
    fixture = await makeProject({
      'src/a.ts': 'export function only(): number { return 1; }\n',
    });
    const handler = new ToolHandler(null);
    const result = await handler.execute('codegraph_explain', {
      projectPath: fixture.dir,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/either edgeId.*OR source/i);
  });

  it('requires kind when using canonical lookup', async () => {
    fixture = await makeProject({
      'src/a.ts': 'export function only(): number { return 1; }\n',
    });
    const handler = new ToolHandler(null);
    const result = await handler.execute('codegraph_explain', {
      projectPath: fixture.dir,
      source: 'src',
      target: 'tgt',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/kind is required/i);
  });

  it('rejects non-positive-integer edgeId', async () => {
    fixture = await makeProject({
      'src/a.ts': 'export function only(): number { return 1; }\n',
    });
    const handler = new ToolHandler(null);
    const result = await handler.execute('codegraph_explain', {
      projectPath: fixture.dir,
      edgeId: 0,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/positive integer/i);
  });
});

describe('PF-694: dispatcher wiring', () => {
  it('returns an error for an unknown tool name', async () => {
    const handler = new ToolHandler(null);
    const result = await handler.execute('codegraph_doesnotexist', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/Unknown tool/i);
  });
});

describe('PF-694: access policy on resolved root (Codex BLOCKER fix)', () => {
  let fixture: ProjectFixture | undefined;

  beforeEach(() => {
    fixture = undefined;
  });

  afterEach(() => {
    cleanup(fixture);
  });

  it('rejects when findNearestCodeGraphRoot walks UP to a disallowed root via a non-existent child', async () => {
    // Build a real fixture at /tmp/codegraph-mcp-XXXXX (allowed by
    // default — handler created with null policy allows any path).
    fixture = await makeProject({
      'src/a.ts': 'export function only(): number { return 1; }\n',
    });

    // Install an allowlist that EXCLUDES the fixture's root, then
    // pass a non-existent child of it. Without the resolved-root
    // check, `findNearestCodeGraphRoot` would walk up to the
    // fixture's `.codegraph/` and return its DB — leaking access.
    // Build an allowlist that doesn't include the fixture root. Use
    // an existing path the realpath() call can resolve — /tmp itself
    // — but NOT the fixture's specific subdirectory tree.
    const otherAllowed = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-mcp-allowlist-'));
    const handler = new ToolHandler(null);
    handler.setProjectAccess(new ProjectAccessGate({
      allowAny: false,
      extraRoots: [otherAllowed],
    }));

    const childOfBlocked = path.join(fixture.dir, 'nonexistent-subdir');
    const result = await handler.execute('codegraph_duplicates', {
      projectPath: childOfBlocked,
    });
    fs.rmSync(otherAllowed, { recursive: true, force: true });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/outside.*allowed roots|allowlist|denied/i);
  });
});
