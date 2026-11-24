# Trace

![Trace extension icon](src/icons/trace-48.png)

Trace is a local-first MV3 extension for ChatGPT on Chromium. It adds **Trace ›** to the current conversation's **Chat actions** menu. Activity shows reported reply metadata. Save, Export, and Prepare handoff open a review page. Local library and Settings remain accessible from the toolbar even when the host menu changes.

## Use

1. Open a ChatGPT conversation. Open the header’s **Chat actions → Trace → Activity**. Fields appear only when a supported response provides them. Use the toolbar if the menu is unavailable.
2. Choose **Save chat** to review the current branch or rendered segment, choose a collection, and confirm. Choose individual messages to retain excerpts and private notes until you delete them.
3. Open **Local library** to search saved text, filter results, inspect revisions and their coverage, export, or prepare a handoff. A handoff starts with blank editable notes and the excerpts you select.
4. For ongoing capture, open **Settings** from the current conversation. Choose the destination and retention, explicitly enable saving for that collection and this device, and bind the current document. An unrecognized or temporary chat stays paused. A new document requires fresh resolution. Automatic capture starts off.
5. Use **Trace backup** in the library to review what will be included and download a local JSON file. On restore, review its counts and destination, then complete or resume the import. Imported material never grants capture consent. Backups contain plain text. A conversation export contains only its selected transcript and provenance.

See the [light and dark screenshots](docs/evidence/README.md) for the conversation menu, Activity, saved library and handoff editor.

## Build and validate

Use Node 22.12 or a supported later LTS and the checked-in dependency lock. Install from the lock before running the following commands.

```sh
npm ci
npm run check
npm test
npm run build
npx playwright install chromium
npm run qa
npm run package
```

The package command expects a clean, committed source tree and a current production build in `dist/`. It writes the versioned production ZIP, source ZIP, commit-to-file manifest and SHA-256 checksums in `release/`. The runtime consists entirely of the files in `dist/`. There is no server. Run `npm run dev` to rebuild changes during development. The automated browser tests use disposable profiles and synthetic conversations.

## Install, update, disable and remove

Download [Trace 0.1.1](https://github.com/srivastsh/trace/releases/tag/v0.1.1) and choose `Trace-0.1.1.zip` for the extension. Version 0.1.1 adds the Trace icon to the toolbar and extension manager.

The stable public manifest key identifies Trace as `nmmlhlhpfpfiehpoccmloghalfgfmaol`. For a fresh unpacked installation, extract the production ZIP into a permanent folder, such as `~/Applications/Trace/extension`. In Dia, choose **Extensions → Manage Extensions**, enable Developer mode where available, and use **Load unpacked** to select the directory containing `manifest.json`. Leave that folder in place. Open a fresh ChatGPT tab after installation.

For updates, back up the archive, keep a copy of the previous validated folder, replace the files inside the same stable directory, and use **Reload** on the existing Trace entry. Verify its ID, version, settings and archive. If rollback is needed, restore the previous files at the same path and reload. Reload an existing ChatGPT tab only when any draft is safe. Unpacked installations receive updates manually.

To disable, switch Trace off in Manage Extensions and open a fresh ChatGPT tab. To remove, make a backup, then use **Remove** on the Trace entry. Chromium may discard extension-origin storage on uninstall. **Delete local copy** and **Clear Trace data** apply to this device. ChatGPT retains its separate server history.

## Limits and attribution

Coverage applies to an identified branch or capture segment. A DOM snapshot has unknown ancestry. Messages, attachments, usage and model metadata that never reached a supported surface cannot be recovered. The menu adapter uses English action labels and tested semantic controls. Host changes can make the toolbar fallback necessary. Manual collection names organize local data and cannot independently identify an account. There is no extension-level encryption, account sync, external summarizer or background fetch of other chats.

The original Modus MIT notice and pinned source references are in LICENSE, NOTICE and vendor/modus. Trace uses the upstream endpoint, response metadata, visible branch and formatting work as a reference. New implementation boundaries and data handling are in docs/architecture.md and docs/data-handling.md. Validation outcomes and installation state are recorded separately in the release report.
