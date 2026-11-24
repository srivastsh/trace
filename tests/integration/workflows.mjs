import assert from 'node:assert/strict';
import { chatURL, eventually, openTracePage } from './browser.mjs';
import { decision, projectTitle } from './data.mjs';

export async function archiveRequest(page, op, args) {
  return page.evaluate(async ({ op, args }) => {
    const response = await chrome.runtime.sendMessage({ v: 1, op, args });
    if (!response?.ok) throw Error(response?.error || 'Archive request failed.');
    return response.data;
  }, { op, args });
}

export async function saveFixture(browser, source, collectionName = 'Synthetic viewer notes') {
  await source.goto(chatURL());
  const review = await openTracePage(browser, source, 'Save chat');
  await review.getByRole('heading', { name: 'Save chat', exact: true }).waitFor();
  await review.getByLabel('New collection name').fill(collectionName);
  await review.getByRole('button', { name: 'Create collection', exact: true }).click();
  await review.getByText(/Transcript retention.*90 days/).waitFor();
  await review.getByRole('button', { name: 'Save chat', exact: true }).click();
  await review.getByText('Chat saved.', { exact: true }).waitFor();
  await review.getByRole('link', { name: 'Open Local library', exact: true }).click();
  await review.getByRole('heading', { name: 'Local library', exact: true }).waitFor();
  return review;
}

export async function findFixture(library, query = '"asset decoding"') {
  await library.getByRole('searchbox', { name: 'Search saved chats', exact: true }).fill(query);
  const results = library.getByRole('list', { name: 'Search results', exact: true });
  const row = results.getByRole('button', { name: new RegExp(projectTitle) });
  await row.waitFor();
  await row.click();
  await library.getByRole('heading', { name: projectTitle, exact: true }).waitFor();
  return library.getByRole('region', { name: 'Saved copy', exact: true });
}

export async function addSavedNote(library, reader) {
  await reader.getByRole('article', { name: 'Assistant message', exact: true })
    .getByRole('button', { name: 'Save message', exact: true }).click();
  const noteDialog = library.getByRole('dialog', { name: 'Save message', exact: true });
  await noteDialog.getByLabel('Label', { exact: true }).fill('Decode on a worker');
  await noteDialog.getByLabel('Tags (comma separated)').fill('performance, renderer');
  const note = 'Recheck transfer costs with a low-memory device.';
  await noteDialog.getByLabel('Private note', { exact: true }).fill(note);
  await noteDialog.getByRole('button', { name: 'Save message', exact: true }).click();
  await noteDialog.waitFor({ state: 'hidden' });
  await library.getByText(note, { exact: true }).waitFor();
  return note;
}

export async function checkDefaultConsent(library, expectEmpty = true) {
  assert.equal((await archiveRequest(library, 'getSettings', [])).autoCapture, false);
  if (expectEmpty) assert.deepEqual(await archiveRequest(library, 'listConversations', []), []);
}

export async function checkSelectionPreview(page, expected) {
  const disclosure = page.getByText('Document preview', { exact: true });
  if (await disclosure.count()) await disclosure.click();
  const preview = page.getByRole('textbox', { name: 'Document preview', exact: true });
  await eventually(async () => assert.match(await preview.inputValue(), expected));
  return preview;
}

export const expectedDecision = new RegExp(decision.replace(/\.$/, '\\.'));
