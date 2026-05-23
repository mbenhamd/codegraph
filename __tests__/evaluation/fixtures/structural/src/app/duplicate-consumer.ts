import { duplicateName } from '../core/persist.js';

export function useDuplicate(): string {
  return duplicateName();
}
