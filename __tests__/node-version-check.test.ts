/**
 * Pin the Node-25 block banner content. The banner replaced a soft
 * `console.warn` because the warning was scrolling off-screen before
 * the OOM crash 30 seconds later, generating duplicate bug reports
 * (#54, #81, #140). The recipe and override env var below are
 * load-bearing — if any of them get edited away, this test catches it.
 */

import { describe, it, expect } from 'vitest';
import {
  buildNode25BlockBanner,
  buildNodeTooOldBanner,
  isNodeVersionBelowMinimum,
  MIN_NODE_VERSION,
} from '../src/bin/node-version-check';

describe('buildNode25BlockBanner', () => {
  it('embeds the reported Node version in the header', () => {
    expect(buildNode25BlockBanner('25.9.0')).toContain(
      'Unsupported Node.js version: 25.9.0'
    );
  });

  it('names the V8 turboshaft WASM root cause and the OOM symptom', () => {
    const banner = buildNode25BlockBanner('25.7.0');
    expect(banner).toContain('V8 WASM JIT');
    expect(banner).toContain('turboshaft');
    expect(banner).toContain('Fatal process out of memory: Zone');
  });

  it('points users to a supported LTS via nvm and Homebrew', () => {
    const banner = buildNode25BlockBanner('25.7.0');
    expect(banner).toContain('Node.js LTS');
    expect(banner).toContain('nvm install 24');
    expect(banner).toContain('brew install node@24');
  });

  it('documents the CODEGRAPH_ALLOW_UNSAFE_NODE override', () => {
    const banner = buildNode25BlockBanner('25.7.0');
    expect(banner).toContain('CODEGRAPH_ALLOW_UNSAFE_NODE=1');
  });

  it('links to issue #81 for the root-cause writeup', () => {
    expect(buildNode25BlockBanner('25.7.0')).toContain(
      'github.com/colbymchenry/codegraph/issues/81'
    );
  });
});

describe('buildNodeTooOldBanner', () => {
  it('embeds the reported Node version in the header', () => {
    expect(buildNodeTooOldBanner('18.20.0')).toContain(
      'Unsupported Node.js version: 18.20.0'
    );
  });

  it('states the supported floor matching MIN_NODE_VERSION', () => {
    expect(MIN_NODE_VERSION).toBe('22.13.0');
    expect(buildNodeTooOldBanner('18.0.0')).toContain(
      `requires Node.js ${MIN_NODE_VERSION} or newer`
    );
  });

  it('points users to a supported LTS via nvm and Homebrew', () => {
    const banner = buildNodeTooOldBanner('16.0.0');
    expect(banner).toContain('Node.js LTS');
    expect(banner).toContain('nvm install 24');
    expect(banner).toContain('brew install node@24');
  });

  it('documents the CODEGRAPH_ALLOW_UNSAFE_NODE override', () => {
    expect(buildNodeTooOldBanner('18.0.0')).toContain('CODEGRAPH_ALLOW_UNSAFE_NODE=1');
  });
});

describe('isNodeVersionBelowMinimum', () => {
  it('rejects releases below the node:sqlite source runtime floor', () => {
    expect(isNodeVersionBelowMinimum('20.12.0')).toBe(true);
    expect(isNodeVersionBelowMinimum('22.4.1')).toBe(true);
    expect(isNodeVersionBelowMinimum('22.12.0')).toBe(true);
  });

  it('accepts Node 22 releases at or above the node:sqlite source runtime floor', () => {
    expect(isNodeVersionBelowMinimum('22.13.0')).toBe(false);
    expect(isNodeVersionBelowMinimum('22.17.1')).toBe(false);
  });

  it('accepts newer supported majors below the Node 25 hard block', () => {
    expect(isNodeVersionBelowMinimum('24.16.0')).toBe(false);
  });
});
