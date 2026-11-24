# Data handling

| Data | Location and lifetime |
| --- | --- |
| Reported reply model, token counts, optional limits and active scope evidence | Transient while observing a supported conversation. Absent fields display as unavailable. Quotas and account defaults are excluded from saved replies. |
| Active account/workspace IDs | Used only for a supported active identity. The durable collection association uses a local salted hash. No email or credentials are needed. |
| Automatic transcript text | Off on first installation. After explicit binding and consent, supported visible user and assistant text, observed source references and branch/revision evidence are recorded in extension-origin IndexedDB. |
| One-time review | Scoped to its source and review tab in restricted extension session storage for at most 15 minutes, with a 2 MiB aggregate staging limit. Closing either tab discards the staged entry. Explicit save commits only reviewed material. |
| Conversation records | Default retention is 90 days since last capture. Collections can select 30 days or keep until deleted. Reads omit expired transcripts, with physical cleanup on extension startup, library use and recurring alarms. Browser shutdown can postpone cleanup. |
| Saved messages and handoffs | A saved excerpt or explicitly saved handoff draft retains its selected text, provenance and user notes until deletion. Editing notes does not reset transcript retention. Unsaved editor text stays in its extension tab. |
| Diagnostics | Bounded local event codes, timestamps, adapter versions and counts. The schema omits transcript text, URLs, account identifiers, headers and credentials. |
| Downloads | Markdown, text, conversation JSON and collection backup JSON are local user-initiated files. A backup may include private notes and saved handoff drafts. It excludes runtime bindings, stages, quota observations and transferable consent. |

Temporary Chats, incognito contexts, public share pages, account settings and unresolved page states are excluded from automatic capture. Trace ignores hidden, internal, tool and intermediate messages. It never retrieves attachments, requests chat history, reads cookies, captures outbound request bodies or embeds a remote image in the reader. Links are opened only by the user. API secrets, passwords, memory contents, custom-instruction text and raw response dumps have no archive field.

The observer caps supported JSON at 16 MiB, SSE at 32 MiB per observation, individual frames at 1 MiB and observation time at 30 minutes. Supported text has a 512 KiB per-message ceiling, automatic extension batches cap at 128 KiB, and the pending projection queue caps at 2 MiB. Oversized or interrupted material is unavailable or carries a coverage warning.

Deleting a local chat removes its transcript, saved-message notes, linked draft evidence and search entries. A minimal exclusion prevents the open chat from immediately repopulating. Resume requires an explicit action. Clear Trace data disables saving, fences pending work and removes archive records, staging, bindings and settings. Exported files remain wherever the user downloaded them. The extension does not encrypt the archive or guarantee forensic erasure of device backups.
