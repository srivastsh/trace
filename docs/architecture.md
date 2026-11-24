# Architecture and capability boundaries

| Context | Input | Output and authority |
| --- | --- | --- |
| MAIN observer | Supported same-origin Fetch and XHR responses on chatgpt.com | Size-limited, route-specific observations. Never sends requests, reads request bodies or writes extension storage. |
| Isolated content script | Validated page events, current rendered thread and trusted user gestures | Current-chat Activity, a native-menu adapter, short consent-gated capture batches, and reviewed one-time staging requests. |
| MV3 service worker | Browser-provided sender origin, top-frame document identity and narrow RPC operations | One serialized mutation coordinator, session scope/leases, IDB commit fences, cleanup and trusted extension-page operations. |
| Extension pages | User-selected collections, records, revisions, notes and import files | Local reader, search worker, explicit saves, backup/restore, documents and diagnostics. All rendering treats archive text as data. |

## Protocol and lifetime

The observer monitors recognized history, turn, model and account/limit endpoint shapes. Its fetch wrapper returns the original promise and reads only a cloned supported response. XHR observes bounded uncompressed JSON with an explicit content length. SSE is supported on Fetch. The isolated receiver checks its own scope, sequence, schema and capture grant. A same-origin page can imitate a bridge message. A bridge event cannot grant consent, bind a document, open the archive, create a save intent or execute a privileged command.

The worker distinguishes content scripts, the toolbar popup and the library by trusted sender metadata. A reviewed action carries the originating tab, browser document, navigation epoch, provider reference and selected branch or segment. An action in a stale tab fails. The popup uses a live top-frame receiver and requires the same selection at activation. An extension-page review has a single reader and an expiring commit lease.

Automatic capture requires an ordinary supported page, explicit global and collection consent, a bound document, a matching capture generation and no applicable exclusion. The repository checks generation and the document fence in the same transaction as insertion. Repeated batches have receipts. The worker acknowledges a write after commit. Session data holds live document bindings. IndexedDB holds a derived, content-free commit fence to order concurrent writes; startup and tab-close handlers remove obsolete fences.

The archive assigns a collection-scoped local conversation and stores provider aliases separately. Branch segments refer to exact revision IDs. Rendering fewer messages adds a segment and preserves earlier observations. A promoted identifier requires an explicit relation and scope. A complete claim requires root-to-finalized-leaf proof. Durable restore jobs checkpoint progress and keep their partial records outside normal reads until finalization.

Search indexes are disposable. The search worker reads paginated records on the extension origin and verifies results against the current archive. Local deletion invalidates saved excerpts, private message notes, cached hits and the deleted conversation's supporting evidence in handoff drafts.

## Permission and adapter surface

The only manifest permissions are storage and alarms. Static top-level content scripts match https://chatgpt.com/* in the MAIN and ISOLATED worlds. No host access to chat.openai.com is requested. The popup queries the current tab ID, and current-chat messages go to the top-frame receiver. Shortcuts ship without suggested key bindings. Toolbar, settings, search and archive operations work without a persistent background process.

The header adapter recognizes a persistent conversation action trigger linked to the active menu, matches organization/destructive action structure, and leaves an unsupported surface alone. A reported model, token count or quota depends on the supported field and its source. Timing history, semantic search, PDF export, official ChatGPT export import and MCP are deferred.

## Implementation references

| Subject | Official reference |
| --- | --- |
| Toolchain and Node compatibility | [Vite guide](https://vite.dev/guide/) |
| Extension views | [Preact v10 guide](https://preactjs.com/guide/v10/getting-started/) |
| Storage and search dependencies | [idb](https://github.com/jakearchibald/idb), [MiniSearch](https://lucaong.github.io/minisearch/) |
| Tests | [Vitest guide](https://vitest.dev/guide/), [Playwright Chromium extension testing](https://playwright.dev/docs/chrome-extensions) |
| Scripting worlds and storage visibility | [Content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts), [Extension storage](https://developer.chrome.com/docs/extensions/reference/api/storage) |
| Worker restarts and identity | [Service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle), [Manifest public key](https://developer.chrome.com/docs/extensions/reference/manifest/key) |
| Unpacked installation and Dia MV3 support | [Chrome installation workflow](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world), [Dia MV2 retirement](https://www.diabrowser.com/changelog/mac/1-17-0) |

