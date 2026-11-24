import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chatURL, eventually, fixtureId, openTraceMenu, openTracePage, project, startTestBrowser } from '../integration/browser.mjs';
import { fixtureFetch, history, historyPath } from '../integration/data.mjs';
import { addSavedNote, findFixture, saveFixture } from '../integration/workflows.mjs';

const target = resolve(process.argv[2] ?? join(project, 'test-results/screenshots'));
await mkdir(target, { recursive: true });

for (const theme of ['light', 'dark']) {
  const browser = await startTestBrowser({ colorScheme: theme });
  const capture = (page, name) => page.screenshot({ path: join(target, `trace-${name}-${theme}.png`), animations: 'disabled' });
  try {
    const source = await browser.context.newPage();
    await source.goto(chatURL());
    await fixtureFetch(browser, source, historyPath(fixtureId), history(fixtureId));
    const menu = await openTraceMenu(source);
    await capture(source, 'menu');
    await menu.getByRole('menuitem', { name: 'Activity', exact: true }).click();
    const activity = source.getByRole('dialog', { name: 'Activity', exact: true });
    await activity.getByText('trace-fixture-resolved', { exact: true }).waitFor();
    await capture(source, 'activity');
    await source.keyboard.press('Escape');

    const library = await saveFixture(browser, source);
    const reader = await findFixture(library);
    await addSavedNote(library, reader);
    await capture(library, 'library');

    const handoff = await openTracePage(browser, source, 'Prepare handoff');
    await handoff.getByRole('heading', { name: 'Prepare handoff', exact: true }).waitFor();
    await handoff.getByLabel('Template', { exact: true }).selectOption({ label: 'Codex build' });
    await handoff.getByLabel('Goal', { exact: true }).fill('Verify startup latency across all three trim packages.');
    await handoff.getByLabel('Current state', { exact: true }).fill('The 3D viewer uses static preview assets and can switch trims.');
    await handoff.getByLabel('Decisions', { exact: true }).fill('Keep asset decoding off the rendering thread.');
    await handoff.getByText(/^Assistant · Miata Viewer/).click();
    await capture(handoff, 'handoff');
    browser.assertNetwork();
    await eventually(() => {
      if (browser.pageErrors.length) throw Error(browser.pageErrors.join('\n'));
    });
  } finally { await browser.close(); }
}

console.log(target);
