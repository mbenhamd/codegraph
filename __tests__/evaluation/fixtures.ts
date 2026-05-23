import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

interface InitializableCodeGraph {
  init(projectRoot: string, options: { index: boolean }): Promise<{ close(): void }>;
}

export async function prepareStructuralFixture(
  evaluationDir: string,
  CodeGraph: InitializableCodeGraph
): Promise<string> {
  const sourceDir = path.join(evaluationDir, 'fixtures', 'structural');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-structural-eval-'));
  if (process.env.EVAL_KEEP_FIXTURE === '1') {
    console.log(`Fixture directory: ${tempDir}`);
  }
  try {
    fs.cpSync(sourceDir, tempDir, { recursive: true });
    const cg = await CodeGraph.init(tempDir, { index: true });
    cg.close();
    return tempDir;
  } catch (error) {
    if (process.env.EVAL_KEEP_FIXTURE !== '1') {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    throw error;
  }
}

export function findLiteralMatches(projectRoot: string, literalText: string): string[] {
  const matches: string[] = [];
  walkFiles(projectRoot, (filePath) => {
    if (filePath.includes(`${path.sep}.codegraph${path.sep}`)) return;
    if (filePath.includes(`${path.sep}node_modules${path.sep}`)) return;
    const content = readTextFile(filePath);
    if (content === null) return;
    if (content.includes(literalText)) {
      matches.push(path.relative(projectRoot, filePath));
    }
  });
  return matches.sort();
}

function readTextFile(filePath: string): string | null {
  const buffer = fs.readFileSync(filePath);
  if (buffer.includes(0)) return null;
  return buffer.toString('utf-8');
}

function walkFiles(root: string, visit: (filePath: string) => void): void {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, visit);
    } else if (entry.isFile()) {
      visit(fullPath);
    }
  }
}
