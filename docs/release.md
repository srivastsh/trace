# Trace release validation

## 0.1.1 extension icon

The toolbar and extension manager use the same graphite and white Trace mark. The source tree includes the editable SVG and the four PNGs supplied to Chromium at 16, 32, 48 and 128 pixels. The public key and extension ID are the same as in 0.1.0. To update, replace the files in the existing unpacked folder and reload its Trace entry.

## 0.1.0 validation

Trace 0.1.0 has stable extension ID `nmmlhlhpfpfiehpoccmloghalfgfmaol`. The release contains 18 production files, with a sorted SHA-256 inventory digest of `1d5a9c44415678c9c3e923287fc6bd18d5d65199a5039f46ab0fdcfed4e38114`. A clean checkout and locked npm installation reproduced all packaged assets byte-for-byte.

The primary menu was verified in Dia 1.57.1 (Chromium 157.0.8103.79). The sequence was Move to project, Trace, Archive and Delete. Activity transferred focus to its Close button and returned it to Chat actions on Escape. Settings and Local library opened from the same menu.

Synthetic tests used an isolated Chrome 158 profile, separate from the live compatibility check. Eight [light and dark screenshots](evidence/README.md) show the menu, Activity, library and handoff editor using synthetic project data. All six menu actions and keyboard focus return were also verified at actual 200% Chrome zoom. The earlier 18-file inventory with digest `08f4234e22f16fb9ffaf1c1b745476d249b5889f628b579c318f01a69baeb4a6` provided the extended archive/reload workflow and performance measurements. The corrected build changed the isolated page UI and the popup assets; its observer, database, library, restore and search files were identical.

## Implementation verification

| Requirement | Delivered behavior | Evidence |
| --- | --- | --- |
| ACT-01 | Reply-specific raw model, token counts, timestamp, source field and endpoint | Parser and network fixtures cover resolved versus generic attribution, absent fields, late replies, hidden/tool content and genuine zero. Native fixture shows a reported model and zero output. |
| ACT-02 | Context meter only for comparable counts and a once-per-reply optional alert | Unit fixtures cover compatible scope, unavailable or catalog-only limits, zero and conflicting values. Native fixture shows 1,200 / 4,000 and 30%. |
| ACT-03 | Scoped, observed quota fields, fixed reset deadlines, freshness labels | Fixtures cover zero, absolute/relative reset and elapsed deadlines. Availability in a live account depends on supported responses. |
| CAP-01 | Off-by-default capture, DOM segments, passive branch evidence and provisional identities | Fresh welcome and one-time save verified in the separate signed-out QA profile. Repository tests cover virtualization, duplicate batches, edits and siblings. |
| CAP-02 | Manual or observed binding, source and selection fences, Temporary Chat exclusion, pause | Worker and repository tests cover unbound/stale content, unknown and temporary states, ordinary-chat confirmation, deletion, generation revocation and distinct scopes. |
| CAP-03 | 30/90-day or indefinite retention, saved excerpts, deletion, resumable validated restore | Tests exercise retention visibility and cleanup, quota rollback, interrupted/reopened jobs, conflict copies, incomplete-job removal, clear and saved-evidence scrubbing. |
| LIB-01 | Collection-scoped lexical, prefix and quoted search, filters and a local reader | Native Chromium found the synthetic phrase and opened the saved copy. Unit tests cover lexical boundaries, indexed code, scope isolation and deleted-result hydration. |
| SAV-01 | One-time review, saved-message controls, provenance, private labels/tags/notes | Native Chromium confirmed a one-time save after 90-day retention review, a private bookmark, and automatic capture still off. Explicit-save validation tests reject unreviewed IDs and consumed or stale leases. |
| EXP-01 | Local Markdown, plain text, conversation JSON and collection backups | Unit tests cover source details, exact code and coverage, selected revisions, envelope conflicts, private-record exclusions and backup validation. |
| HND-01 | Editable templates, selected evidence, size budget, explicit omission markers and opt-in draft storage | Unit fixtures cover blank notes, pinned revision provenance, Unicode, code and selected evidence. Native profile workflows are documented in QA evidence. |
| OPS-01 | Content-free diagnostics and local status, export and clear | Sender, package and storage tests verify archive access boundaries, trusted-only roles, safe data projections and a local-only CSP. |
| UI-01 / UI-02 | Host-matched submenu and Activity, extension-origin library, toolbar fallback and accessible controls | Native synthetic checks and screenshots distinguish real Chromium behavior from undocumented live-host compatibility. See docs/qa.md and its evidence. |
| OPS-02 | Authorized in-place native install, expected ID, capture state and live smoke check | Native reload preserved extension storage. A compatibility smoke check on Dia 1.57.1 verified the menu, focused Activity, Settings and library launch. |

## Build and test environment

Development dependencies are locked to TypeScript 6.0.3, Vite 8.0.10, Vitest 4.1.6 and Playwright 1.58.2. Runtime packages are idb 8.0.3, MiniSearch 7.2.0 and Preact 10.27.2. A clean npm ci and independent production build from the committed source reproduced all 18 production files byte-for-byte on Node 22.12.0. The package audit checked scripts, assets, permissions, execution worlds, CSP, stable public key and extension identity.

Fifty-one standard Vitest checks passed on the corrected candidate, including a structural regression using the exact live ArchiveA row shape. The two opt-in suites are a Chromium observer test and a 50,000-message benchmark. The benchmark was also run separately. Its 84 warm samples, including repository hydration and revision checking in Node with fake IndexedDB, measured median 19.93 ms and p95 83.53 ms, with 6.53 s for cold indexing and reads. This measurement excludes the browser's message transport and UI debounce. Full Playwright could not launch in the shell sandbox. Native signed-out Chrome testing used the separate fixture driver and unchanged release files. The native QA report matches the corrected 18-file inventory. The performance and archive workflow reports identify their original tested build. It verifies synthetic light/dark appearance, stale actions, native keyboard interaction including Move to project, theme changes, narrow navigation and route-specific network behavior.

With 1,200 synthetic turns, two enabled native Chrome runs measured typing p95 of 15.9–16.2 ms and scrolling p95 of 9.2–10.6 ms. Two disabled runs measured 15.7–15.9 ms and 8.9–9.1 ms respectively. With 24 virtualized turns mounted, typing p95 was 15.4–15.6 ms enabled versus 16.0–16.3 ms disabled. Scrolling p95 was 9.4–10.3 ms enabled versus 8.8–10.0 ms disabled. Renderer script time increased in the virtualized workload from about 19–20 ms total to 44–48 ms across 72 interactions. The fixture did not show a repeatable extra frame of typing or scrolling latency.

The earlier release passed signed-out Chrome workflow checks using synthetic data. Reloading the existing installation preserved the collection, private note and handoff draft without turning capture on. After a tester bound the fixture and enabled capture, a synthetic checkpoint appeared in the library. A second checkpoint added after revocation did not appear in search or the exported backup. The backup inclusion preview contained one collection, conversation, saved item and draft. Local deletion removed the conversation and retained the separately authored draft notes. The extension accepted the validated backup, finished all seven restore steps and restored the conversation with its unknown-coverage label. Capture remained off. The toolbar fallback on an unsupported tab showed the unavailable current-chat state, disabled contextual actions and launched the library.

An ordinary page may omit model, token or quota information. The extension leaves those fields unavailable. Partial or unsupported data produces an explicit coverage label. On unrecognized host-menu layouts the toolbar remains available. An already-open tab can require a safe reload after the extension is disabled or updated. Version 0.1 does not include reply-timing history, official ChatGPT import, print/PDF, semantic retrieval or MCP.
