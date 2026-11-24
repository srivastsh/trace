# Trace 0.1.0 release checkpoints

| Gate | Verified checkpoint |
| --- | --- |
| A · Baseline and shell | Pinned Modus source and license, strict TypeScript, clean npm ci, independent byte-identical build, minimally permissioned manifest, and signed-out native Chrome load. |
| B · Truthful Activity | Scoped parser, networking and Activity tests passed. The frozen native fixture rendered a resolved model, zero output and 30% comparable context in both themes. |
| C · Scoped capture | Commit-time consent and scope, alias promotion, revisions, expiration, deletion, quota rollback and resumable import tested. Native end-to-end outcomes appear in the QA record. |
| D · Library and saved messages | Search, notes and scope tests passed. Signed-out Chromium saved a one-time chat and opened a phrase match in the local reader. The 50,000-message search benchmark met the proposed warm target. |
| E · Handoff and export | Blank user notes, pinned excerpts, exact code, format envelopes, visible omissions and restore conflicts tested. The QA record distinguishes actual browser workflows. |
| F · Production | Completed. The corrected build passed repeated light/dark checks and the Dia compatibility smoke test. The complete 18-file inventory matched the tested package. See docs/release.md. |

## Runtime configuration

The coordinator was spawned with gpt-6.2-astra and ultra reasoning. Five implementation and verification workers were spawned independently with gpt-6.2-sol and high reasoning. Native browser testing was performed separately from the source builds.
