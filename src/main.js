// @ts-check
// Checks the Node version before loading anything that needs node:sqlite,
// so an old Node gives a clear message instead of a module error.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(
    `Paper Lab needs Node 22.13 or newer (you have ${process.versions.node}).\n` +
      'Install the current LTS version from https://nodejs.org and try again.',
  );
  process.exit(1);
}
await import('./run.js');
