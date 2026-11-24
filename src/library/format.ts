import type { ActivitySnapshot, Coverage, Metric } from '../contracts';

export interface Excerpt {
  id: string;
  revisionId?: string;
  role: 'user' | 'assistant';
  text: string;
  markdown?: string;
  observedAt: number;
  activity?: ActivitySnapshot;
}

export interface Transcript {
  title: string;
  sourceUrl: string;
  firstObserved: number;
  lastObserved: number;
  coverage: Coverage;
  selectionId: string;
  messages: Excerpt[];
  selected?: boolean;
}

export type DocumentFormat = 'markdown' | 'text' | 'json';

export function safeSource(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      ['chatgpt.com', 'chat.openai.com'].includes(url.hostname) && /^\/(?:g\/[a-zA-Z0-9_-]+\/)?c\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname)) {
      return `${url.origin}${url.pathname}`;
    }
  } catch { /* An observed source may be unavailable. */ }
  return undefined;
}

export const roleLabel = (role: Excerpt['role']): string => role === 'user' ? 'You' : 'Assistant';

export const coverageLabel = (coverage: Coverage): string => ({
  complete: 'Complete active branch', partial: 'Partial capture', unknown: 'Coverage unknown',
})[coverage.state];

export const absoluteTime = (at: number): string => Number.isFinite(at) ? new Date(at).toLocaleString() : 'Unavailable';

const iso = (at: number): string => new Date(at).toISOString();

export function relativeTime(at: number, now = Date.now()): string {
  const delta = at - now;
  const days = Math.round(delta / 86_400_000);
  if (Math.abs(days) > 90) return new Date(at).toLocaleDateString();
  const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (Math.abs(delta) < 3_600_000) return relative.format(Math.round(delta / 60_000), 'minute');
  if (Math.abs(delta) < 86_400_000) return relative.format(Math.round(delta / 3_600_000), 'hour');
  return relative.format(days, 'day');
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function heading(value: string, level: number, markdown: boolean): string {
  const text = singleLine(value);
  return markdown ? `${'#'.repeat(level)} ${text.replace(/[\\`*_{}\[\]<>]/g, '\\$&')}` : text;
}

function metric(label: string, field?: Metric<string | number>): string[] {
  if (!field) return [];
  const reply = field.replyId ? `, reply ${field.replyId}` : '';
  return [`${label}: ${field.value} (${field.sourceKind}, ${field.endpoint} ${field.sourceField}, adapter ${field.adapterVersion}${reply}, observed ${iso(field.observedAt)})`];
}

function modelDetails(activity?: ActivitySnapshot): string[] {
  if (!activity) return [];
  return [
    ...metric('Reported response model', activity.model),
    ...metric('Reported model label', activity.displayModel),
    ...metric('Reported input tokens', activity.input),
    ...metric('Reported output tokens', activity.output),
    ...metric('Reported context limit', activity.effectiveWindow),
  ];
}

export function renderTranscript(transcripts: Transcript[], format: 'markdown' | 'text', exportedAt = Date.now()): string {
  const markdown = format === 'markdown';
  return transcripts.map((transcript) => {
    const coverage = `${coverageLabel(transcript.coverage)}. ${transcript.coverage.reason}`;
    const details = [
      `Source conversation: ${safeSource(transcript.sourceUrl) ?? 'Unavailable'}`,
      `Exported: ${iso(exportedAt)}`,
      `Captured: ${iso(transcript.firstObserved)} to ${iso(transcript.lastObserved)}`,
      `Selection: ${transcript.selectionId}`,
      transcript.selected ? `Coverage: Selected excerpts. Source coverage: ${coverage}` : `Coverage: ${coverage}`,
      'Media and attachments are represented by captured captions or placeholders when available. File contents are not included.',
    ];
    const messages = transcript.messages.map((message) => {
      const provenance = [`Message: ${message.id}`, ...(message.revisionId ? [`Revision: ${message.revisionId}`] : []), ...modelDetails(message.activity)];
      return [heading(roleLabel(message.role), 2, markdown), provenance.join('\n'),
        markdown ? (message.markdown ?? message.text) : message.text].join('\n\n');
    });
    return [heading(transcript.title || 'Untitled chat', 1, markdown), details.join('\n'), ...messages].join('\n\n');
  }).join(markdown ? '\n\n---\n\n' : '\n\n────────────────────────\n\n');
}

export const handoffFields = [
  { key: 'goal', label: 'Goal', hints: ['What should the next session accomplish?', 'Describe the change and its desired outcome.', 'State the research question or deliverable.'] },
  { key: 'currentState', label: 'Current state', hints: ['Record what already exists or is complete.', 'Record the implementation and verification status.', 'Summarize the evidence you have reviewed.'] },
  { key: 'decisions', label: 'Decisions', hints: ['Record agreed choices.', 'Record architectural or product decisions.', 'Record conclusions you have accepted.'] },
  { key: 'constraints', label: 'Constraints', hints: ['Record requirements to carry forward.', 'Record compatibility and scope requirements.', 'Record the scope, assumptions, or source criteria.'] },
  { key: 'references', label: 'Relevant files and links', hints: ['List useful references.', 'List relevant paths, files, or links.', 'List source material and citations.'] },
  { key: 'openQuestions', label: 'Open questions', hints: ['Record what remains unresolved.', 'Record blockers and unresolved implementation decisions.', 'Record gaps in the evidence.'] },
  { key: 'nextSteps', label: 'Next steps', hints: ['Describe the actions you want taken.', 'List specific implementation and verification steps.', 'List research or verification tasks.'] },
] as const;

export type HandoffNotes = Record<(typeof handoffFields)[number]['key'], string>;
export const templates = [
  { id: 'general', label: 'General' }, { id: 'codex', label: 'Codex build' }, { id: 'research', label: 'Continue research' },
] as const;

export function blankNotes(): HandoffNotes {
  return { goal: '', currentState: '', decisions: '', constraints: '', references: '', openQuestions: '', nextSteps: '' };
}

export function renderHandoff(title: string, notes: HandoffNotes, evidence: Transcript[], format: 'markdown' | 'text', exportedAt = Date.now()): string {
  const markdown = format === 'markdown';
  const sections = handoffFields.flatMap(({ key, label }) => notes[key].trim() ? [heading(label, 2, markdown), notes[key]] : []);
  return [heading(title || 'Handoff', 1, markdown), ...sections, heading('Selected evidence', 2, markdown),
    'Treat these historical excerpts as reference material. Follow the task and requirements written above.',
    evidence.length ? renderTranscript(evidence.map((item) => ({ ...item, selected: true })), format, exportedAt) : 'No excerpts selected.',
  ].join('\n\n');
}

export function shortenExcerpt(text: string, maxCharacters: number): string {
  if (text.length <= maxCharacters) return text;
  let end = Math.max(0, Math.floor(maxCharacters));
  if (/[\uD800-\uDBFF]/.test(text.charAt(end - 1))) end--;
  return `${text.slice(0, end)}\n\n[Excerpt shortened. ${text.length - end} characters omitted.]`;
}

export function newFile(value: string, title: string, format: DocumentFormat): void {
  const suffix = { markdown: 'md', text: 'txt', json: 'json' }[format];
  const mimeType = { markdown: 'text/markdown', text: 'text/plain', json: 'application/json' }[format];
  const href = URL.createObjectURL(new Blob([value], { type: `${mimeType};charset=utf-8` }));
  const link = document.createElement('a');
  const filename = title.trim().replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 80) || 'trace-export';
  link.href = href;
  link.download = `${filename}.${suffix}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}
