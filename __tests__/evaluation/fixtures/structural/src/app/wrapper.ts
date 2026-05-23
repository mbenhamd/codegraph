import { buildConfig } from '../core/config.js';
import { persistOrder } from '../core/persist.js';

function withTx<T extends (...args: never[]) => unknown>(fn: T): T {
  return fn;
}

function withDefaults<T>(fn: () => T): T {
  return fn();
}

export const saveOrder = withTx(() => {
  return persistOrder('wrapped');
});

export const defaults = withDefaults(() => buildConfig());
