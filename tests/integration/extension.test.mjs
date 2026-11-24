import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { startTestBrowser, chatURL, chatMenuTrigger, eventually, fixtureId, openTraceMenu, openTracePage, secondFixtureId, traceItem } from './browser.mjs';
import { fixtureFetch, hiddenText, history, historyPath, toolText } from './data.mjs';
import { addSavedNote, archiveRequest, checkDefaultConsent, checkSelectionPreview, expectedDecision, findFixture, saveFixture } from './workflows.mjs';

async function withBrowser(t, options) {
  const browser = await startTestBrowser(options);
  t.after(async () => {
    try {
      browser.assertNetwork();
      assert.deepEqual(browser.pageErrors, [], 'The browser reported an uncaught fixture or extension-page error.');
    } finally { await browser.close(); }
  });
  t.diagnostic(`Chromium ${browser.browserVersion}, ${browser.extensionOrigin}`);
  return browser;
}

test('the unpacked extension mounts only the current-chat menu and preserves native keyboard actions', async t => {
  const browser = await withBrowser(t);
  const page = await browser.context.newPage();
  await page.goto(chatURL());
  const trigger = chatMenuTrigger(page);
  const otherTriggers = page.getByRole('button', { name: 'Chat actions', exact: true });
  assert.ok(await otherTriggers.count() >= 2, 'The fixture must exercise at least one unrelated Chat actions trigger.');
  const sidebarTrigger = page.getByRole('complementary').getByRole('button', { name: 'Chat actions', exact: true }).first();
  await sidebarTrigger.click();
  assert.equal(await traceItem(page).count(), 0);
  await page.keyboard.press('Escape');
  await trigger.focus();
  await page.keyboard.press('Enter');
  const nativeMenu = page.getByRole('menu', { name: 'Chat actions', exact: true });
  await nativeMenu.waitFor();
  for (const label of ['Pin', 'Rename', 'Share', 'Lock', 'Move to project', 'Archive', 'Delete']) {
    const name = label === 'Archive' ? /^Archive\b/ : label;
    await nativeMenu.getByRole('menuitem', { name, exact: true }).waitFor();
  }
  await traceItem(page).waitFor();
  assert.equal(await traceItem(page).count(), 1);
  const order = await nativeMenu.getByRole('menuitem').evaluateAll(rows => rows.map(row => {
    const copy = row.cloneNode(true);
    copy.querySelectorAll('[aria-hidden="true"],[hidden]').forEach(child => child.remove());
    return (row.getAttribute('aria-label') || copy.textContent).replace(/\s+/g, ' ').trim();
  }));
  const orderedLabels = ['Move to project', 'Trace', 'Archive', 'Delete'];
  const positions = orderedLabels.map(label => order.indexOf(label));
  assert.ok(positions.every((index, i) => index >= 0 && (i === 0 || index > positions[i - 1])), order.join(' | '));
  await traceItem(page).focus();
  await page.keyboard.press('ArrowRight');
  const actions = page.getByRole('menu', { name: 'Trace actions', exact: true });
  await actions.waitFor();
  assert.deepEqual((await actions.getByRole('menuitem').allTextContents()).map(value => value.trim()),
    ['Activity', 'Save chat', 'Export chat', 'Prepare handoff', 'Local library', 'Settings']);
  await page.keyboard.press('Escape');
  await actions.waitFor({ state: 'hidden' });
  assert.ok(await traceItem(page).evaluate(element => document.activeElement === element));
  await page.keyboard.press('Escape');
  await nativeMenu.waitFor({ state: 'hidden' });
  assert.ok(await trigger.evaluate(element => document.activeElement === element));
  for (let iteration = 0; iteration < 3; iteration++) {
    await trigger.click();
    await traceItem(page).waitFor();
    assert.equal(await traceItem(page).count(), 1);
    await page.keyboard.press('Escape');
    await traceItem(page).waitFor({ state: 'hidden' });
  }
});

test('Activity shows the resolved reply facts, preserves zero, and never replays a host call', async t => {
  const browser = await withBrowser(t);
  const page = await browser.context.newPage();
  await page.goto(chatURL());
  let menu = await openTraceMenu(page);
  await page.evaluate(() => window.traceFixture.deferNativeClose(120));
  await menu.getByRole('menuitem', { name: 'Activity', exact: true }).click();
  let activity = page.getByRole('dialog', { name: 'Activity', exact: true });
  await activity.waitFor();
  assert.match(await activity.innerText(), /waiting|unavailable|not reported/i);
  await page.waitForTimeout(400);
  assert.ok(await activity.getByRole('button', { name: 'Close Activity', exact: true })
    .evaluate(element => document.activeElement === element));
  await page.keyboard.press('Escape');
  await activity.waitFor({ state: 'hidden' });

  await fixtureFetch(browser, page, historyPath(fixtureId), history(fixtureId));
  menu = await openTraceMenu(page);
  await menu.getByRole('menuitem', { name: 'Activity', exact: true }).click();
  activity = page.getByRole('dialog', { name: 'Activity', exact: true });
  await activity.waitFor();
  await eventually(async () => {
    const text = await activity.innerText();
    assert.match(text, /trace-fixture-resolved/);
    assert.match(text, /1[,.]?200/);
    assert.match(text, /(?:output(?: tokens)?\s*0|\b0\b\s*output)/i);
    assert.match(text, /30\s*%/);
    assert.doesNotMatch(text, /trace-fixture-generic|trace-fixture-tool/);
  });
  await page.keyboard.press('Escape');
  const calls = browser.requests.filter(request => request.includes('/backend-api/'));
  assert.deepEqual(calls, [`GET https://chatgpt.com${historyPath(fixtureId)}`]);
});

test('a synthetic page click cannot create an explicit stage while a genuine click opens a review', async t => {
  const browser = await withBrowser(t);
  const page = await browser.context.newPage();
  await page.goto(chatURL());
  const menu = await openTraceMenu(page);
  const save = menu.getByRole('menuitem', { name: 'Save chat', exact: true });
  const count = browser.context.pages().length;
  await save.evaluate(element => element.click());
  await page.waitForTimeout(250);
  assert.equal(browser.context.pages().length, count, 'A page-dispatched click must not confer a save intent.');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  const destination = await openTracePage(browser, page, 'Save chat');
  await destination.getByRole('heading', { name: 'Save chat', exact: true }).waitFor();
  assert.match(await destination.locator('body').innerText(), /coverage|partial|unknown/i);
  await destination.getByLabel('New collection name').fill('Local fixture');
  await destination.getByRole('button', { name: 'Create collection', exact: true }).click();
  await destination.getByText(/Transcript retention.*90 days/).waitFor();
  assert.match(await destination.locator('body').innerText(), /90.days|retention/i);
});

test('two ordinary conversation tabs isolate their menus; the toolbar recovers after profile restart', async t => {
  const browser = await withBrowser(t);
  const first = await browser.context.newPage();
  const second = await browser.context.newPage();
  await Promise.all([first.goto(chatURL()), second.goto(chatURL(secondFixtureId))]);
  for (const page of [first, second]) {
    await chatMenuTrigger(page).click();
    await traceItem(page).waitFor();
    assert.equal(await traceItem(page).count(), 1);
  }
  const mainMenu = first.getByRole('menu', { name: 'Chat actions', exact: true });
  assert.equal(await mainMenu.count(), 1);
  await second.reload();
  assert.equal(await traceItem(second).count(), 0);
  await chatMenuTrigger(second).click();
  await traceItem(second).waitFor();

  await browser.restart();
  const popup = await browser.context.newPage();
  await popup.setViewportSize({ width: 330, height: 580 });
  await popup.goto(browser.extensionUrl('popup.html'));
  await popup.getByRole('button', { name: /local library/i }).waitFor();
  assert.match(await popup.locator('body').innerText(), /open a ChatGPT conversation|unavailable/i);
});

test('consent stays off through one-time save, phrase search, notes, handoff, export, delete, and restore', async t => {
  const browser = await withBrowser(t);
  const settings = await browser.context.newPage();
  await settings.goto(browser.extensionUrl('library.html#settings'));
  await checkDefaultConsent(settings);
  const source = await browser.context.newPage();
  await source.goto(chatURL());
  await fixtureFetch(browser, source, historyPath(fixtureId), history(fixtureId));
  await checkDefaultConsent(settings);

  const library = await saveFixture(browser, source);
  const reader = await findFixture(library);
  assert.match(await reader.innerText(), expectedDecision);
  const note = await addSavedNote(library, reader);
  assert.ok(!(await source.locator('body').innerText()).includes(note), 'Private notes must remain on the extension origin.');
  await checkDefaultConsent(settings, false);

  await reader.getByRole('button', { name: 'Prepare handoff', exact: true }).click();
  const goal = library.getByRole('textbox', { name: 'Goal', exact: true });
  assert.equal(await goal.inputValue(), '', 'A handoff must start with user-authored notes blank.');
  await goal.fill('Test startup latency for three trim packages.');
  await library.getByRole('spinbutton', { name: 'Size budget (characters)' }).fill('100');
  await library.getByText(/Over budget/).waitFor();
  const preview = await checkSelectionPreview(library, /Test startup latency for three trim packages\./);
  assert.match(await preview.inputValue(), expectedDecision);
  await library.getByRole('button', { name: 'Save draft', exact: true }).click();
  await library.getByText('Draft saved.', { exact: true }).waitFor();
  await reader.getByRole('button', { name: 'Close handoff', exact: true }).click();

  await reader.getByRole('button', { name: 'Export chat', exact: true }).click();
  const exportDialog = library.getByRole('dialog', { name: 'Export chat', exact: true });
  const exportPreview = await checkSelectionPreview(exportDialog, /ルーフ|café/);
  const markdown = await exportPreview.inputValue();
  assert.match(markdown, /\n {2}const roof = trim\.top;/);
  assert.ok(!(markdown.includes(hiddenText) || markdown.includes(toolText) || markdown.includes(note)));
  await exportDialog.getByRole('combobox', { name: 'Format', exact: true }).selectOption('json');
  const downloaded = library.waitForEvent('download');
  await exportDialog.getByRole('button', { name: 'Download JSON', exact: true }).click();
  const download = await downloaded;
  const envelope = await readFile(await download.path());
  assert.equal(JSON.parse(envelope).kind, 'conversation');
  assert.ok(!envelope.toString().includes(note));
  await library.keyboard.press('Escape');
  await exportDialog.waitFor({ state: 'hidden' });

  await reader.getByRole('button', { name: 'Delete local copy', exact: true }).click();
  await library.getByRole('dialog', { name: 'Delete local copy?', exact: true })
    .getByRole('button', { name: 'Delete local copy', exact: true }).click();
  await library.getByText('No matching results.', { exact: true }).waitFor();
  await checkDefaultConsent(settings);

  await library.goto(browser.extensionUrl('library.html#restore'));
  const upload = library.getByLabel('Trace JSON file', { exact: true });
  await upload.setInputFiles({ name: 'unknown-version.json', mimeType: 'application/json', buffer: Buffer.from('{"format":"trace","version":999}') });
  await library.getByRole('alert').waitFor();
  await checkDefaultConsent(settings);
  await upload.setInputFiles({ name: 'synthetic-chat.json', mimeType: 'application/json', buffer: envelope });
  await library.getByRole('heading', { name: 'Restore preview' }).waitFor();
  await library.getByRole('button', { name: 'Restore Trace data', exact: true }).click();
  await library.getByText(/Restore complete/).first().waitFor();
  await checkDefaultConsent(settings, false);
  await browser.restart();
  const restored = await browser.context.newPage();
  await restored.goto(browser.extensionUrl('library.html#library'));
  const collections = restored.getByRole('combobox', { name: 'Collection', exact: true });
  await collections.locator('option', { hasText: 'All collections' }).waitFor({ state: 'attached' });
  await collections.selectOption({ label: 'All collections' });
  assert.match(await (await findFixture(restored)).innerText(), expectedDecision);
  await checkDefaultConsent(restored, false);
});

test('an already reviewed save is fenced when its source navigates to another conversation', async t => {
  const browser = await withBrowser(t);
  const source = await browser.context.newPage();
  await source.goto(chatURL());
  const review = await openTracePage(browser, source, 'Save chat');
  await review.getByRole('heading', { name: 'Save chat', exact: true }).waitFor();
  await review.getByLabel('New collection name').fill('Stale selection fixture');
  await review.getByRole('button', { name: 'Create collection', exact: true }).click();
  await review.getByText(/Transcript retention/).waitFor();
  await source.evaluate(path => history.pushState({}, '', path), new URL(chatURL(secondFixtureId)).pathname);
  await review.getByRole('button', { name: 'Save chat', exact: true }).click();
  const error = review.getByRole('alert');
  await error.waitFor();
  assert.match(await error.innerText(), /selection|scope|reopen|source chat/i);
  await checkDefaultConsent(review);
});

test('binding an opted-in ordinary fixture captures supported history; turning it off preserves the prior copy', async t => {
  const browser = await withBrowser(t);
  const source = await browser.context.newPage();
  await source.goto(chatURL());
  const settings = await openTracePage(browser, source, 'Settings');
  await settings.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  await settings.getByLabel('New collection name').fill('Automatic capture fixture');
  await settings.getByRole('button', { name: 'Create collection', exact: true }).click();
  const toggle = settings.getByRole('switch', { name: 'Save chats I open', exact: true });
  await toggle.check();
  await settings.getByRole('button', { name: 'Enable saving', exact: true }).click();
  await settings.getByText(/Automatic saving enabled/).waitFor();
  assert.equal((await archiveRequest(settings, 'getSettings', [])).autoCapture, true);
  await fixtureFetch(browser, source, historyPath(fixtureId), history(fixtureId));
  const conversations = () => archiveRequest(settings, 'listConversations', []);
  const read = async () => archiveRequest(settings, 'getConversation', [(await conversations())[0].id]);
  await eventually(async () => {
    const saved = await read();
    assert.match(saved.messages.map(message => message.text).join('\n'), expectedDecision);
    assert.ok(saved.messages.every(message => message.text !== hiddenText && message.text !== toolText));
  });

  await toggle.uncheck();
  await settings.getByText(/Saving off\. Existing local copies/).waitFor();
  const before = (await read()).messages.map(message => message.id);
  await fixtureFetch(browser, source, historyPath(fixtureId), history(fixtureId, { regenerated: true }));
  await source.evaluate(() => window.traceFixture.branch('revoked-regeneration'));
  await source.waitForTimeout(450);
  assert.deepEqual((await read()).messages.map(message => message.id), before);
  await checkDefaultConsent(settings, false);
});
