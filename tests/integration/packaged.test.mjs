import assert from 'node:assert/strict';
import { createHash, createPublicKey } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { dist, project } from './browser.mjs';

const manifest = async () => JSON.parse(await readFile(join(dist, 'manifest.json'), 'utf8'));

test('packaged permissions, origins, stable public key, and CSP stay in the release allowlist', async t => {
  const actual = await manifest();
  const packageInfo = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
  assert.equal(actual.manifest_version, 3);
  assert.equal(actual.version, packageInfo.version);
  assert.equal(actual.incognito, 'not_allowed');
  assert.equal(actual.background.type, 'module');
  assert.ok(Number(actual.minimum_chrome_version) >= 120);
  assert.deepEqual([...actual.permissions].sort(), ['alarms', 'storage']);
  for (const property of ['host_permissions', 'optional_host_permissions', 'optional_permissions']) {
    assert.equal(actual[property]?.length ?? 0, 0, property);
  }
  assert.equal(actual.externally_connectable, undefined);
  assert.equal(actual.web_accessible_resources?.length ?? 0, 0);
  const worlds = actual.content_scripts.map(script => script.world).sort();
  assert.deepEqual(worlds, ['ISOLATED', 'MAIN']);
  for (const script of actual.content_scripts) {
    assert.deepEqual(script.matches, ['https://chatgpt.com/*']);
    assert.equal(script.all_frames ?? false, false);
    assert.equal(script.match_about_blank ?? false, false);
    assert.equal(script.match_origin_as_fallback ?? false, false);
    assert.equal(script.run_at, 'document_start');
  }
  for (const command of Object.values(actual.commands ?? {})) {
    assert.equal(command.suggested_key, undefined, 'Shortcuts must be unassigned by default.');
  }
  const policy = Object.fromEntries(actual.content_security_policy.extension_pages.split(';').map(rule => {
    const [directive, ...values] = rule.trim().split(/\s+/);
    return [directive, values];
  }));
  assert.deepEqual(policy['default-src'], ["'none'"]);
  assert.deepEqual(policy['script-src'], ["'self'"]);
  assert.deepEqual(policy['connect-src'], ["'none'"]);
  assert.deepEqual(policy['frame-src'], ["'none'"]);
  assert.deepEqual(policy['form-action'], ["'none'"]);
  assert.deepEqual(policy['img-src']?.toSorted(), ["'self'", 'data:']);
  const publicKey = Buffer.from(actual.key, 'base64');
  assert.equal(createPublicKey({ key: publicKey, format: 'der', type: 'spki' }).type, 'public');
  const id = createHash('sha256').update(publicKey).digest('hex').slice(0, 32)
    .replace(/./g, char => String.fromCharCode(97 + Number.parseInt(char, 16)));
  const previous = JSON.parse(await readFile(join(project, 'manifest.json'), 'utf8'));
  assert.equal(actual.key, previous.key, 'The packaged key must match the source public key.');
  t.diagnostic(`Manifest extension ID ${id}, release ${actual.version}`);
});

test('manifest entrypoints and production pages resolve to local packaged files', async t => {
  const actual = await manifest();
  const files = await readdir(dist, { recursive: true, withFileTypes: true });
  const entries = files.filter(entry => entry.isFile()).map(entry => relative(dist, join(entry.parentPath, entry.name)));
  assert.ok(entries.length >= 6, 'The package must contain the compiled extension.');
  assert.ok(files.every(entry => entry.isDirectory() || entry.isFile()), 'No symlinks or special files in the package.');
  const prohibitedNames = /(?:^|\/)(?:node_modules|fixtures?|tests?|vendor|devtools|qa)(?:\/|\.|$)|(?:\.map|\.pem|\.env|\.har|\.ts|\.tsx)$/i;
  assert.deepEqual(entries.filter(entry => prohibitedNames.test(entry.split(sep).join('/'))), []);
  const refs = [actual.background.service_worker, actual.action.default_popup, actual.options_ui.page,
    ...Object.values(actual.icons ?? {}), ...Object.values(actual.action.default_icon ?? {}),
    ...actual.content_scripts.flatMap(script => [...script.js, ...(script.css ?? [])])];
  const mustBeLocal = async (value, base = dist) => {
    const clean = value.split(/[?#]/, 1)[0];
    assert.ok(clean && !/^(?:[\w+.-]+:|\/\/)/.test(clean), `Nonlocal asset ${value}`);
    const path = clean.startsWith('/') ? resolve(dist, '.' + clean) : resolve(base, clean);
    assert.ok(path.startsWith(dist + sep), `Asset bypasses extension directory: ${value}`);
    assert.ok((await stat(path)).isFile(), `Missing file ${value}`);
  };
  for (const value of refs) await mustBeLocal(value);
  for (const entry of entries) {
    if (extname(entry) === '.html') {
      const html = await readFile(join(dist, entry), 'utf8');
      assert.doesNotMatch(html, /<script\b(?![^>]*\bsrc\s*=)[^>]*>/i, `${entry} has inline script`);
      assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `${entry} has inline event handlers`);
      for (const [, path] of html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
        if (!path.startsWith('#')) await mustBeLocal(path, resolve(dist, entry, '..'));
      }
    }
    if (extname(entry) === '.css') {
      const css = await readFile(join(dist, entry), 'utf8');
      assert.doesNotMatch(css, /(?:url\s*\(\s*|@import\s+)["']?(?:https?:)?\/\//i, `${entry} references a remote style asset`);
    }
  }
  t.diagnostic(`Audited ${entries.length} packaged files.`);
});
