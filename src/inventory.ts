import * as fs from 'fs';
import * as path from 'path';
import type CodeGraph from './index';
import { getIndexPathSkipReason } from './extraction';
import { isTestFile } from './search/query-utils';
import type { FileRecord, Node, NodeKind } from './types';

export type InventoryArtifactKind =
  | 'package'
  | 'config'
  | 'route'
  | 'component'
  | 'exported_symbol'
  | 'test_file'
  | 'source_file';

export interface InventoryNpmPackage {
  private?: boolean;
}

export interface InventoryPackage {
  ecosystem: 'npm' | 'cargo' | 'python' | 'go' | 'requirements';
  path: string;
  name?: string;
  version?: string;
  scripts: string[];
  dependencies: string[];
  devDependencies: string[];
  npm?: InventoryNpmPackage;
}

export interface InventoryArtifact {
  kind: InventoryArtifactKind;
  name: string;
  path: string;
  nodeKind?: NodeKind;
  language?: string;
  startLine?: number;
  endLine?: number;
}

export interface RepositoryInventory {
  schemaVersion: 1;
  projectPath: string;
  generatedAt: string;
  summary: {
    files: number;
    nodes: number;
    edges: number;
    packages: number;
    configs: number;
    routes: number;
    components: number;
    exportedSymbols: number;
    testFiles: number;
  };
  packages: InventoryPackage[];
  artifacts: InventoryArtifact[];
}

const SKIPPED_DIRS = new Set([
  '.git',
  '.codegraph',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
]);

const CONFIG_BASENAME_PATTERNS = [
  /^package\.json$/,
  /^tsconfig(?:\..*)?\.json$/,
  /^jsconfig(?:\..*)?\.json$/,
  /^vite\.config\.[cm]?[jt]s$/,
  /^vitest\.config\.[cm]?[jt]s$/,
  /^next\.config\.[cm]?[jt]s$/,
  /^eslint\.config\.[cm]?[jt]s$/,
  /^postcss\.config\.[cm]?[jt]s$/,
  /^tailwind\.config\.[cm]?[jt]s$/,
  /^turbo\.json$/,
  /^pnpm-workspace\.yaml$/,
  /^docker-compose\.ya?ml$/,
  /^Dockerfile(?:\..*)?$/,
];

const CONFIG_PATH_PATTERNS = [
  /^\.github\/workflows\/.+\.ya?ml$/,
  /^\.github\/dependabot\.ya?ml$/,
];

export function buildRepositoryInventory(cg: CodeGraph, projectPath: string): RepositoryInventory {
  const resolvedPath = path.resolve(projectPath);
  const stats = cg.getStats();
  const files = cg.getFiles();
  const packages = collectPackages(resolvedPath);
  const configArtifacts = collectConfigArtifacts(resolvedPath);
  const routeArtifacts = nodesToArtifacts(cg.getNodesByKind('route'), 'route');
  const componentArtifacts = nodesToArtifacts(cg.getNodesByKind('component'), 'component');
  const exportedArtifacts = collectExportedSymbols(cg);
  const testArtifacts = collectTestFiles(files);
  const sourceArtifacts = collectSourceFiles(files);
  const artifacts = [
    ...packages.map(packageToArtifact),
    ...configArtifacts,
    ...routeArtifacts,
    ...componentArtifacts,
    ...exportedArtifacts,
    ...testArtifacts,
    ...sourceArtifacts,
  ];

  return {
    schemaVersion: 1,
    projectPath: resolvedPath,
    generatedAt: new Date().toISOString(),
    summary: {
      files: stats.fileCount,
      nodes: stats.nodeCount,
      edges: stats.edgeCount,
      packages: packages.length,
      configs: configArtifacts.length,
      routes: routeArtifacts.length,
      components: componentArtifacts.length,
      exportedSymbols: exportedArtifacts.length,
      testFiles: testArtifacts.length,
    },
    packages,
    artifacts,
  };
}

function collectExportedSymbols(cg: CodeGraph): InventoryArtifact[] {
  const exportedKinds: NodeKind[] = [
    'class',
    'interface',
    'function',
    'method',
    'constant',
    'enum',
    'type_alias',
    'component',
  ];

  const artifacts: InventoryArtifact[] = [];
  const seen = new Set<string>();
  for (const kind of exportedKinds) {
    for (const node of cg.getNodesByKind(kind)) {
      if (!node.isExported) continue;
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      artifacts.push(nodeToArtifact(node, 'exported_symbol'));
    }
  }
  return artifacts.sort(compareArtifacts);
}

function collectTestFiles(files: FileRecord[]): InventoryArtifact[] {
  return files
    .filter((file) => isTestFile(file.path))
    .map((file) => fileToArtifact(file, 'test_file'))
    .sort(compareArtifacts);
}

function collectSourceFiles(files: FileRecord[]): InventoryArtifact[] {
  return files
    .map((file) => fileToArtifact(file, 'source_file'))
    .sort(compareArtifacts);
}

function collectPackages(projectPath: string): InventoryPackage[] {
  return walkProjectFiles(projectPath)
    .filter((filePath) => isVisibleInventoryFile(projectPath, filePath))
    .map((filePath) => packageManifestToInventory(projectPath, filePath))
    .filter((pkg): pkg is InventoryPackage => pkg !== null)
    .sort((a, b) => a.path.localeCompare(b.path));
}

function collectConfigArtifacts(projectPath: string): InventoryArtifact[] {
  return walkProjectFiles(projectPath)
    .filter((filePath) => isVisibleInventoryFile(projectPath, filePath))
    .filter((filePath) => isConfigFile(projectPath, filePath))
    .map((filePath) => ({
      kind: 'config' as const,
      name: path.basename(filePath),
      path: toRelativePath(projectPath, filePath),
    }))
    .sort(compareArtifacts);
}

function nodesToArtifacts(nodes: Node[], kind: InventoryArtifactKind): InventoryArtifact[] {
  return nodes.map((node) => nodeToArtifact(node, kind)).sort(compareArtifacts);
}

function nodeToArtifact(node: Node, kind: InventoryArtifactKind): InventoryArtifact {
  return {
    kind,
    name: node.name,
    path: node.filePath,
    nodeKind: node.kind,
    language: node.language,
    startLine: node.startLine,
    endLine: node.endLine,
  };
}

function fileToArtifact(file: FileRecord, kind: InventoryArtifactKind): InventoryArtifact {
  return {
    kind,
    name: path.basename(file.path),
    path: file.path,
    language: file.language,
  };
}

function packageToArtifact(pkg: InventoryPackage): InventoryArtifact {
  const parentName = path.basename(path.dirname(pkg.path));
  return {
    kind: 'package',
    name: pkg.name ?? (parentName || 'package'),
    path: pkg.path,
  };
}

function walkProjectFiles(projectPath: string): string[] {
  const files: string[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name)) continue;
        walk(fullPath);
        continue;
      }
      if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }

  walk(projectPath);
  return files;
}

function isConfigFile(projectPath: string, filePath: string): boolean {
  const relativePath = toRelativePath(projectPath, filePath);
  const basename = path.basename(filePath);
  return CONFIG_BASENAME_PATTERNS.some((pattern) => pattern.test(basename))
    || CONFIG_PATH_PATTERNS.some((pattern) => pattern.test(relativePath));
}

function isVisibleInventoryFile(projectPath: string, filePath: string): boolean {
  const relativePath = toRelativePath(projectPath, filePath);
  return getIndexPathSkipReason(projectPath, relativePath) === null;
}

function toRelativePath(projectPath: string, filePath: string): string {
  return path.relative(projectPath, filePath).split(path.sep).join('/');
}

function packageManifestToInventory(projectPath: string, filePath: string): InventoryPackage | null {
  const relativePath = toRelativePath(projectPath, filePath);
  const basename = path.basename(filePath);

  if (basename === 'package.json') {
    const raw = readJsonObject(filePath);
    const isPrivate = readBoolean(raw, 'private');
    return {
      ecosystem: 'npm',
      path: relativePath,
      name: readString(raw, 'name'),
      version: readString(raw, 'version'),
      scripts: Object.keys(readRecord(raw, 'scripts')).sort(),
      dependencies: Object.keys(readRecord(raw, 'dependencies')).sort(),
      devDependencies: Object.keys(readRecord(raw, 'devDependencies')).sort(),
      ...(isPrivate !== undefined ? { npm: { private: isPrivate } } : {}),
    };
  }

  if (basename === 'Cargo.toml') {
    const content = readText(filePath);
    return {
      ecosystem: 'cargo',
      path: relativePath,
      name: readTomlValue(content, 'package', 'name'),
      version: readTomlValue(content, 'package', 'version'),
      scripts: [],
      dependencies: readTomlSectionKeys(content, 'dependencies'),
      devDependencies: readTomlSectionKeys(content, 'dev-dependencies'),
    };
  }

  if (basename === 'pyproject.toml') {
    const content = readText(filePath);
    const rawDependencies = readTomlArray(content, 'project', 'dependencies');
    return {
      ecosystem: 'python',
      path: relativePath,
      name: readTomlValue(content, 'project', 'name'),
      version: readTomlValue(content, 'project', 'version'),
      scripts: readTomlSectionKeys(content, 'project.scripts'),
      dependencies: rawDependencies.map(parsePep508Name).filter(Boolean).sort(),
      devDependencies: [],
    };
  }

  if (basename === 'requirements.txt') {
    return {
      ecosystem: 'requirements',
      path: relativePath,
      name: path.basename(path.dirname(filePath)),
      scripts: [],
      dependencies: readRequirements(filePath),
      devDependencies: [],
    };
  }

  if (basename === 'go.mod') {
    const content = readText(filePath);
    return {
      ecosystem: 'go',
      path: relativePath,
      name: readGoModuleName(content),
      scripts: [],
      dependencies: readGoRequirements(content),
      devDependencies: [],
    };
  }

  return null;
}

const MAX_MANIFEST_BYTES = 1_000_000;

function readJsonObject(filePath: string): Record<string, unknown> {
  const text = readBoundedText(filePath);
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readText(filePath: string): string {
  return readBoundedText(filePath);
}

function readBoundedText(filePath: string): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const stats = fs.fstatSync(fd);
    if (stats.size > MAX_MANIFEST_BYTES) return '';
    const buffer = Buffer.alloc(stats.size);
    const bytesRead = fs.readSync(fd, buffer, 0, stats.size, 0);
    return buffer.toString('utf8', 0, bytesRead);
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function readRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readTomlValue(content: string, section: string, key: string): string | undefined {
  const sectionContent = readTomlSection(content, section);
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = sectionContent.match(new RegExp(`^\\s*${escapedKey}\\s*=\\s*["']([^"']+)["']`, 'm'));
  return match?.[1];
}

function readTomlSectionKeys(content: string, section: string): string[] {
  return readTomlSection(content, section)
    .split('\n')
    .map((line) => line.trim().match(/^([A-Za-z0-9_.-]+)\s*=/)?.[1])
    .filter((key): key is string => Boolean(key))
    .sort();
}

function readTomlArray(content: string, section: string, key: string): string[] {
  const sectionContent = readTomlSection(content, section);
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const opener = sectionContent.match(new RegExp(`^\\s*${escapedKey}\\s*=\\s*\\[`, 'm'));
  if (!opener || opener.index === undefined) return [];
  const start = opener.index + opener[0].length;
  const body = readBalancedArrayBody(sectionContent, start);
  if (body === null) return [];
  // For arrays of inline tables, extractQuotedStrings returns every quoted value
  // (including version pins), not just dep names. Current callsites only read
  // pyproject [project].dependencies (array of strings per PEP 621), so this
  // limitation is dormant. If a future caller reads an array-of-inline-tables
  // (e.g. Cargo target-specific deps), it needs its own parser.
  return extractQuotedStrings(body).sort();
}

function readBalancedArrayBody(content: string, start: number): string | null {
  let depth = 1;
  let i = start;
  while (i < content.length) {
    const ch = content[i];
    if (ch === '"' || ch === "'") {
      if (content.startsWith(ch + ch + ch, i)) {
        const end = content.indexOf(ch + ch + ch, i + 3);
        if (end === -1) return null;
        i = end + 3;
        continue;
      }
      i++;
      while (i < content.length) {
        const inner = content[i]!;
        if (ch === '"' && inner === '\\' && i + 1 < content.length) {
          i += 2;
          continue;
        }
        if (inner === ch) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return content.slice(start, i);
    }
    i++;
  }
  return null;
}

function parsePep508Name(spec: string): string {
  const trimmed = spec.trim();
  if (!trimmed) return '';
  // PEP 508 direct/URL/VCS forms: 'name @ url', 'git+url#egg=name', or bare URLs.
  // Direct form has the package name on the left of ' @ '.
  const directMatch = trimmed.match(/^([A-Za-z0-9_.\-]+)\s*@\s/);
  if (directMatch) return directMatch[1]!;
  // VCS/URL with #egg=name fragment.
  const eggMatch = trimmed.match(/#egg=([A-Za-z0-9_.\-]+)/);
  if (eggMatch) return eggMatch[1]!;
  // Bare VCS/URL without #egg= has no recoverable name — skip it.
  if (/^(git\+|hg\+|svn\+|bzr\+|https?:|file:|ssh:)/.test(trimmed)) return '';
  const semicolon = trimmed.split(';')[0]!;
  const bracket = semicolon.split('[')[0]!;
  return bracket.split(/[<>=~!\s]/)[0]!.trim();
}

function readTomlSection(content: string, section: string): string {
  const lines = content.split('\n');
  const header = `[${section}]`;
  const sectionLines: string[] = [];
  let inSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!inSection) {
      if (trimmed === header) inSection = true;
      continue;
    }
    if (/^\[[^\]]+\]$/.test(trimmed)) break;
    sectionLines.push(line);
  }

  return sectionLines.join('\n');
}

function extractQuotedStrings(content: string): string[] {
  const values: string[] = [];
  let i = 0;

  while (i < content.length) {
    if (content.startsWith('"""', i)) {
      const end = content.indexOf('"""', i + 3);
      if (end === -1) break;
      values.push(unescapeTomlBasicString(content.slice(i + 3, end)));
      i = end + 3;
      continue;
    }
    if (content.startsWith("'''", i)) {
      const end = content.indexOf("'''", i + 3);
      if (end === -1) break;
      values.push(content.slice(i + 3, end));
      i = end + 3;
      continue;
    }

    const quote = content[i];
    if (quote !== '"' && quote !== "'") {
      i++;
      continue;
    }

    let value = '';
    i++;
    while (i < content.length) {
      const ch = content[i]!;
      if (quote === '"' && ch === '\\') {
        const next = content[i + 1];
        if (next) {
          value += unescapeTomlBasicEscape(next);
          i += 2;
          continue;
        }
      }
      if (ch === quote) {
        i++;
        break;
      }
      value += ch;
      i++;
    }
    values.push(value);
  }

  return values;
}

function unescapeTomlBasicString(value: string): string {
  return value.replace(/\\(["\\btnfr])/g, (_match, escaped: string) => unescapeTomlBasicEscape(escaped));
}

function unescapeTomlBasicEscape(escaped: string): string {
  switch (escaped) {
    case 'b': return '\b';
    case 't': return '\t';
    case 'n': return '\n';
    case 'f': return '\f';
    case 'r': return '\r';
    case '"': return '"';
    case '\\': return '\\';
    default: return escaped;
  }
}

function readRequirements(filePath: string): string[] {
  return readText(filePath)
    .split('\n')
    .map((line) => line.split('#')[0]!.trim())
    .filter((line) => line && !line.startsWith('-'))
    .map(parsePep508Name)
    .filter(Boolean)
    .sort();
}

function readGoModuleName(content: string): string | undefined {
  return content.match(/^module\s+(\S+)/m)?.[1];
}

function readGoRequirements(content: string): string[] {
  const dependencies = new Set<string>();
  const singleRequire = /^require\s+(\S+)\s+/gm;
  let match: RegExpExecArray | null;
  while ((match = singleRequire.exec(content)) !== null) {
    if (match[1] !== '(') dependencies.add(match[1]!);
  }

  const block = content.match(/^require\s*\(([\s\S]*?)\)/m)?.[1] ?? '';
  for (const line of block.split('\n')) {
    const dependency = line.trim().split(/\s+/)[0];
    if (dependency) dependencies.add(dependency);
  }

  return [...dependencies].sort();
}

function compareArtifacts(a: InventoryArtifact, b: InventoryArtifact): number {
  return a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name);
}
