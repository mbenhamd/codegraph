import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { INSTRUCTIONS_TEMPLATE } from '../src/installer/instructions-template';
import { getCodeGraphPermissions } from '../src/installer/targets/shared';
import { SERVER_INSTRUCTIONS } from '../src/mcp/server-instructions';

describe('agent CodeGraph guidance', () => {
  it('calibrates installed instructions around structural first-pass usage', () => {
    expect(INSTRUCTIONS_TEMPLATE).toContain('first pass for structural');
    expect(INSTRUCTIONS_TEMPLATE).toContain('literal text');
    expect(INSTRUCTIONS_TEMPLATE).toContain('comments, log messages');
    expect(INSTRUCTIONS_TEMPLATE).toContain('not a source of truth');
    expect(INSTRUCTIONS_TEMPLATE).toContain('low-confidence');
    expect(INSTRUCTIONS_TEMPLATE).toContain('edit-critical');
    expect(INSTRUCTIONS_TEMPLATE).not.toContain('Trust codegraph results');
    expect(INSTRUCTIONS_TEMPLATE).not.toContain('Do NOT re-verify');
  });

  it('keeps MCP initialize guidance consistent with installed instructions', () => {
    expect(SERVER_INSTRUCTIONS).toContain('first pass for');
    expect(SERVER_INSTRUCTIONS).toContain('native grep/read');
    expect(SERVER_INSTRUCTIONS).toContain('exact string/comment/log message');
    expect(SERVER_INSTRUCTIONS).toContain('best-effort');
    expect(SERVER_INSTRUCTIONS).toContain('low-confidence');
    expect(SERVER_INSTRUCTIONS).toContain('edit-critical');
    expect(SERVER_INSTRUCTIONS).not.toContain('Trust codegraph results');
    expect(SERVER_INSTRUCTIONS).not.toContain('Do NOT re-verify');
  });

  it('keeps public README install guidance calibrated', () => {
    const readme = fs.readFileSync(path.resolve(__dirname, '../README.md'), 'utf-8');
    expect(readme).toContain('calibrated CodeGraph guidance');
    expect(readme).toContain('first pass for structural questions');
    expect(readme).toContain('Use native grep/read for literal text queries');
    expect(readme).not.toContain('ALWAYS spawn an Explore agent');
    expect(readme).not.toContain('source sections are complete and authoritative');
  });

  it('auto-allows the tools recommended by calibrated guidance', () => {
    expect(getCodeGraphPermissions()).toEqual(expect.arrayContaining([
      'mcp__codegraph__codegraph_context',
      'mcp__codegraph__codegraph_explore',
      'mcp__codegraph__codegraph_files',
    ]));
  });

  it('keeps README manual Claude settings JSON valid', () => {
    const readme = fs.readFileSync(path.resolve(__dirname, '../README.md'), 'utf-8');
    const match = readme.match(/Add to `~\/\.claude\/settings\.json`[\s\S]*?```json\n([\s\S]*?)\n```/);
    expect(match?.[1]).toBeDefined();
    expect(() => JSON.parse(match![1])).not.toThrow();
  });
});
