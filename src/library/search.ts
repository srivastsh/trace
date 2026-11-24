import MiniSearch from 'minisearch';
import type { SearchDocument } from '../archive/types';

export const PAGE_SIZE = 24;
export const ALL_COLLECTIONS = '__all__';
export const UNKNOWN_MODEL = '__unknown__';

export interface SearchFilter {
  collectionId: string;
  savedOnly?: boolean;
  role?: SearchDocument['role'];
  model?: string;
  since?: number;
  until?: number;
  dateField: 'capturedAt' | 'updatedAt';
}

export interface SearchRequest {
  version: number;
  query: string;
  filter: SearchFilter;
  offset: number;
}

export interface SearchResponse {
  version: number;
  documents: (Omit<SearchDocument, 'text' | 'note' | 'tags'> & { excerpt: string })[];
  models: string[];
  more: boolean;
  indexed: number;
  rebuilding: boolean;
  error?: string;
}

const tokenize = (text: string): string[] => text.match(/[\p{L}\p{M}\p{N}_$]+/gu) ?? [];
const normalize = (text: string): string => text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();

export function parseQuery(query: string): { terms: string[]; lexical: string[]; literals: string[] } {
  const terms: string[] = [];
  const lexical: string[] = [];
  const literals: string[] = [];
  for (const match of query.trim().matchAll(/"([^"\r\n]+)"|([^\s"]+)/gu)) {
    const token = normalize(match[1] ?? match[2] ?? '');
    if (!token) continue;
    if (match[1] || /[^\p{L}\p{M}\p{N}_$]/u.test(token)) literals.push(token);
    else lexical.push(token);
    terms.push(...tokenize(token));
  }
  return { terms: [...new Set(terms)], lexical: [...new Set(lexical)], literals: [...new Set(literals)] };
}

const word = /[\p{L}\p{M}\p{N}_$]/u;
const literalPattern = (value: string): RegExp => new RegExp(
  `${word.test(value[0] ?? '') ? '(?<![\\p{L}\\p{M}\\p{N}_$])' : ''}${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${word.test(value.at(-1) ?? '') ? '(?![\\p{L}\\p{M}\\p{N}_$])' : ''}`, 'u');

function matches(document: SearchDocument, filter: SearchFilter): boolean {
  if (!filter.collectionId || (filter.collectionId !== ALL_COLLECTIONS && document.collectionId !== filter.collectionId)) return false;
  if (filter.savedOnly && !document.saved) return false;
  if (filter.role && document.role !== filter.role) return false;
  if (filter.model === UNKNOWN_MODEL ? document.reportedModel !== null : filter.model && document.reportedModel !== filter.model) return false;
  if (filter.since !== undefined && document[filter.dateField] < filter.since) return false;
  return filter.until === undefined || document[filter.dateField] <= filter.until;
}

export class LocalSearch {
  private documents = new Map<string, SearchDocument>();
  private normalized = new Map<string, { title: string; notes: string; text: string }>();
  private byConversation = new Map<string, Set<string>>();
  private index = new MiniSearch<SearchDocument>({
    fields: ['title', 'tags', 'note', 'text'],
    tokenize,
    processTerm: normalize,
    extractField: (document, field) => field === 'tags' ? document.tags.join(' ') : document[field as keyof SearchDocument],
  });

  get size(): number { return this.documents.size; }

  add(documents: SearchDocument[]): void {
    for (const document of documents) {
      const previous = this.documents.get(document.id);
      if (previous) {
        this.index.discard(document.id);
        if (previous.conversationId !== document.conversationId) this.byConversation.get(previous.conversationId)?.delete(document.id);
      }
      this.documents.set(document.id, document);
      this.normalized.set(document.id, { title: normalize(document.title), notes: [document.note, ...document.tags].map(normalize).join('\0'), text: normalize(document.text) });
      let ids = this.byConversation.get(document.conversationId);
      if (!ids) {
        ids = new Set<string>();
        this.byConversation.set(document.conversationId, ids);
      }
      ids.add(document.id);
      this.index.add(document);
    }
  }

  removeConversations(conversationIds: string[]): void {
    for (const conversationId of conversationIds) {
      const ids = this.byConversation.get(conversationId);
      if (!ids) continue;
      for (const id of ids) {
        this.index.discard(id);
        this.documents.delete(id);
        this.normalized.delete(id);
      }
      this.byConversation.delete(conversationId);
    }
  }

  search(query: string, filter: SearchFilter, offset: number): { ids: string[]; models: string[]; more: boolean } {
    const { lexical, literals } = parseQuery(query);
    const patterns = literals.map(literalPattern);
    const now = Date.now();
    const recency = (document: SearchDocument) => Math.max(0, 1 - (now - document.updatedAt) / (90 * 86_400_000)) * 0.05;
    const score = (document: SearchDocument): number => {
      const parts = this.normalized.get(document.id)!;
      let total = 0;
      for (const pattern of patterns) {
        if (pattern.test(parts.title)) total += 4;
        else if (pattern.test(parts.notes)) total += 2.5;
        else if (pattern.test(parts.text)) total += 1;
        else return 0;
      }
      return total;
    };
    const eligible = (document: SearchDocument) => matches(document, filter);
    const literalScores = new Map<string, number>();
    const rows = lexical.length ? this.index.search(lexical.join(' '), {
      combineWith: 'AND', prefix: true, boost: { title: 4, tags: 2.5, note: 2.5, text: 1 },
      boostDocument: (id) => {
        const document = this.documents.get(String(id));
        if (!document || !eligible(document)) return 0;
        if (!patterns.length) return 1 + recency(document);
        let literal = literalScores.get(document.id);
        if (literal === undefined) {
          literal = score(document);
          literalScores.set(document.id, literal);
        }
        return literal ? 1 + recency(document) + literal * 0.1 : 0;
      },
    }).map(({ id }) => String(id)) : Array.from(this.documents.values()).flatMap((document) => {
      if (!eligible(document)) return [];
      const literal = patterns.length ? score(document) : 1;
      return literal ? [{ document, literal }] : [];
    }).sort((a, b) => b.literal - a.literal || b.document.updatedAt - a.document.updatedAt || a.document.id.localeCompare(b.document.id))
      .map(({ document }) => document.id);
    const models = new Set<string>();
    for (const document of this.documents.values()) {
      if (filter.collectionId !== ALL_COLLECTIONS && filter.collectionId !== document.collectionId) continue;
      if (document.reportedModel !== null) models.add(document.reportedModel);
    }
    return { ids: rows.slice(offset, offset + PAGE_SIZE), models: [...models].sort(), more: rows.length > offset + PAGE_SIZE };
  }
}

export function snippet(document: SearchDocument, query: string): string {
  const { terms, literals } = parseQuery(query);
  const candidates = [document.text, document.note, ...document.tags].filter(Boolean).map((value) => ({
    text: value.replace(/\s+/gu, ' ').trim(), normalized: normalize(value),
  }));
  const patterns = [...literals.map(literalPattern), ...terms];
  for (const pattern of patterns) {
    for (const candidate of candidates) {
      const hit = typeof pattern === 'string' ? candidate.normalized.indexOf(pattern) : candidate.normalized.search(pattern);
      if (hit < 0) continue;
      const start = Math.max(0, hit - 55);
      return `${start ? '…' : ''}${candidate.text.slice(start, start + 155)}${candidate.text.length > start + 155 ? '…' : ''}`;
    }
  }
  const text = (document.text || document.note).replace(/\s+/gu, ' ').trim();
  return `${text.slice(0, 155)}${text.length > 155 ? '…' : ''}`;
}
