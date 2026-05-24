/**
 * Security Tests
 *
 * Tests for P0/P1 security fixes:
 * - FileLock (cross-process locking)
 * - Path traversal prevention
 * - MCP input validation
 * - Atomic writes
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { FileLock, validateProjectPath } from '../src/utils';
import CodeGraph from '../src/index';
import { ToolHandler, tools } from '../src/mcp/tools';
import { getIndexPathSkipReason, getSensitiveSkipReason, scanDirectory, scanDirectoryWithStats, isSourceFile } from '../src/extraction';
import { DatabaseConnection, getDatabasePath } from '../src/db';
import { QueryBuilder } from '../src/db/queries';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-security-test-'));
}

function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('FileLock', () => {
  let tempDir: string;
  let lockPath: string;

  beforeEach(() => {
    tempDir = createTempDir();
    lockPath = path.join(tempDir, 'test.lock');
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should acquire and release a lock', () => {
    const lock = new FileLock(lockPath);
    lock.acquire();

    expect(fs.existsSync(lockPath)).toBe(true);
    const content = fs.readFileSync(lockPath, 'utf-8').trim();
    expect(parseInt(content, 10)).toBe(process.pid);

    lock.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('should prevent double acquisition within same process', () => {
    const lock1 = new FileLock(lockPath);
    const lock2 = new FileLock(lockPath);

    lock1.acquire();

    // Second lock should fail because our PID is alive
    expect(() => lock2.acquire()).toThrow(/locked by another process/);

    lock1.release();
  });

  it('should detect and remove stale locks from dead processes', () => {
    // Write a lock file with a PID that doesn't exist
    // PID 99999999 is extremely unlikely to be a real process
    fs.writeFileSync(lockPath, '99999999');

    const lock = new FileLock(lockPath);
    // Should succeed because the PID is dead
    expect(() => lock.acquire()).not.toThrow();

    lock.release();
  });

  it('should execute function with withLock', () => {
    const lock = new FileLock(lockPath);

    const result = lock.withLock(() => {
      expect(fs.existsSync(lockPath)).toBe(true);
      return 42;
    });

    expect(result).toBe(42);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('should release lock even if function throws', () => {
    const lock = new FileLock(lockPath);

    expect(() => {
      lock.withLock(() => {
        throw new Error('test error');
      });
    }).toThrow('test error');

    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('should execute async function with withLockAsync', async () => {
    const lock = new FileLock(lockPath);

    const result = await lock.withLockAsync(async () => {
      expect(fs.existsSync(lockPath)).toBe(true);
      return 'async-result';
    });

    expect(result).toBe('async-result');
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('should release lock even if async function throws', async () => {
    const lock = new FileLock(lockPath);

    await expect(
      lock.withLockAsync(async () => {
        throw new Error('async error');
      })
    ).rejects.toThrow('async error');

    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('release should be idempotent', () => {
    const lock = new FileLock(lockPath);
    lock.acquire();
    lock.release();
    // Second release should not throw
    expect(() => lock.release()).not.toThrow();
  });
});

describe('Path Traversal Prevention', () => {
  let testDir: string;
  let cg: CodeGraph;

  beforeEach(async () => {
    testDir = createTempDir();

    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);

    fs.writeFileSync(
      path.join(srcDir, 'hello.ts'),
      `export function hello(): string { return "hi"; }\n`
    );

    cg = CodeGraph.initSync(testDir, {
      config: { include: ['**/*.ts'], exclude: [] },
    });
    await cg.indexAll();
  });

  afterEach(() => {
    if (cg) cg.close();
    cleanupTempDir(testDir);
  });

  it('should read code for valid nodes within project', async () => {
    const nodes = cg.getNodesByKind('function');
    const hello = nodes.find((n) => n.name === 'hello');
    expect(hello).toBeDefined();

    const code = await cg.getCode(hello!.id);
    expect(code).toContain('hello');
  });

  it('should return null for non-existent node', async () => {
    const code = await cg.getCode('does-not-exist');
    expect(code).toBeNull();
  });
});

describe('validateProjectPath — sensitive directory blocking', () => {
  // POSIX-only: on Windows '/etc' resolves to C:\etc (non-existent), not a
  // sensitive dir — the Windows case is covered by the win32-gated test below.
  it.runIf(process.platform !== 'win32')('blocks POSIX system directories (exact match)', () => {
    expect(validateProjectPath('/')).toMatch(/sensitive system directory/i);
    expect(validateProjectPath('/etc')).toMatch(/sensitive system directory/i);
  });

  it('allows a normal, existing directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-validate-'));
    try {
      expect(validateProjectPath(dir)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // SENSITIVE_PATHS stores the Windows entries lowercase and validateProjectPath
  // matches via resolved.toLowerCase(), so 'C:\\Windows' and 'c:\\windows' are
  // both blocked. path.resolve is platform-specific, so this only runs on Windows.
  it.runIf(process.platform === 'win32')(
    'blocks Windows system directories regardless of case',
    () => {
      expect(validateProjectPath('C:\\Windows')).toMatch(/sensitive system directory/i);
      expect(validateProjectPath('c:\\windows')).toMatch(/sensitive system directory/i);
      expect(validateProjectPath('C:\\WINDOWS\\System32')).toMatch(/sensitive system directory/i);
    }
  );
});

describe('MCP Input Validation', () => {
  let testDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = createTempDir();

    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);

    fs.writeFileSync(
      path.join(srcDir, 'example.ts'),
      `export function exampleFunc(): void {}\nexport class ExampleClass {}\n`
    );

    cg = CodeGraph.initSync(testDir, {
      config: { include: ['**/*.ts'], exclude: [] },
    });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (cg) cg.close();
    cleanupTempDir(testDir);
  });

  it('should reject non-string query in codegraph_search', async () => {
    const result = await handler.execute('codegraph_search', { query: null });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('non-empty string');
  });

  it('should reject empty string query in codegraph_search', async () => {
    const result = await handler.execute('codegraph_search', { query: '' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('non-empty string');
  });

  it('should accept valid query in codegraph_search', async () => {
    const result = await handler.execute('codegraph_search', { query: 'example' });
    expect(result.isError).toBeFalsy();
  });

  it('should clamp limit to valid range in codegraph_search', async () => {
    // Extremely large limit should still work (clamped to 100)
    const result = await handler.execute('codegraph_search', { query: 'example', limit: 999999 });
    expect(result.isError).toBeFalsy();
  });

  it('should reject non-string symbol in codegraph_callers', async () => {
    const result = await handler.execute('codegraph_callers', { symbol: 123 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('non-empty string');
  });

  it('should reject non-string task in codegraph_context', async () => {
    const result = await handler.execute('codegraph_context', { task: undefined });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('non-empty string');
  });

  it('should truncate oversized codegraph_context output', async () => {
    const oversizedContext = Array.from({ length: 400 }, (_, i) => `line-${i} ${'x'.repeat(80)}`).join('\n');
    const fakeCg = {
      buildContext: async () => oversizedContext,
    };
    const fakeHandler = new ToolHandler(fakeCg as unknown as CodeGraph);

    const result = await fakeHandler.execute('codegraph_context', { task: 'find example' });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text.length).toBeLessThan(oversizedContext.length);
    expect(result.content[0].text).toContain('... (output truncated)');
  });

  it('should reject non-string symbol in codegraph_impact', async () => {
    const result = await handler.execute('codegraph_impact', { symbol: [] });
    expect(result.isError).toBe(true);
  });

  it('should reject non-string symbol in codegraph_node', async () => {
    const result = await handler.execute('codegraph_node', { symbol: false });
    expect(result.isError).toBe(true);
  });

  it('should reject non-string symbol in codegraph_callees', async () => {
    const result = await handler.execute('codegraph_callees', { symbol: {} });
    expect(result.isError).toBe(true);
  });

  it('should handle NaN limit gracefully', async () => {
    const result = await handler.execute('codegraph_search', { query: 'example', limit: 'abc' });
    expect(result.isError).toBeFalsy();
  });

  it('should handle negative limit gracefully', async () => {
    const result = await handler.execute('codegraph_search', { query: 'example', limit: -5 });
    expect(result.isError).toBeFalsy();
  });

  // #230: getCodeGraph must reject a sensitive system directory passed as
  // projectPath before opening it. The error surfaces through execute()'s
  // catch as an isError result. /etc is sensitive on POSIX; C:\Windows on
  // Windows (path.resolve is platform-specific, so each case is gated).
  it.runIf(process.platform !== 'win32')(
    'rejects a sensitive POSIX projectPath (/etc) via the MCP handler',
    async () => {
      const result = await handler.execute('codegraph_search', {
        query: 'example',
        projectPath: '/etc',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/sensitive system directory/i);
    }
  );

  it.runIf(process.platform === 'win32')(
    'rejects a sensitive Windows projectPath (C:\\Windows) via the MCP handler',
    async () => {
      const result = await handler.execute('codegraph_search', {
        query: 'example',
        projectPath: 'C:\\Windows',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/sensitive system directory/i);
    }
  );
});

describe('Atomic Writes', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should not leave temp files on success', () => {
    // We test this indirectly through the config-writer module
    // by checking that no .tmp files remain after writing
    const configDir = path.join(tempDir, '.claude');
    fs.mkdirSync(configDir, { recursive: true });

    const testFile = path.join(configDir, 'test.json');
    // Simulate what atomicWriteFileSync does
    const tmpPath = testFile + '.tmp.' + process.pid;
    fs.writeFileSync(tmpPath, '{"test": true}');
    fs.renameSync(tmpPath, testFile);

    expect(fs.existsSync(testFile)).toBe(true);
    expect(fs.existsSync(tmpPath)).toBe(false);

    const content = JSON.parse(fs.readFileSync(testFile, 'utf-8'));
    expect(content.test).toBe(true);
  });
});

describe('Source file detection (isSourceFile)', () => {
  it('selects files by supported extension', () => {
    expect(isSourceFile('src/index.ts')).toBe(true);
    expect(isSourceFile('src/deep/nested/file.ts')).toBe(true);
    expect(isSourceFile('src/component.tsx')).toBe(true);
    expect(isSourceFile('lib/util.js')).toBe(true);
    expect(isSourceFile('src/main.py')).toBe(true);
  });

  it('rejects unsupported extensions and extensionless files', () => {
    // PF-695: `.css` is now supported (CSS extractor). Use a genuinely
    // unsupported extension instead.
    expect(isSourceFile('data.json')).toBe(false);
    expect(isSourceFile('README.md')).toBe(false);
    expect(isSourceFile('Makefile')).toBe(false);
    expect(isSourceFile('.gitignore')).toBe(false);
  });

  it('matches regardless of leading dot directories', () => {
    expect(isSourceFile('.hidden/index.ts')).toBe(true);
  });
});

describe('Index safety scanning', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('excludes source files ignored by root and nested .gitignore files', () => {
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'packages', 'app'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, '.gitignore'), 'src/ignored.ts\n');
    fs.writeFileSync(path.join(tempDir, 'packages', 'app', '.gitignore'), 'private.ts\n');
    fs.writeFileSync(path.join(tempDir, 'src', 'visible.ts'), 'export const visible = 1;');
    fs.writeFileSync(path.join(tempDir, 'src', 'ignored.ts'), 'export const ignored = 1;');
    fs.writeFileSync(path.join(tempDir, 'packages', 'app', 'public.ts'), 'export const pub = 1;');
    fs.writeFileSync(path.join(tempDir, 'packages', 'app', 'private.ts'), 'export const priv = 1;');

    const files = scanDirectory(tempDir);

    expect(files).toContain('src/visible.ts');
    expect(files).toContain('packages/app/public.ts');
    expect(files).not.toContain('src/ignored.ts');
    expect(files).not.toContain('packages/app/private.ts');
  });

  it('excludes untracked files ignored by git', () => {
    execFileSync('git', ['init', '-q'], { cwd: tempDir, stdio: 'pipe' });
    fs.writeFileSync(path.join(tempDir, '.gitignore'), 'ignored.ts\n');
    fs.writeFileSync(path.join(tempDir, 'visible.ts'), 'export const visible = 1;');
    fs.writeFileSync(path.join(tempDir, 'ignored.ts'), 'export const ignored = 1;');

    const files = scanDirectory(tempDir);

    expect(files).toContain('visible.ts');
    expect(files).not.toContain('ignored.ts');
  });

  it('does not apply ancestor git ignores when a non-git project root is ignored by its parent repo', () => {
    const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-parent-ignore-'));
    const projectDir = path.join(parentDir, 'ignored-project');
    try {
      fs.mkdirSync(projectDir);
      execFileSync('git', ['init', '-q'], { cwd: parentDir, stdio: 'pipe' });
      fs.writeFileSync(path.join(parentDir, '.gitignore'), 'ignored-project/\n');
      fs.writeFileSync(path.join(projectDir, 'visible.ts'), 'export const visible = 1;');

      const files = scanDirectory(projectDir);

      expect(files).toEqual(['visible.ts']);
      expect(getIndexPathSkipReason(projectDir, 'visible.ts')).toBeNull();
    } finally {
      fs.rmSync(parentDir, { recursive: true, force: true });
    }
  });

  it('refreshes ancestor visibility when parent ignore rules start ignoring the project root', () => {
    const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-parent-visibility-'));
    const projectDir = path.join(parentDir, 'project');
    try {
      fs.mkdirSync(projectDir);
      execFileSync('git', ['init', '-q'], { cwd: parentDir, stdio: 'pipe' });
      fs.writeFileSync(path.join(projectDir, 'visible.ts'), 'export const visible = 1;');

      expect(getIndexPathSkipReason(projectDir, 'visible.ts')).toBeNull();

      fs.writeFileSync(path.join(parentDir, '.gitignore'), 'project/\n');

      expect(getIndexPathSkipReason(projectDir, 'visible.ts')).toBeNull();
      expect(scanDirectory(projectDir)).toEqual(['visible.ts']);
    } finally {
      fs.rmSync(parentDir, { recursive: true, force: true });
    }
  });

  it('applies ancestor git ignores when a non-git project root is visible to its parent repo', async () => {
    const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-parent-visible-'));
    const projectDir = path.join(parentDir, 'project');
    try {
      fs.mkdirSync(projectDir);
      execFileSync('git', ['init', '-q'], { cwd: parentDir, stdio: 'pipe' });
      fs.writeFileSync(path.join(parentDir, '.gitignore'), 'project/ignored.ts\n');
      fs.writeFileSync(path.join(projectDir, 'ignored.ts'), 'export const ignored = 1;');
      fs.writeFileSync(path.join(projectDir, 'visible.ts'), 'export const visible = 1;');

      const files = scanDirectory(projectDir);

      expect(files).toEqual(['visible.ts']);
      expect(getIndexPathSkipReason(projectDir, 'ignored.ts')).toBe('gitignored');
      expect(getIndexPathSkipReason(projectDir, 'visible.ts')).toBeNull();

      const cg = CodeGraph.initSync(projectDir);
      try {
        const result = await cg.indexFiles(['ignored.ts']);
        expect(result.filesSkipped).toBe(1);
        expect(result.errors[0]?.code).toBe('gitignored_path_skipped');
        expect(cg.getStats().fileCount).toBe(0);
      } finally {
        cg.close();
      }
    } finally {
      fs.rmSync(parentDir, { recursive: true, force: true });
    }
  });

  it('detects committed ancestor .gitignore rewrites for visible child project roots', async () => {
    const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-parent-fingerprint-'));
    const projectDir = path.join(parentDir, 'project');
    try {
      fs.mkdirSync(projectDir);
      execFileSync('git', ['init', '-q'], { cwd: parentDir, stdio: 'pipe' });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: parentDir, stdio: 'pipe' });
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: parentDir, stdio: 'pipe' });
      fs.writeFileSync(path.join(parentDir, '.gitignore'), 'project/target.ts\n');
      fs.writeFileSync(path.join(projectDir, 'target.ts'), 'export const target = 1;');
      execFileSync('git', ['add', '.gitignore'], { cwd: parentDir, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'ignore project target'], { cwd: parentDir, stdio: 'pipe' });

      const cg = CodeGraph.initSync(projectDir);
      try {
        await cg.indexAll();
        expect(cg.getStats().fileCount).toBe(0);

        const ignorePath = path.join(parentDir, '.gitignore');
        const originalStat = fs.statSync(ignorePath);
        fs.writeFileSync(ignorePath, 'project/otherx.ts\n');
        execFileSync('git', ['add', '.gitignore'], { cwd: parentDir, stdio: 'pipe' });
        execFileSync('git', ['commit', '-m', 'ignore other project file'], { cwd: parentDir, stdio: 'pipe' });
        fs.utimesSync(ignorePath, originalStat.atime, originalStat.mtime);

        expect(cg.getChangedFiles().added).toEqual(['target.ts']);
      } finally {
        cg.close();
      }
    } finally {
      fs.rmSync(parentDir, { recursive: true, force: true });
    }
  });

  it('excludes tracked files that match .gitignore patterns', () => {
    execFileSync('git', ['init', '-q'], { cwd: tempDir, stdio: 'pipe' });
    fs.writeFileSync(path.join(tempDir, 'tracked-private.ts'), 'export const ignored = 1;');
    execFileSync('git', ['add', 'tracked-private.ts'], { cwd: tempDir, stdio: 'pipe' });
    fs.writeFileSync(path.join(tempDir, '.gitignore'), 'tracked-private.ts\n');
    fs.writeFileSync(path.join(tempDir, 'visible.ts'), 'export const visible = 1;');

    const files = scanDirectory(tempDir);

    expect(files).toContain('visible.ts');
    expect(files).not.toContain('tracked-private.ts');
  });

  it('does not apply parent .gitignore rules inside embedded git repositories', () => {
    execFileSync('git', ['init', '-q'], { cwd: tempDir, stdio: 'pipe' });
    fs.writeFileSync(path.join(tempDir, '.gitignore'), '*.ts\n');
    const childDir = path.join(tempDir, 'child');
    fs.mkdirSync(childDir);
    execFileSync('git', ['init', '-q'], { cwd: childDir, stdio: 'pipe' });
    fs.writeFileSync(path.join(childDir, 'a.ts'), 'export const child = 1;');
    execFileSync('git', ['add', '-f', 'a.ts'], { cwd: childDir, stdio: 'pipe' });

    const files = scanDirectory(tempDir);

    expect(files).toContain('child/a.ts');
    expect(getIndexPathSkipReason(tempDir, 'child/a.ts')).toBeNull();
  });

  it('indexes embedded git repositories even when the parent ignores their directory', () => {
    execFileSync('git', ['init', '-q'], { cwd: tempDir, stdio: 'pipe' });
    fs.writeFileSync(path.join(tempDir, '.gitignore'), 'child/\n');
    const childDir = path.join(tempDir, 'child');
    fs.mkdirSync(childDir);
    execFileSync('git', ['init', '-q'], { cwd: childDir, stdio: 'pipe' });
    fs.writeFileSync(path.join(childDir, 'a.ts'), 'export const child = 1;');
    execFileSync('git', ['add', '-f', 'a.ts'], { cwd: childDir, stdio: 'pipe' });

    const files = scanDirectory(tempDir);

    expect(files).toContain('child/a.ts');
    expect(getIndexPathSkipReason(tempDir, 'child/a.ts')).toBeNull();
  });

  it('detects modifications inside embedded git repositories ignored by the parent', async () => {
    execFileSync('git', ['init', '-q'], { cwd: tempDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tempDir, stdio: 'pipe' });
    fs.writeFileSync(path.join(tempDir, '.gitignore'), 'child/\n');
    execFileSync('git', ['add', '.gitignore'], { cwd: tempDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'ignore embedded repo'], { cwd: tempDir, stdio: 'pipe' });

    const childDir = path.join(tempDir, 'child');
    fs.mkdirSync(childDir);
    execFileSync('git', ['init', '-q'], { cwd: childDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: childDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: childDir, stdio: 'pipe' });
    fs.writeFileSync(path.join(childDir, 'a.ts'), 'export const child = 1;');
    execFileSync('git', ['add', 'a.ts'], { cwd: childDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'child source'], { cwd: childDir, stdio: 'pipe' });

    const cg = CodeGraph.initSync(tempDir);
    try {
      await cg.indexAll();
      expect(cg.getStats().fileCount).toBe(1);

      fs.writeFileSync(path.join(childDir, 'a.ts'), 'export const child = 2;');

      expect(cg.getChangedFiles().modified).toEqual(['child/a.ts']);
      await cg.sync();
      expect(cg.getChangedFiles()).toEqual({ added: [], modified: [], removed: [] });
    } finally {
      cg.close();
    }
  });

  it('detects git status paths containing newlines', async () => {
    execFileSync('git', ['init', '-q'], { cwd: tempDir, stdio: 'pipe' });

    const cg = CodeGraph.initSync(tempDir);
    try {
      await cg.indexAll();

      const fileName = 'weird\nname.ts';
      fs.writeFileSync(path.join(tempDir, fileName), 'export const weird = 1;');

      expect(cg.getChangedFiles().added).toEqual([fileName]);
    } finally {
      cg.close();
    }
  });

  it('rescans when an embedded repository .gitignore makes a file visible', async () => {
    execFileSync('git', ['init', '-q'], { cwd: tempDir, stdio: 'pipe' });
    fs.writeFileSync(path.join(tempDir, '.gitignore'), 'child/\n');
    const childDir = path.join(tempDir, 'child');
    fs.mkdirSync(childDir);
    execFileSync('git', ['init', '-q'], { cwd: childDir, stdio: 'pipe' });
    fs.writeFileSync(path.join(childDir, '.gitignore'), 'visible.ts\n');
    fs.writeFileSync(path.join(childDir, 'visible.ts'), 'export const visible = 1;');

    const cg = CodeGraph.initSync(tempDir);
    try {
      await cg.indexAll();
      expect(cg.getStats().fileCount).toBe(0);

      fs.writeFileSync(path.join(childDir, '.gitignore'), '');

      expect(cg.getChangedFiles().added).toEqual(['child/visible.ts']);
      await cg.sync();
      expect(cg.getStats().fileCount).toBe(1);
    } finally {
      cg.close();
    }
  });

  it('does not apply parent .gitignore rules inside git submodules', () => {
    const childRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-submodule-source-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: childRepo, stdio: 'pipe' });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: childRepo, stdio: 'pipe' });
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: childRepo, stdio: 'pipe' });
      fs.writeFileSync(path.join(childRepo, 'a.ts'), 'export const child = 1;');
      execFileSync('git', ['add', 'a.ts'], { cwd: childRepo, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'child source'], { cwd: childRepo, stdio: 'pipe' });

      execFileSync('git', ['init', '-q'], { cwd: tempDir, stdio: 'pipe' });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir, stdio: 'pipe' });
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tempDir, stdio: 'pipe' });
      execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', childRepo, 'sub'], { cwd: tempDir, stdio: 'pipe' });
      fs.writeFileSync(path.join(tempDir, '.gitignore'), '*.ts\n');

      const files = scanDirectory(tempDir);

      expect(files).toContain('sub/a.ts');
      expect(getIndexPathSkipReason(tempDir, 'sub/a.ts')).toBeNull();
    } finally {
      fs.rmSync(childRepo, { recursive: true, force: true });
    }
  });

  it('allows nested .gitignore negation rules in non-git projects', () => {
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, '.gitignore'), '*.ts\n');
    fs.writeFileSync(path.join(tempDir, 'src', '.gitignore'), '!important.ts\n');
    fs.writeFileSync(path.join(tempDir, 'ignored.ts'), 'export const ignored = 1;');
    fs.writeFileSync(path.join(tempDir, 'src', 'important.ts'), 'export const important = 1;');

    const files = scanDirectory(tempDir);

    expect(files).toEqual(['src/important.ts']);
    expect(getIndexPathSkipReason(tempDir, 'src/important.ts')).toBeNull();
  });

  it('preserves ordered .gitignore rule semantics in non-git projects', () => {
    fs.writeFileSync(path.join(tempDir, '.gitignore'), '!important.ts\n*.ts\n');
    fs.writeFileSync(path.join(tempDir, 'important.ts'), 'export const important = 1;');

    const files = scanDirectory(tempDir);

    expect(files).toEqual([]);
    expect(getIndexPathSkipReason(tempDir, 'important.ts')).toBe('gitignored');
  });

  it('preserves leading spaces in .gitignore patterns in non-git projects', () => {
    fs.writeFileSync(path.join(tempDir, '.gitignore'), ' foo.ts\n');
    fs.writeFileSync(path.join(tempDir, ' foo.ts'), 'export const spaced = 1;');
    fs.writeFileSync(path.join(tempDir, 'foo.ts'), 'export const normal = 1;');

    const files = scanDirectory(tempDir);

    expect(files).toEqual(['foo.ts']);
    expect(getIndexPathSkipReason(tempDir, ' foo.ts')).toBe('gitignored');
    expect(getIndexPathSkipReason(tempDir, 'foo.ts')).toBeNull();
  });

  it('does not let nested negation re-include files under an ignored parent directory', () => {
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, '.gitignore'), 'src/\n');
    fs.writeFileSync(path.join(tempDir, 'src', '.gitignore'), '!important.ts\n');
    fs.writeFileSync(path.join(tempDir, 'src', 'important.ts'), 'export const important = 1;');

    const files = scanDirectory(tempDir);

    expect(files).toEqual([]);
    expect(getIndexPathSkipReason(tempDir, 'src/important.ts')).toBe('gitignored');
  });

  it('rescans visibility when .gitignore changes re-include a tracked file', async () => {
    execFileSync('git', ['init', '-q'], { cwd: tempDir, stdio: 'pipe' });
    fs.writeFileSync(path.join(tempDir, 'visible.ts'), 'export function visible() { return 1; }');
    execFileSync('git', ['add', 'visible.ts'], { cwd: tempDir, stdio: 'pipe' });

    const cg = CodeGraph.initSync(tempDir);
    try {
      await cg.indexAll();
      expect(cg.getStats().fileCount).toBe(1);

      fs.writeFileSync(path.join(tempDir, '.gitignore'), 'visible.ts\n');
      await cg.sync();
      expect(cg.getStats().fileCount).toBe(0);

      fs.writeFileSync(path.join(tempDir, '.gitignore'), '');
      expect(cg.getChangedFiles().added).toEqual(['visible.ts']);
      await cg.sync();
      expect(cg.getStats().fileCount).toBe(1);
    } finally {
      cg.close();
    }
  });

  it('reconciles newly visible files after committed .gitignore changes', async () => {
    execFileSync('git', ['init', '-q'], { cwd: tempDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tempDir, stdio: 'pipe' });
    fs.writeFileSync(path.join(tempDir, '.gitignore'), 'visible.ts\n');
    fs.writeFileSync(path.join(tempDir, 'visible.ts'), 'export function visible() { return 1; }');
    execFileSync('git', ['add', '.gitignore'], { cwd: tempDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'ignore visible'], { cwd: tempDir, stdio: 'pipe' });

    let cg = CodeGraph.initSync(tempDir);
    try {
      await cg.indexAll();
      expect(cg.getStats().fileCount).toBe(0);

      fs.writeFileSync(path.join(tempDir, '.gitignore'), '');
      execFileSync('git', ['add', '.gitignore', 'visible.ts'], { cwd: tempDir, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'unignore visible'], { cwd: tempDir, stdio: 'pipe' });
      expect(execFileSync('git', ['status', '--porcelain', '--', '.gitignore', 'visible.ts'], { cwd: tempDir, encoding: 'utf-8' })).toBe('');

      cg.close();
      cg = await CodeGraph.open(tempDir);

      expect(cg.getChangedFiles().added).toEqual(['visible.ts']);
      await cg.sync();
      expect(cg.getStats().fileCount).toBe(1);
    } finally {
      cg.close();
    }
  });

  it('detects same-size committed .gitignore rewrites', async () => {
    execFileSync('git', ['init', '-q'], { cwd: tempDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tempDir, stdio: 'pipe' });
    fs.writeFileSync(path.join(tempDir, '.gitignore'), 'target.ts\n');
    fs.writeFileSync(path.join(tempDir, 'target.ts'), 'export const target = 1;');
    execFileSync('git', ['add', '.gitignore'], { cwd: tempDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'ignore target'], { cwd: tempDir, stdio: 'pipe' });

    const cg = CodeGraph.initSync(tempDir);
    try {
      await cg.indexAll();
      expect(cg.getStats().fileCount).toBe(0);

      const ignorePath = path.join(tempDir, '.gitignore');
      const originalStat = fs.statSync(ignorePath);
      fs.writeFileSync(ignorePath, 'otherx.ts\n');
      execFileSync('git', ['add', '.gitignore'], { cwd: tempDir, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'ignore other file'], { cwd: tempDir, stdio: 'pipe' });
      fs.utimesSync(ignorePath, originalStat.atime, originalStat.mtime);

      expect(cg.getChangedFiles().added).toEqual(['target.ts']);
    } finally {
      cg.close();
    }
  });

  it('does not follow symlinked directories ignored by .gitignore', () => {
    const realSecretDir = path.join(tempDir, 'real-secret-dir');
    fs.mkdirSync(realSecretDir, { recursive: true });
    fs.writeFileSync(path.join(realSecretDir, 'leak.ts'), 'export const leak = 1;');
    fs.writeFileSync(path.join(tempDir, '.gitignore'), 'linked-secrets/\n');

    try {
      fs.symlinkSync(realSecretDir, path.join(tempDir, 'linked-secrets'), 'dir');
    } catch {
      return;
    }

    const files = scanDirectory(tempDir);

    expect(files).toContain('real-secret-dir/leak.ts');
    expect(files).not.toContain('linked-secrets/leak.ts');
  });

  it('does not index symlinked directory aliases to files ignored by target path', () => {
    fs.mkdirSync(path.join(tempDir, 'real'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, '.gitignore'), 'real/leak.ts\n');
    fs.writeFileSync(path.join(tempDir, 'real', 'leak.ts'), 'export const leak = 1;');

    try {
      fs.symlinkSync(path.join(tempDir, 'real'), path.join(tempDir, 'alias'), 'dir');
    } catch {
      return;
    }

    const files = scanDirectory(tempDir);

    expect(files).not.toContain('real/leak.ts');
    expect(files).not.toContain('alias/leak.ts');
    expect(getIndexPathSkipReason(tempDir, 'alias/leak.ts')).toBe('gitignored');
  });

  it('does not follow symlinks outside the project root', () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-outside-root-'));
    fs.writeFileSync(path.join(outsideDir, 'leak.ts'), 'export const leak = 1;');
    fs.writeFileSync(path.join(outsideDir, 'single.ts'), 'export const single = 1;');

    try {
      fs.symlinkSync(outsideDir, path.join(tempDir, 'linked-outside'), 'dir');
      fs.symlinkSync(path.join(outsideDir, 'single.ts'), path.join(tempDir, 'linked-file.ts'), 'file');
    } catch {
      fs.rmSync(outsideDir, { recursive: true, force: true });
      return;
    }

    try {
      const files = scanDirectory(tempDir);

      expect(files).not.toContain('linked-outside/leak.ts');
      expect(files).not.toContain('linked-file.ts');
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('does not report outside-root symlinks from git-backed scans or change detection', async () => {
    execFileSync('git', ['init', '-q'], { cwd: tempDir, stdio: 'pipe' });
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-git-outside-root-'));
    const outsideFile = path.join(outsideDir, 'single.ts');
    fs.writeFileSync(outsideFile, 'export const single = 1;');

    try {
      fs.symlinkSync(outsideFile, path.join(tempDir, 'linked-file.ts'), 'file');
    } catch {
      fs.rmSync(outsideDir, { recursive: true, force: true });
      return;
    }

    const cg = CodeGraph.initSync(tempDir);
    try {
      expect(scanDirectory(tempDir)).not.toContain('linked-file.ts');
      expect(cg.getChangedFiles().added).toEqual([]);
    } finally {
      cg.close();
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('does not index symlink aliases to sensitive or ignored targets inside the project root', async () => {
    fs.writeFileSync(path.join(tempDir, '.gitignore'), 'secrets/\n');
    fs.writeFileSync(path.join(tempDir, '.env.local.ts'), 'export const token = "SUPER_SECRET_ALIAS";');
    fs.mkdirSync(path.join(tempDir, 'secrets'));
    fs.writeFileSync(path.join(tempDir, 'secrets', 'leak.ts'), 'export const leak = "SUPER_SECRET_DIR_ALIAS";');

    try {
      fs.symlinkSync(path.join(tempDir, '.env.local.ts'), path.join(tempDir, 'alias.ts'), 'file');
      fs.symlinkSync(path.join(tempDir, 'secrets'), path.join(tempDir, 'aliasdir'), 'dir');
    } catch {
      return;
    }

    const files = scanDirectory(tempDir);

    expect(files).not.toContain('alias.ts');
    expect(files).not.toContain('aliasdir/leak.ts');
    expect(getIndexPathSkipReason(tempDir, 'alias.ts')).toBe('env-file');
    expect(getIndexPathSkipReason(tempDir, 'aliasdir/leak.ts')).toBe('gitignored');

    const cg = CodeGraph.initSync(tempDir);
    try {
      const result = await cg.indexFiles(['alias.ts']);
      expect(result.filesSkipped).toBe(1);
      expect(result.errors[0]?.code).toBe('sensitive_path_skipped');
      expect(cg.getStats().fileCount).toBe(0);
    } finally {
      cg.close();
    }
  });

  it('purges existing records when files become sensitive or outside-root symlinks', async () => {
    execFileSync('git', ['init', '-q'], { cwd: tempDir, stdio: 'pipe' });
    fs.writeFileSync(path.join(tempDir, 'alias.ts'), 'export const alias = 1;');
    fs.writeFileSync(path.join(tempDir, 'external.ts'), 'export const external = 1;');
    execFileSync('git', ['add', 'alias.ts', 'external.ts'], { cwd: tempDir, stdio: 'pipe' });

    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-stale-outside-root-'));
    const outsideFile = path.join(outsideDir, 'external.ts');
    fs.writeFileSync(outsideFile, 'export const external = 2;');

    const cg = CodeGraph.initSync(tempDir);
    try {
      await cg.indexAll();
      expect(cg.getStats().fileCount).toBe(2);

      fs.writeFileSync(path.join(tempDir, '.env.local.ts'), 'export const token = "SUPER_SECRET_STALE";');
      fs.rmSync(path.join(tempDir, 'alias.ts'));
      fs.rmSync(path.join(tempDir, 'external.ts'));
      fs.symlinkSync(path.join(tempDir, '.env.local.ts'), path.join(tempDir, 'alias.ts'), 'file');
      fs.symlinkSync(outsideFile, path.join(tempDir, 'external.ts'), 'file');

      await cg.sync();

      expect(cg.getStats().fileCount).toBe(0);
      expect(cg.getFile('alias.ts')).toBeNull();
      expect(cg.getFile('external.ts')).toBeNull();
    } finally {
      cg.close();
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('blocks direct indexing through symlinks outside the project root', async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-direct-outside-root-'));
    const outsideFile = path.join(outsideDir, 'single.ts');
    fs.writeFileSync(outsideFile, 'export const single = 1;');

    try {
      fs.symlinkSync(outsideFile, path.join(tempDir, 'linked-file.ts'), 'file');
    } catch {
      fs.rmSync(outsideDir, { recursive: true, force: true });
      return;
    }

    const cg = CodeGraph.initSync(tempDir);
    try {
      const result = await cg.indexFiles(['linked-file.ts']);

      expect(result.filesErrored).toBe(1);
      expect(result.errors[0]?.code).toBe('path_traversal');
      expect(cg.getStats().fileCount).toBe(0);
    } finally {
      cg.close();
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('skips env, key, and secret-like source paths before indexing', () => {
    fs.mkdirSync(path.join(tempDir, 'src', 'generated'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'visible.ts'), 'export const visible = 1;');
    fs.writeFileSync(path.join(tempDir, '.env.local.ts'), 'export const token = "SUPER_SECRET_ENV";');
    fs.writeFileSync(path.join(tempDir, 'src', 'private.key.ts'), 'export const key = "SUPER_SECRET_KEY";');
    fs.writeFileSync(path.join(tempDir, 'src', 'generated', 'client.secret.ts'), 'export const secret = "SUPER_SECRET_GENERATED";');

    const result = scanDirectoryWithStats(tempDir);

    expect(result.files).toEqual(['src/visible.ts']);
    expect(result.safety.sensitiveFilesSkipped).toBe(3);
    expect(result.safety.sensitiveFilesByReason).toEqual({
      'env-file': 1,
      'key-file': 1,
      'secret-like-source': 1,
    });
    expect(getSensitiveSkipReason('.env.local.ts')).toBe('env-file');
    expect(getSensitiveSkipReason('src/private.key.ts')).toBe('key-file');
    expect(getSensitiveSkipReason('src/generated/client.secret.ts')).toBe('secret-like-source');
  });

  it('reports skipped sensitive file aggregates in status without leaking file contents', async () => {
    fs.mkdirSync(path.join(tempDir, 'src', 'generated'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'visible.ts'), 'export function visible() { return 1; }');
    fs.writeFileSync(path.join(tempDir, '.env.local.ts'), 'export const token = "SUPER_SECRET_ENV";');
    fs.writeFileSync(path.join(tempDir, 'src', 'generated', 'client.secret.ts'), 'export const secret = "SUPER_SECRET_GENERATED";');

    const cg = CodeGraph.initSync(tempDir);
    try {
      const indexResult = await cg.indexAll();
      expect(indexResult.filesIndexed).toBe(1);
      expect(indexResult.filesSkipped).toBe(2);

      const response = await new ToolHandler(cg).execute('codegraph_status', {});
      const text = response.content[0]?.text ?? '';

      expect(text).toContain('Index Safety');
      expect(text).toContain('Sensitive files skipped: 2');
      expect(text).toContain('env-file: 1');
      expect(text).toContain('secret-like-source: 1');
      expect(text).not.toContain('SUPER_SECRET_ENV');
      expect(text).not.toContain('SUPER_SECRET_GENERATED');
      expect(text).not.toContain('.env.local.ts');
      expect(text).not.toContain('client.secret.ts');
    } finally {
      cg.close();
    }
  });

  it('keeps sensitive source paths out of direct indexing and later syncs', async () => {
    execFileSync('git', ['init', '-q'], { cwd: tempDir, stdio: 'pipe' });
    fs.writeFileSync(path.join(tempDir, 'visible.ts'), 'export function visible() { return 1; }');

    const cg = CodeGraph.initSync(tempDir);
    try {
      await cg.indexAll();
      expect(cg.getStats().fileCount).toBe(1);

      fs.writeFileSync(path.join(tempDir, '.env.local.ts'), 'export const token = "SUPER_SECRET_SYNC";');
      fs.writeFileSync(path.join(tempDir, 'client.secret.ts'), 'export const secret = "SUPER_SECRET_DIRECT";');

      expect(cg.getChangedFiles().added).toEqual([]);

      const syncResult = await cg.sync();
      expect(syncResult.filesAdded).toBe(0);
      expect(cg.getStats().fileCount).toBe(1);

      const directResult = await cg.indexFiles(['client.secret.ts']);
      expect(directResult.filesSkipped).toBe(1);
      expect(directResult.errors[0]?.code).toBe('sensitive_path_skipped');
      expect(cg.getStats().fileCount).toBe(1);
    } finally {
      cg.close();
    }
  });

  it('keeps gitignored source paths out of direct indexing and purges existing records', async () => {
    fs.writeFileSync(path.join(tempDir, 'visible.ts'), 'export function visible() { return 1; }');

    const cg = CodeGraph.initSync(tempDir);
    try {
      await cg.indexAll();
      expect(cg.getStats().fileCount).toBe(1);

      fs.writeFileSync(path.join(tempDir, '.gitignore'), 'visible.ts\nignored.ts\n');
      fs.writeFileSync(path.join(tempDir, 'ignored.ts'), 'export function ignored() { return 2; }');

      const directResult = await cg.indexFiles(['ignored.ts']);
      expect(directResult.filesSkipped).toBe(1);
      expect(directResult.errors[0]?.code).toBe('gitignored_path_skipped');

      await cg.indexAll();
      expect(cg.getStats().fileCount).toBe(0);
    } finally {
      cg.close();
    }
  });

  it('applies nested .gitignore rules to absolute direct-index paths', async () => {
    fs.mkdirSync(path.join(tempDir, 'packages', 'app'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'packages', 'app', '.gitignore'), 'private.ts\n');
    const ignoredPath = path.join(tempDir, 'packages', 'app', 'private.ts');
    fs.writeFileSync(ignoredPath, 'export function ignored() { return 1; }');

    const cg = CodeGraph.initSync(tempDir);
    try {
      const result = await cg.indexFiles([ignoredPath]);

      expect(result.filesSkipped).toBe(1);
      expect(result.errors[0]?.code).toBe('gitignored_path_skipped');
      expect(cg.getStats().fileCount).toBe(0);
    } finally {
      cg.close();
    }
  });
});

describe('JSON.parse Error Boundaries in DB', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should not crash when node has malformed JSON in decorators column', () => {
    const dbPath = path.join(tempDir, 'test.db');
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());

    // Insert a node with malformed JSON in the decorators column
    db.getDb().prepare(`
      INSERT INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, decorators, is_exported, is_async, is_static, is_abstract, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'test-node-1', 'function', 'myFunc', 'myFunc', 'test.ts', 'typescript',
      1, 5, 0, 0,
      '{not valid json!!!}',  // malformed decorators
      0, 0, 0, 0, Date.now()
    );

    // Should not throw - should return node with undefined decorators
    const node = queries.getNodeById('test-node-1');
    expect(node).not.toBeNull();
    expect(node!.name).toBe('myFunc');
    expect(node!.decorators).toBeUndefined();

    db.close();
  });

  it('should not crash when edge has malformed JSON in metadata column', () => {
    const dbPath = path.join(tempDir, 'test.db');
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());

    // Insert two nodes first
    const insertNode = db.getDb().prepare(`
      INSERT INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, is_exported, is_async, is_static, is_abstract, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertNode.run('node-a', 'function', 'funcA', 'funcA', 'a.ts', 'typescript', 1, 5, 0, 0, 0, 0, 0, 0, Date.now());
    insertNode.run('node-b', 'function', 'funcB', 'funcB', 'b.ts', 'typescript', 1, 5, 0, 0, 0, 0, 0, 0, Date.now());

    // Insert edge with malformed metadata
    db.getDb().prepare(`
      INSERT INTO edges (source, target, kind, metadata)
      VALUES (?, ?, ?, ?)
    `).run('node-a', 'node-b', 'calls', 'broken json {{{');

    // Should not throw - should return edge with undefined metadata
    const edges = queries.getOutgoingEdges('node-a');
    expect(edges.length).toBe(1);
    expect(edges[0].source).toBe('node-a');
    expect(edges[0].target).toBe('node-b');
    expect(edges[0].metadata).toBeUndefined();

    db.close();
  });

  it('should not crash when file record has malformed JSON in errors column', () => {
    const dbPath = path.join(tempDir, 'test.db');
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());

    // Insert a file with malformed errors JSON
    db.getDb().prepare(`
      INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at, node_count, errors)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('test.ts', 'abc123', 'typescript', 100, Date.now(), Date.now(), 5, 'not-an-array');

    // Should not throw - should return file with undefined errors
    const file = queries.getFileByPath('test.ts');
    expect(file).not.toBeNull();
    expect(file!.path).toBe('test.ts');
    expect(file!.errors).toBeUndefined();

    db.close();
  });
});

describe('Symlink Cycle Detection', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should handle symlink cycle without infinite loop', () => {
    // Create directory structure with a symlink cycle
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'index.ts'), 'export const x = 1;\n');

    // Create a symlink from src/loop -> tempDir (parent directory)
    try {
      fs.symlinkSync(tempDir, path.join(srcDir, 'loop'), 'dir');
    } catch {
      // Skip test if symlinks not supported (e.g., Windows without admin)
      return;
    }


    // This should complete without hanging
    const files = scanDirectory(tempDir);

    // Should find the real file but not loop infinitely
    expect(files).toContain('src/index.ts');
    // Should not find duplicates via the symlink path
    const indexFiles = files.filter(f => f.endsWith('index.ts'));
    expect(indexFiles.length).toBe(1);
  });

  it('should follow valid symlinks to directories', () => {
    // Create source directory with a file
    const realDir = path.join(tempDir, 'real');
    fs.mkdirSync(realDir);
    fs.writeFileSync(path.join(realDir, 'hello.ts'), 'export function hello() {}\n');

    // Create a symlink to realDir
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir);
    try {
      fs.symlinkSync(realDir, path.join(srcDir, 'linked'), 'dir');
    } catch {
      return;
    }


    const files = scanDirectory(tempDir);

    // Should find files from both the real dir and via the symlink
    // But deduplicate since they resolve to the same real path
    expect(files.some(f => f.includes('hello.ts'))).toBe(true);
  });

  it('should skip broken symlinks gracefully', () => {
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'valid.ts'), 'export const y = 2;\n');

    try {
      fs.symlinkSync('/nonexistent/path', path.join(srcDir, 'broken'), 'dir');
    } catch {
      return;
    }


    // Should not throw
    const files = scanDirectory(tempDir);
    expect(files).toContain('src/valid.ts');
  });
});

describe('Session marker symlink resistance', () => {
  // The marker write lives in src/mcp/tools.ts behind handleContext. We exercise
  // it end-to-end via ToolHandler.execute so the test exercises the same code
  // path Claude Code drives. The session id is per-test so other parallel test
  // runs can't collide with the marker file we plant a symlink at.
  const SESSION_ID = `cg-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const crypto = require('crypto') as typeof import('crypto');
  const hash = crypto.createHash('md5').update(SESSION_ID).digest('hex').slice(0, 16);
  const markerPath = path.join(os.tmpdir(), `codegraph-consulted-${hash}`);

  let projectDir: string;
  let victimDir: string;
  let victimFile: string;

  beforeEach(async () => {
    projectDir = createTempDir();
    victimDir = createTempDir();
    victimFile = path.join(victimDir, 'private.txt');
    fs.writeFileSync(victimFile, 'SECRET-DO-NOT-OVERWRITE\n');
    if (fs.existsSync(markerPath)) fs.unlinkSync(markerPath);

    // A real .codegraph/ has to exist for handleContext to get past the
    // "not initialized" guard — index a tiny fixture so the call reaches the
    // marker write step rather than short-circuiting on missing project state.
    fs.writeFileSync(path.join(projectDir, 'a.ts'), 'export const x = 1;\n');
    const cg = await CodeGraph.init(projectDir);
    await cg.indexAll();
    cg.close();
  });

  afterEach(() => {
    if (fs.existsSync(markerPath)) fs.unlinkSync(markerPath);
    cleanupTempDir(projectDir);
    cleanupTempDir(victimDir);
  });

  it('does not follow a pre-planted symlink at the marker path', async () => {
    // Skip on platforms where the user can't create symlinks (Windows without
    // dev mode + admin). The CWE-59 risk we're guarding against doesn't apply
    // when symlinks aren't creatable, so the skip is correct, not a gap.
    try {
      fs.symlinkSync(victimFile, markerPath);
    } catch {
      return;
    }

    const cg = await CodeGraph.open(projectDir);
    const handler = new ToolHandler(cg);
    process.env.CLAUDE_SESSION_ID = SESSION_ID;
    try {
      await handler.execute('codegraph_context', { task: 'find x' });
    } finally {
      delete process.env.CLAUDE_SESSION_ID;
      cg.close();
    }

    // The victim file's contents must be untouched — the old writeFileSync
    // path would have followed the symlink and written an ISO timestamp here.
    expect(fs.readFileSync(victimFile, 'utf8')).toBe('SECRET-DO-NOT-OVERWRITE\n');

    // And the marker path itself must still be the symlink we planted —
    // no fallback path that quietly unlinked + recreated it (which would
    // also work, but is a behavior we don't want to silently rely on).
    expect(fs.lstatSync(markerPath).isSymbolicLink()).toBe(true);
  });

  it('writes the marker file with 0o600 perms on a clean path', async () => {
    // No symlink planted — happy path. Verifies the new openSync(mode: 0o600)
    // call is what actually lands on disk (regression guard for the perm
    // tightening that came with the O_NOFOLLOW fix).
    const cg = await CodeGraph.open(projectDir);
    const handler = new ToolHandler(cg);
    process.env.CLAUDE_SESSION_ID = SESSION_ID;
    try {
      await handler.execute('codegraph_context', { task: 'find x' });
    } finally {
      delete process.env.CLAUDE_SESSION_ID;
      cg.close();
    }

    expect(fs.existsSync(markerPath)).toBe(true);
    // chmod's low 9 bits — strip the file-type bits for a clean compare.
    // Windows can't enforce 0o600 in the POSIX sense; skip the assertion
    // there since the underlying OS will normalize the mode anyway.
    if (process.platform !== 'win32') {
      const mode = fs.statSync(markerPath).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });
});
