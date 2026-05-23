import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import CodeGraph, { buildRepositoryInventory } from '../src';

describe('repository inventory', () => {
  const tempDirs: string[] = [];
  let cg: CodeGraph | undefined;

  afterEach(() => {
    cg?.destroy();
    cg = undefined;
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeProject(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-inventory-'));
    tempDirs.push(dir);
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: '@demo/rewrite-target',
        version: '1.2.3',
        private: true,
        scripts: {
          test: 'vitest',
          build: 'tsc',
        },
        dependencies: {
          react: '^19.0.0',
        },
        devDependencies: {
          typescript: '^5.0.0',
        },
      }, null, 2),
      'utf8'
    );
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{"compilerOptions":{}}\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'generated/\n', 'utf8');
    fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.github', 'workflows', 'ci.yml'), 'name: CI\n', 'utf8');
    fs.writeFileSync(
      path.join(dir, 'Cargo.toml'),
      '[package]\nname = "demo-rust"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1"\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(dir, 'pyproject.toml'),
      '[project]\nname = "demo-python"\nversion = "0.2.0"\ndependencies = [\n  "fastapi>=0.110",\n  "requests[security]>=2",\n  \'literal-package\',\n  """triple-package""",\n]\n\n[project.scripts]\ndemo = "demo:main"\n',
      'utf8'
    );
    fs.writeFileSync(path.join(dir, 'requirements.txt'), 'requests==2.0\n# comment\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/demo\n\nrequire github.com/stretchr/testify v1.8.0\n', 'utf8');
    fs.mkdirSync(path.join(dir, 'generated'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'generated', 'package.json'),
      JSON.stringify({ name: '@demo/generated' }, null, 2),
      'utf8'
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'api.ts'),
      [
        'export function createOrder(): string {',
        "  return 'order';",
        '}',
        "export const ORDER_STATUS = 'open';",
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'CheckoutPanel.tsx'),
      'export function CheckoutPanel(): JSX.Element { return <div />; }\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'api.test.ts'),
      "import { createOrder } from './api';\ncreateOrder();\n",
      'utf8'
    );
    fs.writeFileSync(path.join(dir, 'src', 'test_service.py'), 'def test_service():\n    pass\n', 'utf8');
    return dir;
  }

  it('summarizes packages, configs, exports, components, tests, and source files', async () => {
    const dir = makeProject();
    cg = await CodeGraph.init(dir);
    await cg.indexAll();

    const inventory = buildRepositoryInventory(cg, dir);

    expect(inventory.schemaVersion).toBe(1);
    expect(inventory.projectPath).toBe(path.resolve(dir));
    expect(inventory.summary.packages).toBe(5);
    expect(inventory.summary.configs).toBe(3);
    expect(inventory.summary.exportedSymbols).toBeGreaterThanOrEqual(2);
    expect(inventory.summary.testFiles).toBe(2);
    expect(inventory.packages[0]).toMatchObject({
      ecosystem: 'cargo',
      path: 'Cargo.toml',
      name: 'demo-rust',
      dependencies: ['serde'],
    });
    expect(inventory.packages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ecosystem: 'npm',
        path: 'package.json',
        name: '@demo/rewrite-target',
        version: '1.2.3',
        npm: { private: true },
        scripts: ['build', 'test'],
        dependencies: ['react'],
        devDependencies: ['typescript'],
      }),
      expect.objectContaining({
        ecosystem: 'python',
        path: 'pyproject.toml',
        name: 'demo-python',
        dependencies: ['fastapi', 'literal-package', 'requests', 'triple-package'],
        scripts: ['demo'],
      }),
      expect.objectContaining({
        ecosystem: 'requirements',
        path: 'requirements.txt',
        dependencies: ['requests'],
      }),
      expect.objectContaining({
        ecosystem: 'go',
        path: 'go.mod',
        name: 'example.com/demo',
        dependencies: ['github.com/stretchr/testify'],
      }),
    ]));
    expect(inventory.packages.find((pkg) => pkg.path === 'package.json')).toMatchObject({
      path: 'package.json',
      name: '@demo/rewrite-target',
      version: '1.2.3',
      npm: { private: true },
      scripts: ['build', 'test'],
      dependencies: ['react'],
      devDependencies: ['typescript'],
    });
    expect(
      (inventory.packages.find((pkg) => pkg.path === 'package.json') as { private?: unknown }).private
    ).toBeUndefined();
    expect(inventory.packages.map((pkg) => pkg.name)).not.toContain('@demo/generated');
    expect(inventory.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'package', name: '@demo/rewrite-target', path: 'package.json' }),
        expect.objectContaining({ kind: 'package', name: 'demo-rust', path: 'Cargo.toml' }),
        expect.objectContaining({ kind: 'config', name: 'tsconfig.json', path: 'tsconfig.json' }),
        expect.objectContaining({ kind: 'config', name: 'ci.yml', path: '.github/workflows/ci.yml' }),
        expect.objectContaining({ kind: 'exported_symbol', name: 'createOrder', path: 'src/api.ts' }),
        expect.objectContaining({ kind: 'test_file', name: 'api.test.ts', path: 'src/api.test.ts' }),
        expect.objectContaining({ kind: 'test_file', name: 'test_service.py', path: 'src/test_service.py' }),
        expect.objectContaining({ kind: 'source_file', name: 'api.ts', path: 'src/api.ts' }),
        expect.objectContaining({ kind: 'source_file', name: 'api.test.ts', path: 'src/api.test.ts' }),
      ])
    );
    expect(
      inventory.artifacts.some((artifact) => artifact.path.startsWith('generated/'))
    ).toBe(false);
  });

  it('handles VCS/URL pyproject specs and skips oversized manifests', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-inventory-edge-'));
    tempDirs.push(dir);
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'noop.ts'), 'export function noop(): void {}\n', 'utf8');

    fs.writeFileSync(
      path.join(dir, 'pyproject.toml'),
      [
        '[project]',
        'name = "edge"',
        'version = "0.0.1"',
        'dependencies = [',
        '  "fastapi",',
        '  "named-dep @ https://example.com/named-0.1.tar.gz",',
        '  "git+https://example.com/repo.git#egg=eggdep",',
        '  "git+https://example.com/repo.git",',
        '  "https://example.com/bare.tar.gz",',
        ']',
      ].join('\n'),
      'utf8'
    );

    fs.writeFileSync(path.join(dir, 'requirements.txt'), 'numpy>=1\ngit+https://example.com/r.git\n', 'utf8');

    fs.mkdirSync(path.join(dir, 'huge'), { recursive: true });
    const oversized = `{"name":"huge-package","dependencies":{"x":"1"},"padding":"${'A'.repeat(1_100_000)}"}`;
    fs.writeFileSync(path.join(dir, 'huge', 'package.json'), oversized, 'utf8');

    cg = await CodeGraph.init(dir);
    await cg.indexAll();

    const inventory = buildRepositoryInventory(cg, dir);

    const py = inventory.packages.find((pkg) => pkg.ecosystem === 'python');
    expect(py).toBeDefined();
    expect(py!.dependencies).toEqual(['eggdep', 'fastapi', 'named-dep']);

    const reqs = inventory.packages.find((pkg) => pkg.ecosystem === 'requirements');
    expect(reqs).toBeDefined();
    expect(reqs!.dependencies).toEqual(['numpy']);

    const huge = inventory.packages.find((pkg) => pkg.path === 'huge/package.json');
    expect(huge).toBeDefined();
    expect(huge!.name).toBeUndefined();
    expect(huge!.dependencies).toEqual([]);
  });
});
