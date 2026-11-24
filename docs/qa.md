# Trace verification

The release tests use a synthetic Miata Viewer conversation. They load the real unpacked MV3 build, feed synthetic responses to the browser, and use the normal menu and archive surfaces. The browser diagnostics and screenshots contain fixture material only.

## Commands

| Check | Command |
| --- | --- |
| TypeScript and unit tests | `npm run check && npm test` |
| Compile the release | `npm run build` |
| Inspect packaged files, permissions, CSP and ID | `node --test tests/integration/packaged.test.mjs` |
| Download the Playwright browser if missing | `npx playwright install chromium` |
| Real unpacked Playwright extension tests | `npm run qa` |
| Light and dark menu, Activity, library and handoff screenshots | `node tests/visual/screenshots.mjs` |
| Browser latency with 1,200 host fixture turns | `node scripts/qa-host-bench.mjs` |
| Standalone search timing with 50,000 fixture messages | `node --experimental-strip-types scripts/qa-search-bench.mjs` |
| Prepare the independent native QA fixture extension | `node scripts/qa-native.mjs` |
| Extract screenshots from a downloaded native report | `node scripts/qa-extract-native.mjs /path/to/trace-isolated-browser-report.json` |

Run these from the source root. The Playwright harness creates disposable profiles. HTTP requests outside the allowlisted fixture documents and explicitly expected synthetic API responses fail the test. The same applies to WebSocket attempts. DNS resolution is disabled for the fixture browser process. The package audit separately checks that the extension origin denies outbound connections, accepts no external extension messaging, and grants only storage and alarms.

## Native isolated run

In a separate signed-out Chromium profile, load the unchanged `dist/` and then load the independent runner directory printed by `qa-native.mjs`. Open the runner’s **Details**, click **Extension options**, and run **Run browser checks**. The runner uses the browser’s debugger API only for fixture tabs it creates, supplies all synthetic host responses locally, closes those tabs, and provides a JSON report with PNG screenshots. Its permissions and files are absent from `dist/`. Keep the runner in the isolated profile.

For the manual workflow in that same profile, use **Open fixture for manual workflows** while the runner tab stays open. In the fixture, open **Trace**, then **Save chat**. Create a synthetic collection, review retention and coverage, and confirm the one-time save with automatic capture off. Open **Local library** and search `"asset decoding"`. Open the result, save a message and private note, and prepare a handoff with a synthetic project goal. Use **Export chat** and **Import Trace backup** to exercise a versioned JSON round trip. Use **Close manual fixture** when finished. Changes should be confined to the isolated profile’s synthetic archive.

The runner can switch the existing fixture between light and dark. To verify automatic capture separately, enable it from Trace Settings on the synthetic source and bind a manual fixture collection. Use **Add capture checkpoint**, then search for `"Synthetic auto-capture checkpoint"`. Turn saving off, use **Add saving-off checkpoint**, and confirm the second phrase does not appear. The benchmark button runs the same 1,200-turn workload on a synthetic origin covered by the release and another synthetic origin outside its content-script matches. It writes separate typing, scrolling, and renderer script-time measurements.

## Acceptance evidence

| Area | Evidence source | Scope |
| --- | --- | --- |
| Manifest, public key, CSP, allowed origins, bundled assets | Packaged Node audit | Checks actual built assets |
| Parser, stream bounds, scope and capture rules, archival transactions, search and export | Vitest | Controlled input, including absent and genuine zero fields |
| Menu, theme, focus, Activity, trusted action routing, fixture network | Native fixture runner and Playwright | Synthetic HTML and API responses in a real Chromium extension context |
| Consent off, one-time Save, phrase search, saved note, handoff, export, delete, restore and restart | Playwright and native manual workflow | Synthetic archive in a disposable or signed-out profile |
| Menu, Activity, library and handoff appearance | Playwright screenshots or native screen evidence | Synthetic data at desktop viewport, light and dark |
| Warm lexical search | Standalone benchmark | In-memory implementation, excluding browser worker hydration and UI debounce |
| Composer and scroll latency | Browser benchmark | Input through two animation frames and renderer script time, legacy and virtualized host |
| Dia install and host compatibility | Native smoke check after release validation | Actual native menu, extension ID and state, and fresh capture default |

## Local environment limits

The corrected build passed the packaged audit and both native fixture themes, including exact menu order and focus after delayed menu dismissal. The Playwright 1.58.2 cache lacked its Chromium executable, and the download failed DNS resolution. Attempts to launch installed Chrome and Edge Dev in disposable profiles from the shell ended with `SIGABRT` before the browser connected. The native fixture screenshots and their build fingerprints are available in [release evidence](evidence/README.md).

The Dia smoke test separately observed the corrected native menu order, keyboard and Activity focus, Settings, and Local library. Live Activity displayed a reported model with token counts unavailable. See [release evidence](evidence/README.md) for the verified native behavior.
