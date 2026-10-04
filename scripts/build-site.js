// @ts-check
// Builds the public demo site into _site/: the same page as Paper Lab, reading
// the session saved by scripts/export-demo.js instead of a running Paper Lab.
// GitHub Pages publishes it (.github/workflows/pages.yml).
//
//   node scripts/build-site.js

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/config.js';

const OUT = path.join(ROOT, '_site');
const DATA = path.join(ROOT, 'demo', 'data');
const repo = process.env.GITHUB_REPOSITORY ?? 'Aptyll/Tool';

if (!existsSync(path.join(DATA, 'manifest.json'))) {
  console.error('No saved session in demo/data/. Run "node scripts/export-demo.js" on the computer that has the data first.');
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(path.join(DATA, 'manifest.json'), 'utf8'));

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(path.join(ROOT, 'public'), OUT, { recursive: true });
cpSync(DATA, path.join(OUT, 'demo-data'), { recursive: true });

// The site lives under /<repo>/, so the page's own files load by relative path.
const page = readFileSync(path.join(OUT, 'index.html'), 'utf8')
  .replace(/(href|src)="\/(style\.css|app\.js|vendor\/)/g, '$1="$2')
  .replace('<title>Paper Lab</title>', '<title>Paper Lab demo</title>\n  <meta name="description" content="A recorded paper-trading session from Paper Lab: ten bots trading pretend money on trending Solana memecoins.">')
  .replace('<script src="vendor/', '<script src="demo-data/demo.js"></script>\n  <script src="vendor/');
if (!page.includes('demo-data/demo.js')) throw new Error('index.html changed shape: the demo script was not added');
writeFileSync(path.join(OUT, 'index.html'), page);

const demo = {
  session: manifest.session,
  startedAt: manifest.startedAt,
  recordedAt: manifest.recordedAt,
  download: {
    windows: `https://github.com/${repo}/releases/latest/download/PaperLab-Windows.zip`,
    mac: `https://github.com/${repo}/releases/latest/download/PaperLab-Mac.zip`,
    setup: `https://github.com/${repo}/blob/main/SETUP.md`,
  },
};
writeFileSync(path.join(OUT, 'demo-data', 'demo.js'), `window.PAPER_LAB_DEMO = ${JSON.stringify(demo)};\n`);
// Serve files as they are (no Jekyll processing).
writeFileSync(path.join(OUT, '.nojekyll'), '');
console.log(`Built the demo site in _site/ (Session ${manifest.session}).`);
