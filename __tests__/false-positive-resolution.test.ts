/**
 * False-positive resolution tests (PF-610).
 *
 * Guards against:
 *  - Bare built-in / Web API globals (e.g. `new Request()`) resolving to
 *    unrelated project classes of the same name.
 *  - TS utility-type identifiers (`Record`, `Partial`, …) resolving to
 *    project symbols.
 *  - Bare prototype-method references (`.toString`, `.valueOf`) extracted
 *    from complex receivers resolving to arbitrary project methods.
 *  - Project symbols that legitimately shadow built-ins via local imports
 *    must still resolve.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

describe('false-positive resolution (PF-610)', () => {
  let tempDir: string;
  let cg: CodeGraph | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-pf610-'));
  });

  afterEach(() => {
    cg?.destroy();
    cg = undefined;
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function findNodeByNameAndFile(name: string, fileSuffix: string) {
    if (!cg) return undefined;
    return cg
      .searchNodes(name, { limit: 25 })
      .map((r) => r.node)
      .find((n) => n.name === name && n.filePath.endsWith(fileSuffix));
  }

  /**
   * Files of nodes that reference the target via call/reference edges.
   * Excludes `contains`/structural edges so a class containing the target
   * method doesn't itself count as a "caller".
   */
  function incomingEdgeSourceFiles(targetNodeId: string): string[] {
    if (!cg) return [];
    const REF_EDGE_KINDS = new Set([
      'calls',
      'references',
      'instantiates',
      'extends',
      'implements',
      'decorates',
    ]);
    const files: string[] = [];
    for (const edge of cg.getIncomingEdges(targetNodeId)) {
      if (!REF_EDGE_KINDS.has(edge.kind)) continue;
      const node = cg.getNode(edge.source);
      if (node) files.push(node.filePath);
    }
    return files;
  }

  it('does not link `new Request()` to a project class named Request when no import shadows it', async () => {
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'src', 'project-request.ts'),
      // A project class that could be confused with the Fetch API Request.
      'export class Request {\n  constructor(public url: string) {}\n}\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(tempDir, 'src', 'fetch-caller.ts'),
      // No import of the project Request — this is the Fetch API.
      "export async function callApi(): Promise<Response> {\n" +
        "  const req = new Request('https://example.com');\n" +
        '  return fetch(req);\n' +
        '}\n',
      'utf8',
    );

    cg = await CodeGraph.init(tempDir, { index: true });

    const projectRequest = findNodeByNameAndFile('Request', 'project-request.ts');
    expect(projectRequest).toBeDefined();

    const files = incomingEdgeSourceFiles(projectRequest!.id);
    expect(files.some((f) => f.endsWith('fetch-caller.ts'))).toBe(false);
  });

  it('still resolves `new Request()` to a same-file local declaration that shadows the built-in', async () => {
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'src', 'local-shadow.ts'),
      // No import — but a same-file declaration redefines `Request`.
      // The built-in filter must not drop this on the floor.
      'export class Request {\n' +
        '  constructor(public url: string) {}\n' +
        '}\n' +
        'export function build() {\n' +
        "  return new Request('local');\n" +
        '}\n',
      'utf8',
    );

    cg = await CodeGraph.init(tempDir, { index: true });

    const localRequest = findNodeByNameAndFile('Request', 'local-shadow.ts');
    expect(localRequest).toBeDefined();

    const files = incomingEdgeSourceFiles(localRequest!.id);
    expect(files.some((f) => f.endsWith('local-shadow.ts'))).toBe(true);
  });

  it('still resolves `new Request()` to the project class when the file imports it', async () => {
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'src', 'project-request.ts'),
      'export class Request {\n  constructor(public url: string) {}\n}\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(tempDir, 'src', 'project-caller.ts'),
      // Import shadows the Fetch API Request — the resolver MUST link here.
      "import { Request } from './project-request';\n" +
        'export function build() {\n' +
        "  return new Request('local');\n" +
        '}\n',
      'utf8',
    );

    cg = await CodeGraph.init(tempDir, { index: true });

    const projectRequest = findNodeByNameAndFile('Request', 'project-request.ts');
    expect(projectRequest).toBeDefined();

    const files = incomingEdgeSourceFiles(projectRequest!.id);
    expect(files.some((f) => f.endsWith('project-caller.ts'))).toBe(true);
  });

  it('does not resolve TS utility-type references (`Record<string, T>`) to a project Record symbol', async () => {
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'src', 'project-record.ts'),
      'export class Record {\n  log(): void {}\n}\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(tempDir, 'src', 'consumer.ts'),
      'export type Counts = Record<string, number>;\n' +
        'export function tally(): Counts {\n' +
        '  return {};\n' +
        '}\n',
      'utf8',
    );

    cg = await CodeGraph.init(tempDir, { index: true });

    const projectRecord = findNodeByNameAndFile('Record', 'project-record.ts');
    expect(projectRecord).toBeDefined();

    const files = incomingEdgeSourceFiles(projectRecord!.id);
    expect(files.some((f) => f.endsWith('consumer.ts'))).toBe(false);
  });

  it('does not let a same-file class.toString() declaration absorb unrelated chained `.toString()` calls', async () => {
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'src', 'same-file-toString.ts'),
      // Defining a class with a toString method must NOT make every bare
      // `.toString()` in the same file resolve to Far.toString — that bare
      // call still came from a chained receiver and is the prototype call.
      'export class Far {\n' +
        '  toString(): string {\n' +
        '    return "far";\n' +
        '  }\n' +
        '}\n' +
        'export function describe(x: number): string {\n' +
        '  return String(x).trim().toString();\n' +
        '}\n',
      'utf8',
    );

    cg = await CodeGraph.init(tempDir, { index: true });

    const farToString = findNodeByNameAndFile('toString', 'same-file-toString.ts');
    expect(farToString).toBeDefined();

    const files = incomingEdgeSourceFiles(farToString!.id);
    // No spurious edge from the chain caller in the SAME file to Far.toString.
    expect(files.some((f) => f.endsWith('same-file-toString.ts'))).toBe(false);
  });

  it('does not link bare `.toString()` (from a chained receiver) to an arbitrary project toString', async () => {
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'src', 'far-away.ts'),
      // A project method named toString that should not collect spurious edges
      // from arbitrary `something().toString()` calls elsewhere.
      'export class Far {\n  toString(): string {\n    return "far";\n  }\n}\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(tempDir, 'src', 'chain-caller.ts'),
      // Chained call — tree-sitter extracts the bare method name "toString"
      // because the receiver is itself a call expression.
      'export function describe(x: number): string {\n' +
        '  return String(x).trim().toString();\n' +
        '}\n',
      'utf8',
    );

    cg = await CodeGraph.init(tempDir, { index: true });

    const farToString = findNodeByNameAndFile('toString', 'far-away.ts');
    expect(farToString).toBeDefined();

    const files = incomingEdgeSourceFiles(farToString!.id);
    expect(files.some((f) => f.endsWith('chain-caller.ts'))).toBe(false);
  });
});
