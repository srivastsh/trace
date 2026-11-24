import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { chatURL, dist, fixtureId, project } from '../tests/integration/browser.mjs';
import { history, historyPath } from '../tests/integration/data.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const manifestBytes = await readFile(join(dist, 'manifest.json'));
const production = JSON.parse(manifestBytes);
const releaseFiles = (await readdir(dist, { recursive: true, withFileTypes: true }))
  .filter(file => file.isFile()).map(file => relative(dist, join(file.parentPath, file.name))).sort();
const digests = Object.fromEntries(await Promise.all(releaseFiles.map(async name => [name.split(sep).join('/'), sha256(await readFile(join(dist, name)))])));
const fixture = await readFile(join(project, 'tests/host/conversation.html'), 'utf8');
const resultDir = join(project, 'test-results');
await mkdir(resultDir, { recursive: true });
const target = await mkdtemp(join(resultDir, 'trace-fixture-runner-'));
const id = sha256(Buffer.from(production.key, 'base64')).slice(0, 32)
  .replace(/./g, char => String.fromCharCode(97 + Number.parseInt(char, 16)));
const runner = {
  manifest_version: 3,
  name: 'Trace isolated fixture runner',
  description: 'Local testing in the separate signed-out Trace QA browser profile.',
  version: '0.1.0',
  incognito: 'not_allowed',
  permissions: ['debugger', 'tabs'],
  options_ui: { page: 'qa.html', open_in_tab: true },
  content_security_policy: {
    extension_pages: "default-src 'none'; script-src 'self'; style-src 'self'; img-src data:; connect-src 'none'; object-src 'none'; frame-src 'none'",
  },
};
await writeFile(join(target, 'manifest.json'), JSON.stringify(runner, null, 2) + '\n');
for (const name of ['qa.html', 'qa.css', 'qa.js']) {
  await cp(join(project, 'tests/integration/native', name), join(target, name));
}
await cp(join(project, 'tests/integration/host-workload.mjs'), join(target, 'qa-host-workload.js'));
const fixtureModule = {
  url: chatURL(), historyPath: historyPath(fixtureId), history: history(fixtureId), fixture,
  production: { name: production.name, version: production.version, id, manifestSha256: sha256(manifestBytes), fileSetSha256: sha256(JSON.stringify(digests)), fileCount: releaseFiles.length },
};
await writeFile(join(target, 'qa-fixture.js'), `export default ${JSON.stringify(fixtureModule)};\n`);
console.log(target);
console.log(`Load the unchanged release first from ${dist}`);
console.log('Load this separate runner only in the signed-out Trace QA profile. Open its Details, then Extension options.');
