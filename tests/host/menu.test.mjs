import assert from 'node:assert/strict';
import test from 'node:test';
import { chatMenuTrigger, chatURL, eventually, openTraceMenu, secondFixtureId, startTestBrowser, traceItem } from '../integration/browser.mjs';

async function fixture(t, options) {
  const browser = await startTestBrowser(options);
  t.after(async () => {
    try {
      browser.assertNetwork();
      assert.deepEqual(browser.pageErrors, []);
    } finally {
      await browser.close();
    }
  });
  const page = await browser.context.newPage();
  await page.goto(chatURL());
  return { browser, page, trigger: chatMenuTrigger(page), row: traceItem(page) };
}

async function focused(locator) {
  await eventually(async () => assert.ok(await locator.evaluate((node) => document.activeElement === node)));
}

test('UI-02 traverses the native menu and Trace via keyboard, retaining native submenu and typeahead', async (t) => {
  const { page, trigger, row } = await fixture(t);
  await trigger.focus();
  await page.keyboard.press('ArrowDown');
  await row.waitFor();
  const root = page.getByRole('menu', { name: 'Chat actions', exact: true });
  await focused(root.getByRole('menuitem', { name: 'Pin', exact: true }));
  await page.keyboard.press('m');
  const move = root.getByRole('menuitem', { name: 'Move to project', exact: true });
  await focused(move);
  await page.keyboard.press('ArrowRight');
  const projects = page.getByRole('menu', { name: 'Move to project', exact: true });
  await projects.waitFor();
  await focused(projects.getByRole('menuitem', { name: 'Miata', exact: true }));
  await page.keyboard.press('ArrowDown');
  await focused(projects.getByRole('menuitem', { name: 'Transit', exact: true }));
  await page.keyboard.press('Escape');
  await projects.waitFor({ state: 'hidden' });
  await focused(move);
  await page.keyboard.press('ArrowDown');
  await focused(row);
  await page.keyboard.press('ArrowDown');
  await focused(root.getByRole('menuitem', { name: 'Archive', exact: true }));
  await page.keyboard.press('ArrowUp');
  await focused(row);
  await page.keyboard.press('Space');
  const menu = page.getByRole('menu', { name: 'Trace actions', exact: true });
  await menu.waitFor();
  await focused(menu.getByRole('menuitem', { name: 'Activity', exact: true }));
  await page.keyboard.press('End');
  await focused(menu.getByRole('menuitem', { name: 'Settings', exact: true }));
  await page.keyboard.press('ArrowLeft');
  await menu.waitFor({ state: 'hidden' });
  await focused(row);
  await page.keyboard.press('Enter');
  await menu.waitFor();
  await page.keyboard.press('Enter');
  const panel = page.getByRole('dialog', { name: 'Activity', exact: true });
  await panel.waitFor();
  await root.waitFor({ state: 'hidden' });
  await focused(panel.getByRole('button', { name: 'Close Activity' }));
  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'hidden' });
  await focused(trigger);
});

test('UI-01 flips inward, updates theme in place and stays accessible at narrow widths', async (t) => {
  const { page, trigger, row } = await fixture(t);
  const actions = await openTraceMenu(page);
  assert.equal(await actions.getAttribute('data-trace-placement'), 'left');
  const wideRoot = await page.locator('#header-menu').boundingBox();
  const wide = await actions.boundingBox();
  assert.ok(wide.x + wide.width < wideRoot.x);
  await page.evaluate(() => window.traceFixture.theme('dark'));
  await eventually(async () => assert.equal(await actions.getAttribute('data-trace-theme'), 'dark'));
  await page.evaluate(() => window.traceFixture.remountMenu());
  await actions.waitFor({ state: 'hidden' });
  await row.waitFor();
  assert.equal(await row.count(), 1);
  await page.keyboard.press('Escape');
  await focused(trigger);

  await page.setViewportSize({ width: 320, height: 600 });
  const compact = await openTraceMenu(page);
  assert.equal(await compact.getAttribute('data-trace-placement'), 'compact');
  const bounds = await compact.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 320 && bounds.y + bounds.height <= 600);
  const back = compact.getByRole('menuitem', { name: 'Back', exact: true });
  await back.click();
  await compact.waitFor({ state: 'hidden' });
  await focused(row);
});

test('stale menu actions reject navigation and branch changes before the trusted selection', async (t) => {
  const { browser, page } = await fixture(t);
  const initialCount = browser.context.pages().length;
  let actions = await openTraceMenu(page);
  await page.evaluate((url) => history.pushState({}, '', url), chatURL(secondFixtureId));
  await actions.getByRole('menuitem', { name: 'Save chat', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'selected branch changed' }).waitFor();
  assert.equal(browser.context.pages().length, initialCount);
  await page.keyboard.press('Escape');

  actions = await openTraceMenu(page);
  await page.evaluate(() => window.traceFixture.branch('reply-alt'));
  await eventually(async () => assert.equal(await page.locator('[data-message-author-role=assistant]').getAttribute('data-message-id'), 'reply-alt'));
  await actions.getByRole('menuitem', { name: 'Prepare handoff', exact: true }).click();
  await actions.waitFor({ state: 'hidden' });
  assert.equal(browser.context.pages().length, initialCount);
});
