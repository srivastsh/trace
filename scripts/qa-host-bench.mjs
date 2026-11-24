import assert from 'node:assert/strict';
import { arch, cpus, platform, release } from 'node:os';
import { chatURL, startTestBrowser } from '../tests/integration/browser.mjs';
import { eventsPerRun as samples, fixtureTurns as turns, seedWorkload, summarize } from '../tests/integration/host-workload.mjs';

const outputs = [];
for (const mode of ['legacy', 'virtualized']) {
  for (const extension of [false, true, true, false]) {
    const browser = await startTestBrowser({ extension });
    try {
      const page = await browser.context.newPage();
      await page.goto(chatURL());
      await page.evaluate(seedWorkload, { turns, mode });
      // Let the host and extension finish their one-time mounted DOM work.
      await page.waitForTimeout(300);
      const cdp = await browser.context.newCDPSession(page);
      await cdp.send('Performance.enable');
      const readScriptDuration = async () => (await cdp.send('Performance.getMetrics')).metrics
        .find(metric => metric.name === 'ScriptDuration').value;
      const before = await readScriptDuration();
      for (let index = 0; index < samples; index++) {
        await page.keyboard.insertText('a');
        await page.waitForFunction(count => window.tracePerformance.input.length >= count, index + 1);
      }
      await page.mouse.move(840, 335);
      for (let index = 0; index < samples; index++) {
        await page.mouse.wheel(0, index % 2 ? -360 : 360);
        await page.waitForFunction(count => window.tracePerformance.wheel.length >= count, index + 1);
      }
      const totalScriptMs = (await readScriptDuration() - before) * 1000;
      const { input, wheel } = await page.evaluate(() => window.tracePerformance);
      assert.ok(input.length >= samples && wheel.length >= samples);
      browser.assertNetwork();
      outputs.push({ mode, extension, browser: browser.browserVersion, typing: summarize(input), scroll: summarize(wheel), totalScriptMs: Number(totalScriptMs.toFixed(2)) });
    } finally { await browser.close(); }
  }
}

console.log(JSON.stringify({
  metric: 'Browser input or wheel event through two animation frames, with renderer script time shown separately',
  machine: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, node: process.version },
  fixtureTurns: turns, virtualVisibleTurns: 24, runs: outputs,
}, null, 2));
