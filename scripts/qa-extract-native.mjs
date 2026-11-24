import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { project } from '../tests/integration/browser.mjs';

const input = process.argv[2];
if (!input) throw Error('Pass the JSON report downloaded by the native fixture runner.');
const report = JSON.parse(await readFile(input, 'utf8'));
const target = resolve(process.argv[3] ?? join(project, 'test-results/screenshots'));
const validName = /^trace-(?:menu|activity|library|handoff)-(?:light|dark)\.png$/;
const pngHeader = Buffer.from('89504e470d0a1a0a', 'hex');
const files = new Map();
assert.ok(Array.isArray(report.cases) && Array.isArray(report.screenshots), 'Invalid fixture report.');
for (const item of report.screenshots) {
  assert.match(item.filename, validName);
  assert.equal(item.mimeType, 'image/png');
  assert.ok(!files.has(item.filename), 'Duplicate fixture filename.');
  const bytes = Buffer.from(item.base64, 'base64');
  assert.deepEqual(bytes.subarray(0, pngHeader.length), pngHeader);
  files.set(item.filename, bytes);
}
await mkdir(target, { recursive: true });
for (const [filename, bytes] of files) await writeFile(join(target, filename), bytes);
await writeFile(join(target, 'trace-isolated-browser-summary.json'), JSON.stringify({
  ...report, screenshots: [...files.keys()],
}, null, 2) + '\n');
console.log(`${files.size} screenshots and the summary were saved in ${target}`);
if (report.cases.some(item => item.status !== 'passed')) process.exitCode = 1;
