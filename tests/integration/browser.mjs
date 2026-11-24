import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const project = fileURLToPath(new URL('../../', import.meta.url));
export const dist = resolve(process.env.TRACE_DIST ?? join(project, 'dist'));
export const host = 'https://chatgpt.com';
export const fixtureId = '7b9816ed-2917-4839-bc7e-3c7724944e0d';
export const secondFixtureId = '98ff016f-a9bd-4431-9501-8b115a0bc613';
export const chatURL = (id = fixtureId) => `${host}/c/${id}`;
const chromeOrigin = value => `chrome-extension://${new URL(value).hostname}`;

const require = createRequire(import.meta.url);

export async function eventually(check, { timeout = 5_000, interval = 40 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    try { return await check(); }
    catch (error) {
      if (Date.now() >= end) throw error;
      await delay(interval);
    }
  }
}

export async function startTestBrowser({
  extension = true,
  fixture,
  pages = [],
  viewport = { width: 1280, height: 850 },
  colorScheme = 'light',
  reducedMotion = 'reduce',
} = {}) {
  const { chromium } = require(process.env.TRACE_PLAYWRIGHT_MODULE ?? 'playwright');
  if (extension) await readFile(join(dist, 'manifest.json'));
  const violations = [];
  const requests = [];
  const pageErrors = [];
  const fixtures = new Map(pages);
  const allowedAppRequests = new Map();
  if (fixture === undefined) {
    fixture = await readFile(new URL('../host/conversation.html', import.meta.url), 'utf8');
  }
  const profile = await mkdtemp(join(tmpdir(), 'trace-qa-'));

  const launch = async () => {
    const args = [
      '--host-resolver-rules=MAP * ~NOTFOUND',
      '--disable-background-networking',
      '--disable-component-update',
      '--no-pings',
    ];
    if (extension) args.push(`--disable-extensions-except=${dist}`, `--load-extension=${dist}`);
    const executablePath = process.env.TRACE_CHROMIUM_EXECUTABLE;
    const context = await chromium.launchPersistentContext(profile, {
      ...(executablePath ? { executablePath } : { channel: 'chromium' }),
      args, viewport, colorScheme, reducedMotion,
      ...(extension ? { ignoreDefaultArgs: ['--disable-extensions'] } : {}),
      headless: process.env.TRACE_CHROMIUM_HEADED !== '1',
      acceptDownloads: true,
    });
    context.setDefaultTimeout(5_000);
    context.on('weberror', item => pageErrors.push(item.error().message));

    await context.routeWebSocket('**/*', socket => {
      violations.push(`WEBSOCKET ${socket.url()}`);
      socket.close();
    });
    await context.route(/^https?:\/\//, async route => {
      const request = route.request();
      const url = new URL(request.url());
      const label = `${request.method()} ${url.origin}${url.pathname}`;
      requests.push(label);

      const expected = allowedAppRequests.get(label);
      if (expected?.length) {
        const options = expected.shift();
        await route.fulfill(options);
        return;
      }

      if (request.method() === 'GET' && request.isNavigationRequest()) {
        const document = fixtures.get(url.origin + url.pathname)
          ?? (url.origin === host && /^\/(?:c\/[^/]+)?$/.test(url.pathname) ? fixture : undefined);
        if (document !== undefined) {
          await route.fulfill({ contentType: 'text/html; charset=utf-8', body: document });
          return;
        }
      }
      // Chromium can request the document favicon independently of the application.
      if (request.method() === 'GET' && url.origin === host && url.pathname === '/favicon.ico') {
        await route.fulfill({ status: 204 });
        return;
      }

      violations.push(label);
      await route.abort('blockedbyclient');
    });
    return context;
  };

  const worker = async () => {
    const serviceWorker = context.serviceWorkers().find(item => item.url().startsWith('chrome-extension://'))
      ?? await context.waitForEvent('serviceworker', {
        predicate: item => item.url().startsWith('chrome-extension://'),
        timeout: 12_000,
      });
    return serviceWorker;
  };

  let context;
  try {
    context = await launch();
    const extensionOrigin = extension ? chromeOrigin((await worker()).url()) : undefined;
    return {
      get context() { return context; },
      get browserVersion() { return context.browser()?.version(); },
      extensionOrigin,
      extensionUrl(name = 'library.html') {
        assert.ok(extensionOrigin, 'This browser did not load the extension.');
        return `${extensionOrigin}/${name}`;
      },
      navigateFixture(url, document) { fixtures.set(url, document); },
      allowAppRequest(method, path, options) {
        const label = `${method} ${host}${path}`;
        const queue = allowedAppRequests.get(label) ?? [];
        queue.push(options);
        allowedAppRequests.set(label, queue);
      },
      requests,
      pageErrors,
      assertNetwork() {
        assert.deepEqual(violations, [], 'Unexpected request attempted during offline fixture use.');
        const missing = [...allowedAppRequests].filter(([, queue]) => queue.length).map(([url]) => url);
        assert.deepEqual(missing, [], 'Expected synthetic host calls were unused.');
      },
      worker,
      async restart() {
        await context.close();
        context = await launch();
        if (extension) assert.equal(chromeOrigin((await worker()).url()), extensionOrigin);
      },
      async close() {
        try { await context.close(); }
        finally { await rm(profile, { recursive: true, force: true }); }
      },
    };
  } catch (error) {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
    throw error;
  }
}

export function chatMenuTrigger(page) {
  return page.getByRole('banner').getByRole('button', { name: 'Chat actions', exact: true });
}

export function traceItem(page) {
  return page.getByRole('menuitem', { name: 'Trace', exact: true });
}

export async function openTraceMenu(page) {
  await chatMenuTrigger(page).click();
  await traceItem(page).click();
  const menu = page.getByRole('menu', { name: 'Trace actions', exact: true });
  await menu.waitFor();
  return menu;
}

export async function openTracePage(browser, page, action) {
  const menu = await openTraceMenu(page);
  const route = { 'Local library': '#library', Settings: '#settings' }[action] ?? '#stage/';
  const destinationURL = url => chromeOrigin(url) === browser.extensionOrigin && url.pathname === '/library.html'
    && url.hash.startsWith(route);
  const opened = browser.context.waitForEvent('page', {
    predicate: candidate => candidate.waitForURL(destinationURL).then(() => true, () => false),
  });
  await menu.getByRole('menuitem', { name: action, exact: true }).click();
  const destination = await opened;
  assert.equal(chromeOrigin(destination.url()), browser.extensionOrigin);
  return destination;
}
