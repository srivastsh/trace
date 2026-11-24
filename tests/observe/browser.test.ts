import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import ts from 'typescript';
import { expect, test } from 'vitest';

const origin = 'https://chatgpt.com';
const enableBrowser = process.env.TRACE_OBSERVER_BROWSER === '1';
const fixture = `<!doctype html><html><head><style>
  .gone { display: none } .unseen { visibility: hidden } .opacity { opacity: 0 }
</style><title>Synthetic fixture</title></head><body>
  <main>
    <div data-message-author-role="user">Same prompt</div>
    <div data-message-author-role="user">Same prompt</div>
    <div class="gone"><div data-message-author-role="assistant" data-message-id="hidden-turn">ancestor hidden content</div></div>
    <div data-message-author-role="assistant" data-message-id="answer">
      <div class="markdown"><p>First visible paragraph <span class="unseen">hidden inline content</span></p></div>
      <div class="markdown"><p>Second visible paragraph <a href="/safe?q=car">Read more</a></p>
        <pre><code class="language-js">  const roof = trim.top;
<span class="gone">code hidden content</span>  const check = "屋根";</code></pre>
        <div class="opacity">fully transparent content</div>
      </div>
      <span data-message-author-role="tool">tool transcript content</span>
      <span data-message-channel="analysis">private reasoning content</span>
    </div>
    <div class="gone" data-message-author-role="assistant" data-message-id="hidden-tail">hidden last turn</div>
    <textarea id="prompt-textarea"></textarea>
  </main>
</body></html>`;

test.skipIf(!enableBrowser)('isolated DOM captures all visible blocks and code and fences consent by epoch', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const requests: string[] = [];
    await context.route('**/*', async route => {
      const request = route.request().url();
      requests.push(request);
      const url = new URL(request);
      if (url.origin !== origin) { await route.abort(); return; }
      if (url.pathname === '/c/synthetic' || url.pathname === '/c/second') {
        await route.fulfill({ contentType: 'text/html', body: fixture });
        return;
      }
      const match = url.pathname.match(/^\/observer-fixture\/(client|dom|validate|protocol)(?:\.js)?$/);
      if (!match) { await route.abort(); return; }
      const source = await readFile(new URL(`../../src/observe/${match[1]}.ts`, import.meta.url), 'utf8');
      const script = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
      await route.fulfill({ contentType: 'text/javascript', body: script.outputText });
    });
    const page = await context.newPage();
    await page.goto(origin + '/c/synthetic');
    await page.evaluate(async () => {
      const { createObserver } = await import('/observer-fixture/client.js');
      const state = { saves: [] as unknown[] };
      const observer = createObserver({
        onActivity() {}, onScope() {}, onCapture(projection: unknown) { state.saves.push(projection); }, onDiagnostic() {},
      });
      Object.assign(window, { observerFixture: { state, observer } });
    });
    const projected = await page.evaluate(() => {
      const { observer } = (window as any).observerFixture;
      const scope = observer.scope();
      const snapshot = observer.snapshot(scope);
      observer.setCapture({ epoch: scope.epoch, generation: 1 });
      return { scope, snapshot };
    });
    expect(projected.scope).toMatchObject({ temporary: 'unknown', selectionId: 'dom:answer' });
    expect(projected.snapshot.messages).toHaveLength(3);
    expect(projected.snapshot.messages[0].id).not.toBe(projected.snapshot.messages[1].id);
    const captured = projected.snapshot.messages[2].text;
    expect(captured).toContain('First visible paragraph');
    expect(captured).toContain('Second visible paragraph');
    expect(captured).toContain('[Read more](https://chatgpt.com/safe?q=car)');
    expect(captured).toContain('  const roof = trim.top;\n  const check = "屋根";');
    expect(captured).not.toMatch(/hidden|transparent|transcript content|private reasoning/);
    await page.waitForTimeout(180);
    expect(await page.evaluate(() => (window as any).observerFixture.state.saves.length)).toBe(0);
    await page.evaluate(() => {
      const { observer } = (window as any).observerFixture;
      observer.setCapture({ epoch: observer.scope().epoch, generation: 2, confirmedOrdinary: true });
    });
    await expect.poll(() => page.evaluate(() => (window as any).observerFixture.state.saves.length)).toBe(1);
    await page.evaluate(() => {
      const { observer } = (window as any).observerFixture;
      const expected = observer.scope();
      history.pushState({}, '', '/c/second');
      observer.setCapture({ epoch: expected.epoch, generation: 2, confirmedOrdinary: true });
      if (observer.scope().epoch === expected.epoch) throw new Error('Navigation did not invalidate the epoch');
      try { observer.snapshot(expected); }
      catch { return; }
      throw new Error('A stale selection produced a snapshot');
    });
    await page.evaluate(() => {
      const { observer } = (window as any).observerFixture;
      document.body.dataset.temporaryChat = 'true';
      observer.setCapture({ epoch: observer.scope().epoch, generation: 3, confirmedOrdinary: true });
    });
    await page.waitForTimeout(1100);
    expect(await page.evaluate(() => (window as any).observerFixture.state.saves.length)).toBe(1);
    expect(requests.every(url => url.startsWith(origin))).toBe(true);
    await page.evaluate(() => (window as any).observerFixture.observer.destroy());
  } finally { await browser.close(); }
}, 10_000);
