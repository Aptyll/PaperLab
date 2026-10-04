// @ts-check
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

export const NOTES_DIR = path.join(ROOT, 'notes');
const NAME = /^(\d{4}-\d{2}-\d{2})-([a-z0-9-]+)\.md$/;

/**
 * @typedef {Object} Note
 * @property {string} id     File name without .md, also its link.
 * @property {string} date   YYYY-MM-DD, from the file name.
 * @property {string} title  The first "# " line, or the file name.
 * @property {string} body   Markdown after the title.
 */

/**
 * The notebook: every dated Markdown file in notes/, newest first. Read fresh on
 * each call, so a pulled note shows without a restart. Files not named
 * YYYY-MM-DD-title.md (the README) are skipped.
 * @param {string} [dir]
 * @returns {Note[]}
 */
export function readNotes(dir = NOTES_DIR) {
  /** @type {string[]} */
  let files;
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  return files
    .filter((f) => NAME.test(f))
    .sort()
    .reverse()
    .map((f) => {
      const text = readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n');
      const m = /** @type {RegExpMatchArray} */ (f.match(NAME));
      const title = text.match(/^# +(.+)$/m);
      return {
        id: f.slice(0, -3),
        date: m[1],
        title: title ? title[1].trim() : m[2].replace(/-/g, ' '),
        body: title ? text.replace(title[0], '').trim() : text.trim(),
      };
    });
}
