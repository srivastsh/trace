# Trace v0.1 verification evidence

Extension ID `nmmlhlhpfpfiehpoccmloghalfgfmaol`. The corrected host build has production file-set SHA-256 `1d5a9c44415678c9c3e923287fc6bd18d5d65199a5039f46ab0fdcfed4e38114`. It addresses the live Dia menu placing Trace between Archive and Delete, and waits for native menu dismissal before focusing Activity. The corrected build passed shell checks and both native Chrome fixtures.

The earlier build had production file-set SHA-256 `08f4234e22f16fb9ffaf1c1b745476d249b5889f628b579c318f01a69baeb4a6`. The manual archive and performance results retain that build's scope.

## Package and automated tests

The corrected build passed TypeScript, 51 Vitest checks, and both packaged audits. Two opt-in tests were skipped in the standard run. An independent clean build reproduced the 18 production files. The audit checked version, stable ID, packaged entry points, origin scope, absence of development and credential artifacts, and the extension-page security policy.

The Playwright suite was blocked before Chromium launched. The bundled Chromium executable was absent, its download failed DNS resolution, and the installed Chrome and Edge Dev binaries aborted when launched from the shell in isolated temporary profiles. The native fixture runner used a separate signed-out Chrome profile and the regular Load unpacked interface.

## Native isolated Chrome

The corrected build passed both light and dark host fixtures in Chrome 158. The browser received the two expected synthetic requests in each theme. Both cases verified the live-shaped Archive row with an adjacent hidden shortcut, the exact `Move to project → Trace → Archive → Delete` order, and 400 ms of stable Activity Close focus after a simulated 120 ms native menu exit delay.

The fixtures checked one Trace submenu, native actions, the reported reply model and genuine zero output, the comparable 30% context meter, and Escape focus restoration. The light fixture also checked keyboard typeahead, native project navigation, menu remount, theme while open, compact Back navigation, stale branch and conversation actions, and whether a genuine click is required to open a save review.

A manual Chrome check at actual 200% browser zoom showed all six Trace items. Escape returned focus to Trace and then to the header trigger. Zoom was restored to 100% after the test.

[Native fixture report](trace-isolated-browser-summary.json) · [Light menu](trace-menu-light.png) · [Dark menu](trace-menu-dark.png) · [Light Activity](trace-activity-light.png) · [Dark Activity](trace-activity-dark.png)

## Manual checks in the signed-out Chrome profile

| Workflow | Observed result |
| --- | --- |
| One-time capture | A genuine Save chat action opened a review with coverage and 90-day retention. The saved copy appeared in phrase search while automatic saving remained off. |
| Saved items and handoff | The synthetic saved excerpt, tag, private note, and authored handoff draft appeared on the extension page. An in-place extension reload preserved the archive, saved item, draft, and capture-off state. |
| Consent and revocation | After explicit opt-in and manual collection binding, the synthetic capture checkpoint appeared in search. After turning saving off, the second checkpoint was absent and the committed copy remained available. |
| Trace backup | The browser downloaded a version-1 backup with one collection, one conversation, one saved message, and one handoff draft. It contained the expected fixture content and excluded the post-revocation checkpoint and transferable consent. |
| Local deletion and restore | The confirmation described removal of the transcript, associated notes and saved excerpts, and handoff evidence. The library became empty and separately authored handoff notes remained. Restore completed all seven reported steps into a separate collection. Its copy was readable and automatic saving stayed off. |
| Toolbar fallback | The popup on an unsupported page showed unavailable current-chat context, disabled Save and Export, and exposed Local library and Settings. The library action opened successfully. |

All archive tests used synthetic content on the earlier build. A full browser restart and a forced service-worker stop remain unmeasured. The dark library and both handoff screenshots remain pending.

[Light library](trace-library-light.png)

## Browser latency

Eight native runs on the earlier build compared the same 1,200-turn synthetic host with Trace active and without Trace injection. The virtualized fixture mounted 24 turns at a time. Each configuration ran twice, with 36 typing and 36 wheel inputs per run. Timings measure input events through the second animation frame in Chrome 158 on an Apple M1 Pro. Capture was inactive for these unbound document sessions.

| Fixture | Trace injection | Typing median | Typing p95 | Wheel median | Wheel p95 | Renderer script time per run |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Legacy | Off | 9.2–14.6 ms | 15.7–15.9 ms | 8.1 ms | 8.9–9.1 ms | 7.08–8.27 ms |
| Legacy | On | 14.9–15.2 ms | 15.9–16.2 ms | 8.0–8.1 ms | 9.2–10.6 ms | 10.55–11.07 ms |
| Virtualized | Off | 7.3–14.4 ms | 16.0–16.3 ms | 8.1–8.4 ms | 8.8–10.0 ms | 18.98–19.57 ms |
| Virtualized | On | 7.7–10.2 ms | 15.4–15.6 ms | 8.1–8.4 ms | 9.4–10.3 ms | 44.49–47.87 ms |

The benchmark saw no repeatable increase of an animation frame in typing or wheel latency. Trace added measurable script work when the virtualized fixture replaced rows. Results apply to the synthetic workload and the measured Chrome and hardware combination.

[Original native browser performance report](trace-host-benchmark-original.json)

## Search performance

The optimized in-memory search implementation indexed 50,000 synthetic messages in 1,392.52 ms on an Apple M1 Pro with macOS 26.6.2 and Node 22.12.0. It measured 23.93 ms median and 75.55 ms p95 over 96 warm queries, including exact phrases, punctuation, common terms, and empty results. The separate paged repository and hydration fixture measured 83.53 ms p95 across 84 queries using a simulated IndexedDB environment. Browser scheduling, actual IndexedDB latency, and the library’s input debounce are outside those measurements.

[Original standalone search timing](trace-search-benchmark-original.json)

## Dia compatibility smoke test

The corrected Trace 0.1.0 installation was enabled in Dia at the expected extension ID. The installed folder matched all 18 files in the corrected build. Dia reported no extension load errors.

On ChatGPT, the live conversation menu showed `Move to project → Trace → Archive → Delete`. Keyboard navigation, the native Move to project submenu, Activity Close focus, and Escape/Left focus return worked. Activity displayed a reported model and showed token counts as unavailable. Local library and Settings opened, with automatic capture off on the fresh installation.
