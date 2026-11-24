import type { ConversationView, HandoffEvidence, MessageRevision, SavedItem } from '../archive/types';
import type { Projection } from '../contracts';
import type { Excerpt, Transcript } from './format';

export function revisionExcerpt(revision: MessageRevision): Excerpt {
  return { id: revision.messageId, revisionId: revision.id, role: revision.role,
    text: revision.text, observedAt: revision.observedAt, activity: revision.activity };
}

export function fromView(view: ConversationView): Transcript {
  const { conversation, segment, messages } = view;
  const observed = segment?.observedAt ?? conversation.lastObservedAt;
  return { title: conversation.title, sourceUrl: conversation.sourceUrl,
    firstObserved: messages.reduce((first, message) => Math.min(first, message.observedAt), observed),
    lastObserved: messages.reduce((last, message) => Math.max(last, message.observedAt), observed),
    coverage: segment?.coverage ?? conversation.coverage, selectionId: segment?.selectionId ?? 'Unavailable',
    messages: messages.map(revisionExcerpt) };
}

export function stagedView(projection: Projection, stageId: string): ConversationView {
  const id = `staged-${stageId}`;
  const messages: MessageRevision[] = projection.messages.map((message, index) => ({
    id: `${id}-${index}`, conversationId: id, messageId: message.id, parentId: message.parentId,
    provisional: message.provisional, role: message.role, text: message.text, observedAt: message.observedAt,
    final: message.final, source: projection.source, adapterVersion: projection.adapterVersion,
    activity: message.activity && { ...message.activity, quotas: [], accountDefault: undefined },
  }));
  const segment = { id: `${id}-segment`, conversationId: id, selectionId: projection.selectionId,
    source: projection.source, leafId: projection.leafId,
    revisions: messages.map(({ id: revisionId, messageId }) => ({ messageId, revisionId })),
    coverage: projection.coverage, observedAt: projection.observedAt, adapterVersion: projection.adapterVersion };
  return {
    conversation: { id, collectionId: 'reviewed', providerId: projection.providerId,
      title: projection.title, sourceUrl: projection.sourceUrl,
      firstObservedAt: messages.reduce((first, item) => Math.min(first, item.observedAt), projection.observedAt),
      lastObservedAt: projection.observedAt, segmentId: segment.id, coverage: segment.coverage },
    collection: { id: 'reviewed', label: 'Reviewed ChatGPT conversation', retention: 90, mode: 'manual',
      autoConsent: false, autoExcluded: false, createdAt: projection.observedAt },
    segment, segments: [segment], messages, saved: [], expired: false,
  };
}

export function viewEvidence(view: ConversationView, revisions?: Set<string>): HandoffEvidence[] {
  return view.messages.filter((revision) => !revisions || revisions.has(revision.id)).map((revision) => ({
    conversationId: view.conversation.id.startsWith('staged-') ? undefined : view.conversation.id,
    revisionId: view.conversation.id.startsWith('staged-') ? undefined : revision.id,
    messageId: revision.messageId, title: view.conversation.title, sourceUrl: view.conversation.sourceUrl,
    role: revision.role, text: revision.text, observedAt: revision.observedAt, activity: revision.activity,
    selectionId: view.segment?.selectionId, coverage: view.segment?.coverage ?? view.conversation.coverage,
  }));
}

export function savedEvidence(saved: SavedItem): HandoffEvidence {
  return { conversationId: saved.conversationId, revisionId: saved.revisionId, messageId: saved.messageId,
    title: saved.title, sourceUrl: saved.sourceUrl, role: saved.role, text: saved.text, coverage: saved.coverage,
    observedAt: saved.capturedAt, activity: saved.activity };
}

export function evidenceTranscripts(evidence: HandoffEvidence[], fallbackTime: number): Transcript[] {
  const groups = new Map<string, Transcript>();
  for (const item of evidence) {
    const key = JSON.stringify([item.conversationId ?? item.sourceUrl, item.title, item.selectionId, item.coverage]);
    let transcript = groups.get(key);
    const observedAt = item.observedAt ?? fallbackTime;
    if (!transcript) {
      transcript = { title: item.title, sourceUrl: item.sourceUrl, firstObserved: observedAt,
        lastObserved: observedAt, coverage: item.coverage, selectionId: item.selectionId ?? 'Saved excerpt', messages: [], selected: true };
      groups.set(key, transcript);
    }
    transcript.firstObserved = Math.min(transcript.firstObserved, observedAt);
    transcript.lastObserved = Math.max(transcript.lastObserved, observedAt);
    transcript.messages.push({ id: item.messageId ?? 'Unavailable', revisionId: item.revisionId,
      observedAt, role: item.role, text: item.unavailable ? '[Source excerpt is unavailable.]' : item.text,
      activity: item.unavailable ? undefined : item.activity });
  }
  return [...groups.values()];
}
