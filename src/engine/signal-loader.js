// @ts-check
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../config.js';

/** @typedef {import('../types.js').SignalModule} SignalModule */

export const SIGNALS_DIR = path.join(ROOT, 'src', 'signals');

/** Strategy name reserved for the random control trades. */
export const RANDOM_STRATEGY = 'random';

/**
 * @param {unknown} m
 * @param {string} file
 * @returns {SignalModule}
 */
function validate(m, file) {
  const s = /** @type {any} */ (m);
  const problems = [];
  if (!s || typeof s !== 'object') problems.push('default export is not an object');
  else {
    if (typeof s.id !== 'string' || !/^[a-z0-9-]+$/.test(s.id)) problems.push('id must be a lowercase slug');
    if (s.id === RANDOM_STRATEGY) problems.push(`id "${RANDOM_STRATEGY}" is reserved`);
    if (typeof s.name !== 'string') problems.push('name must be a string');
    if (typeof s.description !== 'string') problems.push('description must be a string');
    if (typeof s.params !== 'object' || s.params === null) problems.push('params must be an object');
    if (typeof s.evaluate !== 'function') problems.push('evaluate must be a function');
  }
  if (problems.length) throw new Error(`Bad signal module ${file}: ${problems.join('; ')}`);
  return s;
}

/**
 * Load every signal module in a directory. Each .js file not starting with "_"
 * must default-export a SignalModule. Adding a signal = adding a file.
 *
 * @param {Record<string, Record<string, number>>} [overrides]  Per-signal param overrides from config.
 * @param {string} [dir]
 * @returns {Promise<SignalModule[]>}
 */
export async function loadSignals(overrides = {}, dir = SIGNALS_DIR) {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.js') && !f.startsWith('_'))
    .sort();
  /** @type {SignalModule[]} */
  const out = [];
  const seen = new Set();
  for (const f of files) {
    const mod = await import(pathToFileURL(path.join(dir, f)).href);
    const sig = validate(mod.default, f);
    if (seen.has(sig.id)) throw new Error(`Duplicate signal id "${sig.id}" in ${f}`);
    seen.add(sig.id);
    out.push({ ...sig, params: { ...sig.params, ...(overrides[sig.id] ?? {}) } });
  }
  return out;
}
