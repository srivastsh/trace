import fixture from './qa-fixture.js';
import { eventsPerRun, fixtureTurns, seedWorkload, summarize } from './qa-host-workload.js';

const byId = id => document.getElementById(id);
const status = byId('status');
const results = byId('results');
const screenshots = byId('screenshots');
const controllerTab = (await chrome.tabs.getCurrent()).id;
const releaseOrigin = `chrome-extension://${fixture.production.id}/`;
const fixtureCsp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (value, message) => { if (!value) throw Error(message); };
const fixtureTabs = new Set();

addEventListener('pagehide', () => {
  if (fixtureTabs.size) void chrome.tabs.remove([...fixtureTabs]).catch(() => {});
});

function encode(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

async function waitFor(read, message) {
  const limit = performance.now() + 5000;
  do {
    const result = await read();
    if (result) return result;
    await sleep(50);
  } while (performance.now() < limit);
  throw Error(message);
}

const headingSelector = 'header button[aria-label="Chat actions"], header [data-testid="conversation-header-actions-menu"]';
const traceSelector = '[role="menuitem"]';
const submenuSelector = '[role="menu"][aria-label="Trace actions"]';
const activitySelector = '[role="dialog"][aria-label="Activity"]';

async function openFixture(theme, baseline = false) {
  const url = new URL(fixture.url);
  if (baseline) url.hostname = 'trace-fixture.invalid';
  const origin = url.origin;
  const documentUrl = url.href;
  const { id: tabId } = await chrome.tabs.create({ url: 'about:blank', active: true });
  fixtureTabs.add(tabId);
  const target = { tabId };
  const call = (method, params = {}) => chrome.debugger.sendCommand(target, method, params);
  const requestLog = [];
  const networkErrors = [];
  let expectedHistoryFetches = 0;

  async function intercept(eventTarget, method, params) {
    if (eventTarget.tabId !== tabId) return;
    if (method === 'Network.webSocketCreated') {
      networkErrors.push('Unexpected WebSocket attempt.');
      return;
    }
    if (method !== 'Fetch.requestPaused') return;
    const { requestId, request } = params;
    const url = new URL(request.url);
    const label = `${request.method} ${url.origin}${url.pathname}`;
    requestLog.push(label);
    let body;
    let contentType;
    let responseCode = 200;
    if (request.method === 'GET' && request.url === documentUrl && params.resourceType === 'Document') {
      body = fixture.fixture;
      contentType = 'text/html; charset=utf-8';
    } else if (request.method === 'GET' && request.url === `${origin}${fixture.historyPath}` && expectedHistoryFetches > 0) {
      expectedHistoryFetches--;
      body = JSON.stringify(fixture.history);
      contentType = 'application/json; charset=utf-8';
    } else if (request.method === 'GET' && request.url === `${origin}/favicon.ico`) {
      body = '';
      contentType = 'image/x-icon';
      responseCode = 204;
    }
    try {
      if (body === undefined) {
        networkErrors.push(label);
        await call('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
      } else {
        await call('Fetch.fulfillRequest', { requestId, responseCode, body: encode(body), responseHeaders: [
          { name: 'Content-Type', value: contentType },
          { name: 'Cache-Control', value: 'no-store' },
          { name: 'Content-Security-Policy', value: fixtureCsp },
        ] });
      }
    } catch (error) {
      networkErrors.push(String(error.message || error));
    }
  }

  const close = async () => {
    try { await chrome.tabs.remove(tabId); }
    catch { /* The test tab may already be closed. */ }
    finally {
      fixtureTabs.delete(tabId);
      chrome.debugger.onEvent.removeListener(intercept);
    }
  };
  const evaluate = async (fn, ...args) => {
    const expression = `(${fn})(${args.map(value => JSON.stringify(value)).join(',')})`;
    const value = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (value.exceptionDetails) throw Error(value.result.description || value.exceptionDetails.text);
    return value.result.value;
  };
  const elements = (selector, text = '') => evaluate((selector, text) => [...document.querySelectorAll(selector)]
    .filter(element => {
      const label = element.getAttribute('aria-label') || [...element.childNodes]
        .filter(node => !(node instanceof Element && node.getAttribute('aria-hidden') === 'true'))
        .map(node => node.textContent).join('').trim();
      return (!text || label === text) && element.getClientRects().length;
    })
    .map(element => {
      const box = element.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2, text: element.innerText };
    }), selector, text);
  const element = async (selector, text = '') => waitFor(async () => (await elements(selector, text))[0], `Missing visible control ${text || selector}.`);

  const click = async (selector, text = '') => {
    const { x, y } = await element(selector, text);
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const key = async (key, code = key) => {
    const windowsVirtualKeyCode = { ArrowDown: 40, ArrowUp: 38, ArrowRight: 39, ArrowLeft: 37,
      Enter: 13, Escape: 27, Space: 32, KeyM: 77, End: 35 }[code];
    await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode });
  };
  const resize = (width, height) => call('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false,
  });
  const assertNetwork = () => {
    assert(!networkErrors.length, `Unexpected fixture requests or routing errors: ${networkErrors.join(', ')}`);
    assert(!expectedHistoryFetches, 'An expected synthetic history fetch was missed.');
  };

  try {
    chrome.debugger.onEvent.addListener(intercept);
    await chrome.debugger.attach(target, '1.3');
    await call('Network.enable');
    await call('Network.setCacheDisabled', { cacheDisabled: true });
    await call('Fetch.enable', { patterns: [{ urlPattern: 'https://*' }, { urlPattern: 'http://*' }] });
    await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 850, deviceScaleFactor: 1, mobile: false });
    await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
    const navigation = await call('Page.navigate', { url: documentUrl });
    assert(!navigation.errorText, `Synthetic navigation failed: ${navigation.errorText}`);
    await element(headingSelector);
    await waitFor(() => evaluate(() => !!window.traceFixture), 'The synthetic fixture did not initialize.');
    await evaluate(theme => window.traceFixture.theme(theme), theme);
    return {
      tabId, evaluate, element, elements, click, key, escape: () => key('Escape'), resize, close, assertNetwork, requestLog,
      async setTheme(nextTheme) {
        await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: nextTheme }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
        await evaluate(value => window.traceFixture.theme(value), nextTheme);
      },
      async fetchHistory() {
        expectedHistoryFetches++;
        const response = await evaluate(async path => (await fetch(path)).json(), fixture.historyPath);
        assert(response.conversation_id === fixture.history.conversation_id, 'The page did not receive its fixture response.');
      },
      async screenshot() {
        return (await call('Page.captureScreenshot', { format: 'png', fromSurface: true })).data;
      },
      async performance(mode) {
        await evaluate(seedWorkload, { turns: fixtureTurns, mode });
        await sleep(300);
        await call('Performance.enable');
        const scriptTime = async () => (await call('Performance.getMetrics')).metrics.find(metric => metric.name === 'ScriptDuration').value;
        const before = await scriptTime();
        const waitFrame = (type, count) => evaluate((kind, target) => new Promise(resolve => {
          const timer = setTimeout(() => resolve(false), 2000);
          const check = () => {
            if (window.tracePerformance[kind].length >= target) {
              clearTimeout(timer);
              resolve(true);
            } else requestAnimationFrame(check);
          };
          check();
        }), type, count);
        for (let index = 0; index < eventsPerRun; index++) {
          await call('Input.insertText', { text: 'a' });
          assert(await waitFrame('input', index + 1), 'No compositor timing for synthetic typing.');
        }
        for (let index = 0; index < eventsPerRun; index++) {
          await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 840, y: 335, deltaX: 0, deltaY: index % 2 ? -360 : 360 });
          assert(await waitFrame('wheel', index + 1), 'No compositor timing for synthetic scrolling.');
        }
        const totalScriptMs = Number(((await scriptTime() - before) * 1000).toFixed(2));
        const { input, wheel } = await evaluate(() => window.tracePerformance);
        return { typing: summarize(input), scroll: summarize(wheel), totalScriptMs };
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

function addScreenshot(name, bytes, report) {
  const link = document.createElement('a');
  link.href = `data:image/png;base64,${bytes}`;
  link.download = `${name}.png`;
  link.textContent = `${name}.png`;
  const image = document.createElement('img');
  image.src = link.href;
  image.alt = name.replaceAll('-', ' ');
  const figure = document.createElement('figure');
  const caption = document.createElement('figcaption');
  caption.append(link);
  figure.append(image, caption);
  screenshots.append(figure);
  report.screenshots.push({ filename: link.download, mimeType: 'image/png', base64: bytes });
}

const openMenu = async driver => {
  await driver.click(headingSelector);
  await driver.click(traceSelector, 'Trace');
  await driver.element(submenuSelector);
};

async function hostKeyboard(driver) {
  const focusedLabel = label => waitFor(
    () => driver.evaluate(label => {
      const active = document.activeElement;
      const text = [...active.childNodes]
        .filter(node => !(node instanceof Element && node.getAttribute('aria-hidden') === 'true'))
        .map(node => node.textContent).join('').trim();
      return text === label;
    }, label), `Keyboard focus did not reach ${label}.`);
  const focusTrigger = () => driver.evaluate(selector => document.querySelector(selector).focus(), headingSelector);

  await focusTrigger();
  await driver.key('ArrowDown');
  await driver.element(traceSelector, 'Trace');
  await focusedLabel('Pin');
  await driver.key('m', 'KeyM');
  await focusedLabel('Move to project');
  await driver.key('ArrowRight');
  await driver.element('#move-menu');
  await focusedLabel('Miata');
  await driver.key('ArrowDown');
  await focusedLabel('Transit');
  await driver.escape();
  await focusedLabel('Move to project');
  await driver.key('ArrowDown');
  await focusedLabel('Trace');
  await driver.key('ArrowDown');
  await focusedLabel('Archive');
  await driver.key('ArrowUp');
  await focusedLabel('Trace');
  await driver.key(' ', 'Space');
  await driver.element(submenuSelector);
  await focusedLabel('Activity');
  await driver.key('End');
  await focusedLabel('Settings');
  await driver.key('ArrowLeft');
  await focusedLabel('Trace');
  await driver.key('Enter');
  await driver.element(submenuSelector);
  await driver.escape();
  await focusedLabel('Trace');
  await driver.escape();
  assert(await driver.evaluate(selector => document.activeElement.matches(selector), headingSelector),
    'Closing the current-conversation menu did not return focus to its trigger.');
}

async function hostRemountAndViewport(driver) {
  await openMenu(driver);
  assert(await driver.evaluate(selector => document.querySelector(selector)?.dataset.tracePlacement === 'left', submenuSelector),
    'Trace did not open inward beside the right-aligned native menu.');
  await driver.evaluate(() => window.traceFixture.theme('dark'));
  await waitFor(() => driver.evaluate(selector => document.querySelector(selector)?.dataset.traceTheme === 'dark', submenuSelector),
    'The open Trace menu did not follow the host theme.');
  await driver.evaluate(() => {
    window.traceFixture.remountMenu();
    window.traceFixture.theme('light');
  });
  await driver.element(traceSelector, 'Trace');
  assert((await driver.elements(traceSelector, 'Trace')).length === 1, 'A remounted native menu has duplicate Trace rows.');
  assert(!(await driver.elements(submenuSelector)).length, 'An old Trace submenu survived a native menu remount.');
  await driver.escape();

  await driver.resize(320, 600);
  await openMenu(driver);
  assert(await driver.evaluate(selector => {
    const surface = document.querySelector(selector);
    const bounds = surface.getBoundingClientRect();
    return surface.dataset.tracePlacement === 'compact'
      && bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight;
  }, submenuSelector), 'The compact Trace panel clipped outside the viewport.');
  await driver.click(`${submenuSelector} ${traceSelector}`, 'Back');
  await waitFor(async () => !(await driver.elements(submenuSelector)).length, 'Back did not return to the native menu.');
  assert(await driver.evaluate(() => document.activeElement.textContent.trim() === 'Trace'), 'Back did not restore focus to Trace.');
  await driver.escape();
  await driver.resize(1280, 850);
}

async function hostStaleSelection(driver) {
  const tabsBefore = new Set((await chrome.tabs.query({})).map(({ id }) => id));
  const noticeSelector = '[data-trace-owned] [role="status"]';
  const staleNotice = 'The current chat or selected branch changed. Reopen Trace and select the action again.';
  const assertNoReview = async () => {
    const added = (await chrome.tabs.query({})).filter(tab => !tabsBefore.has(tab.id) && tab.url?.startsWith(releaseOrigin));
    assert(added.length === 0, 'A stale action opened a production-origin review.');
  };

  await openMenu(driver);
  await driver.evaluate(() => window.traceFixture.branch('alternate-reply'));
  await driver.click(`${submenuSelector} ${traceSelector}`, 'Save chat');
  await driver.element(noticeSelector, staleNotice);
  await assertNoReview();
  await driver.escape();
  await driver.evaluate(() => window.traceFixture.branch('reply-1'));

  await openMenu(driver);
  const moved = new URL(fixture.url);
  moved.pathname = moved.pathname.replace(/[^/]+$/, '98ff016f-a9bd-4431-9501-8b115a0bc613');
  await driver.evaluate(url => history.pushState({}, '', url), moved.href);
  await driver.click(`${submenuSelector} ${traceSelector}`, 'Prepare handoff');
  await driver.element(noticeSelector, staleNotice);
  await assertNoReview();
  await driver.escape();
  await driver.evaluate(url => history.replaceState({}, '', url), fixture.url);
}

async function fixtureChecks(theme, report) {
  const driver = await openFixture(theme);
  let stageTab;
  try {
    await driver.click(headingSelector);
    await driver.element(traceSelector, 'Trace');
    assert((await driver.elements(traceSelector, 'Trace')).length === 1, 'Expected just one Trace menu row.');
    for (const native of ['Pin', 'Rename', 'Share', 'Lock', 'Move to project', 'Archive', 'Delete']) {
      await driver.element(traceSelector, native);
    }
    await driver.click(traceSelector, 'Trace');
    await driver.element(submenuSelector);
    addScreenshot(`trace-menu-${theme}`, await driver.screenshot(), report);
    for (const label of ['Activity', 'Save chat', 'Export chat', 'Prepare handoff', 'Local library', 'Settings']) {
      await driver.element(`${submenuSelector} ${traceSelector}`, label);
    }
    await driver.click(`${submenuSelector} ${traceSelector}`, 'Activity');
    const empty = await driver.element(activitySelector);
    assert(/waiting|unavailable|not reported/i.test(empty.text), 'Activity invented a fact before observation.');
    await driver.escape();
    await waitFor(async () => !(await driver.elements(activitySelector)).length, 'Escape did not dismiss Activity.');
    assert(await driver.evaluate(selector => document.activeElement.matches(selector), headingSelector), 'Escape did not return focus to the conversation trigger.');
    await driver.fetchHistory();
    await openMenu(driver);
    await driver.click(`${submenuSelector} ${traceSelector}`, 'Activity');
    await waitFor(async () => /trace-fixture-resolved/.test((await driver.element(activitySelector)).text), 'Missing the resolved model.');
    const activity = await driver.element(activitySelector);
    assert(/30%/.test(activity.text) && /Output tokens\s*0/i.test(activity.text), 'Missing comparable context or genuine zero output.');
    addScreenshot(`trace-activity-${theme}`, await driver.screenshot(), report);
    await driver.escape();

    if (theme === 'light') {
      await hostKeyboard(driver);
      await hostRemountAndViewport(driver);
      await hostStaleSelection(driver);
      await openMenu(driver);
      const preexisting = new Set((await chrome.tabs.query({})).map(({ id }) => id));
      const stages = async () => (await chrome.tabs.query({})).filter(tab => !preexisting.has(tab.id) && tab.url?.startsWith(`${releaseOrigin}library.html#stage/`));
      await driver.evaluate((selector, label) => {
        const button = [...document.querySelectorAll(selector)].find(item => item.textContent.trim() === label);
        button?.click();
      }, `${submenuSelector} ${traceSelector}`, 'Save chat');
      await sleep(300);
      assert((await stages()).length === 0, 'A page-dispatched click created a review.');
      if (!(await driver.elements(submenuSelector)).length) {
        await driver.escape();
        await openMenu(driver);
      }
      await driver.click(`${submenuSelector} ${traceSelector}`, 'Save chat');
      stageTab = await waitFor(async () => (await stages())[0], 'A trusted Save chat click did not open a production-origin review.');
    }
    driver.assertNetwork();
    return { requests: driver.requestLog };
  } finally {
    if (stageTab) await chrome.tabs.remove(stageTab.id).catch(() => {});
    await driver.close();
  }
}

let manual;
let running = false;

function downloadReport(id, report) {
  const link = byId(id);
  if (link.href.startsWith('blob:')) URL.revokeObjectURL(link.href);
  link.href = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  link.hidden = false;
  link.click();
}

function busy(state) {
  for (const control of ['run', 'manual', 'benchmark']) byId(control).disabled = state;
}

byId('run').addEventListener('click', async () => {
  if (running || manual) return;
  running = true;
  busy(true);
  byId('report').hidden = true;
  results.replaceChildren();
  screenshots.replaceChildren();
  const report = { production: fixture.production, browser: navigator.userAgent, time: new Date().toISOString(), cases: [], screenshots: [] };
  try {
    for (const theme of ['light', 'dark']) {
      status.textContent = `Running ${theme} fixtures…`;
      const item = document.createElement('li');
      results.append(item);
      try {
        const evidence = await fixtureChecks(theme, report);
        report.cases.push({ theme, status: 'passed', ...evidence });
        item.textContent = `${theme} host fixture passed.`;
      } catch (error) {
        const detail = String(error.message || error);
        report.cases.push({ theme, status: 'failed', detail });
        item.textContent = `${theme} host fixture failed. ${detail}`;
      }
    }
  } finally {
    await chrome.tabs.update(controllerTab, { active: true });
    downloadReport('report', report);
    status.textContent = `${report.cases.filter(item => item.status === 'passed').length} of ${report.cases.length} fixture checks passed.`;
    running = false;
    busy(false);
  }
});

byId('manual').addEventListener('click', async () => {
  busy(true);
  try {
    manual = await openFixture('light');
    await manual.fetchHistory();
    byId('stop').disabled = false;
    byId('manual-capture-controls').hidden = false;
    status.textContent = 'Manual synthetic fixture is open. Return here and close it after the workflow.';
  } catch (error) {
    await manual?.close();
    manual = undefined;
    status.textContent = String(error.message || error);
    busy(false);
  }
});

byId('stop').addEventListener('click', async () => {
  try {
    manual?.assertNetwork();
    status.textContent = 'Manual session ended without unexpected fixture requests.';
  } catch (error) {
    status.textContent = String(error.message || error);
  } finally {
    await manual?.close();
    manual = undefined;
    byId('stop').disabled = true;
    byId('manual-capture-controls').hidden = true;
    busy(false);
  }
});

for (const [control, text] of [['capture-sample', 'Synthetic auto-capture checkpoint.'], ['revoked-sample', 'Synthetic saving-off checkpoint.']]) {
  byId(control).addEventListener('click', async () => {
    try {
      await manual.evaluate((id, text) => {
        if (document.querySelector(`[data-message-id="${id}"]`)) return;
        const thread = document.querySelector('#thread');
        const turn = document.createElement('article');
        turn.dataset.testid = `conversation-turn-${id}`;
        const message = document.createElement('div');
        message.dataset.messageId = id;
        message.dataset.messageAuthorRole = 'user';
        const content = document.createElement('p');
        content.dataset.messageContent = '';
        content.textContent = text;
        message.append(content);
        turn.append(message);
        thread.append(turn);
      }, control, text);
      status.textContent = `Added to the synthetic source. Search the local archive for “${text}” to verify the capture policy.`;
    } catch (error) {
      status.textContent = String(error.message || error);
    }
  });
}

byId('benchmark').addEventListener('click', async () => {
  if (running || manual) return;
  running = true;
  busy(true);
  const report = { production: fixture.production, browser: navigator.userAgent, time: new Date().toISOString(),
    metric: 'Input event to second animation frame. Renderer script time is reported separately.',
    fixtureTurns, virtualVisibleTurns: 24, runs: [] };
  try {
    for (const mode of ['legacy', 'virtualized']) {
      for (const baseline of [true, false, false, true]) {
        status.textContent = `Measuring ${mode} ${baseline ? 'baseline' : 'with Trace'}…`;
        const driver = await openFixture('light', baseline);
        try {
          await driver.click(headingSelector);
          if (baseline) {
            await sleep(150);
            assert(!(await driver.elements(traceSelector, 'Trace')).length, 'Trace unexpectedly ran on the baseline origin.');
          } else await driver.element(traceSelector, 'Trace');
          await driver.escape();
          const timings = await driver.performance(mode);
          driver.assertNetwork();
          report.runs.push({ mode, extension: !baseline, ...timings });
        } finally { await driver.close(); }
      }
    }
    status.textContent = 'All eight performance runs completed.';
  } catch (error) {
    report.error = String(error.message || error);
    status.textContent = `Benchmark incomplete. ${report.error}`;
  } finally {
    await chrome.tabs.update(controllerTab, { active: true });
    downloadReport('benchmark-report', report);
    busy(false);
    running = false;
  }
});

for (const theme of ['light', 'dark']) {
  byId(theme).addEventListener('click', async () => {
    try {
      await manual?.setTheme(theme);
      status.textContent = `The existing synthetic fixture now uses the ${theme} theme.`;
    } catch (error) {
      status.textContent = String(error.message || error);
    }
  });
}
