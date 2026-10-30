import {t, type MessageKey} from './i18n.js';
export type Segment = {text: string; matched: boolean};
export type Hit = {
  key: string; sourceId: string; threadId: string; title: string;
  project: {id: string; name: string} | null; updatedAt: string | null;
  snippet: {segments: Segment[]; provenance: string};
  navigation: {kind: string; url?: string; reason?: string; code?: string};
};
export type SearchResponse = {
  results: Hit[]; requestId: number; discarded?: boolean; warningCode?: string;
  has_more?: boolean; snapshot_id?: string; corpusRevision?: number;
};
type Params = Record<string, unknown>;
export type Api = (method: string, params?: Params, signal?: AbortSignal) => Promise<any>;
export type SearchState = 'idle' | 'waiting' | 'loading' | 'ready' | 'error';
export type SearchRecovery = 'none' | 'retry' | 'refresh';

function filterIdentity(filters: Params): string {
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, stable(item)])) : value;
  return JSON.stringify(stable(filters));
}

/** One completed result list per query; later pages use the same ranked snapshot. */
export class SearchController {
  revision = 0; results: Hit[] = []; selected = ''; frozen = false;
  state: SearchState = 'idle';
  recovery: SearchRecovery = 'none';
  private query = ''; private filters: Params = {}; private more = false;
  private filtersIdentity = filterIdentity({});
  private suspended = false; private interrupted = false; private retryPage = false;
  private message: MessageKey | undefined; private keywordOnly = false;
  private loadingRevision: number | null = null; private nextOffset = 0;
  private snapshot: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private requests: AbortController[] = [];
  private session = globalThis.crypto.randomUUID();
  constructor(private api: Api, private changed: (stage?: string) => void,
    private status: (text: string) => void, private initialLimit: () => number = () => 6) {}
  private setMessage(key?: MessageKey) {
    this.message = key; this.status(key ? t(key) : '');
  }
  private invalidate() {
    const hadRequests = this.requests.length > 0;
    ++this.revision; clearTimeout(this.timer);
    this.requests.forEach(request => request.abort()); this.requests = [];
    this.loadingRevision = null;
    if (hadRequests) void this.api('search_chats', {
      session_id: this.session, request_id: this.revision, cancel: true,
    }).catch(() => {});
  }
  close() {
    this.invalidate(); this.results = []; this.selected = ''; this.more = false;
    this.query = ''; this.filters = {}; this.filtersIdentity = filterIdentity({});
    this.snapshot = undefined; this.state = 'idle'; this.recovery = 'none';
    this.suspended = false; this.interrupted = false; this.retryPage = false;
    this.setMessage(); this.changed();
  }
  /** Hide the search without losing its completed ranking or loaded pages. */
  suspend() {
    if (this.suspended) return;
    this.interrupted = this.state === 'waiting' || this.state === 'loading'
      || (this.state === 'idle' && Boolean(this.query));
    this.invalidate(); this.suspended = true; this.status('');
  }
  /** Return true only when returning to search starts a new ranking. */
  resume(query: string, filters: Params = {}, composing = false): boolean {
    const restart = this.interrupted || composing || query.trim() !== this.query
      || filterIdentity(filters) !== this.filtersIdentity;
    this.suspended = false; this.interrupted = false;
    if (restart) { this.begin(query, filters, composing); return true; }
    this.status(this.message ? t(this.message) : ''); this.changed(); return false;
  }
  retry() {
    if (this.suspended || this.recovery === 'none') return;
    if (this.recovery === 'retry' && this.retryPage) {
      this.recovery = 'none'; this.retryPage = false;
      this.setMessage(this.keywordOnly ? 'search.textOnly' : undefined); this.changed();
      return this.loadMore();
    }
    this.begin(this.query, this.filters);
  }
  begin(query: string, filters: Params = {}, composing = false) {
    this.invalidate(); this.query = query.trim(); this.filters = structuredClone(filters); this.frozen = false;
    this.filtersIdentity = filterIdentity(this.filters); this.suspended = false; this.interrupted = false;
    this.recovery = 'none'; this.retryPage = false; this.keywordOnly = false; this.nextOffset = 0;
    this.results = []; this.selected = ''; this.more = false; this.snapshot = undefined;
    this.state = this.query && !composing ? 'waiting' : 'idle';
    this.setMessage(); this.changed();
    if (!this.query || composing) return;
    const revision = this.revision;
    const limit = Math.max(6, Math.min(100, Math.ceil(this.initialLimit()) || 6));
    this.timer = setTimeout(() => void this.run(revision, limit), 180);
  }
  private async run(revision: number, limit: number) {
    if (revision !== this.revision || this.suspended) return;
    const abort = new AbortController(); this.requests.push(abort);
    this.state = 'loading'; this.setMessage('search.loading'); this.changed();
    try {
      const response: SearchResponse = await this.api('search_chats', {
        include_archived: true, ...this.filters, query: this.query, mode: 'hybrid', limit,
        presentation: 'palette-v1', session_id: this.session, request_id: revision,
      }, abort.signal);
      if (revision !== this.revision || response.discarded) return;
      this.results = response.results; this.selected = response.results[0]?.key || '';
      this.more = Boolean(response.has_more); this.snapshot = response.snapshot_id;
      this.nextOffset = response.results.length; this.state = 'ready';
      this.keywordOnly = Boolean(response.warningCode);
      this.setMessage(this.keywordOnly ? 'search.textOnly' : undefined); this.changed('complete');
    } catch (error) {
      if (revision !== this.revision || abort.signal.aborted) return;
      const invalidPhrase = error instanceof Error && error.message === 'SEARCH_QUERY_INVALID';
      this.state = 'error'; this.recovery = invalidPhrase ? 'none' : 'retry';
      this.setMessage(invalidPhrase ? 'search.invalidPhrase' : 'search.failed'); this.changed();
    } finally { this.requests = this.requests.filter(request => request !== abort); }
  }
  async loadMore() {
    if (this.suspended || this.recovery !== 'none' || !this.more || !this.snapshot || this.loadingRevision === this.revision) return;
    const revision = this.revision; this.loadingRevision = revision;
    const abort = new AbortController(); this.requests.push(abort);
    try {
      const response: SearchResponse = await this.api('search_chats', {
        include_archived: true, ...this.filters, query: this.query, mode: 'hybrid',
        presentation: 'palette-v1', snapshot_id: this.snapshot, limit: 24, offset: this.nextOffset,
        session_id: this.session, request_id: revision,
      }, abort.signal);
      if (revision !== this.revision || response.discarded) return;
      this.nextOffset += response.results.length; this.more = Boolean(response.has_more);
      this.results.push(...response.results.filter(hit => !this.results.some(old => old.key === hit.key)));
      this.changed();
    } catch (error) {
      if (revision === this.revision && !abort.signal.aborted) {
        const expired = error instanceof Error && error.message === 'SEARCH_SNAPSHOT_EXPIRED';
        this.recovery = expired ? 'refresh' : 'retry'; this.retryPage = !expired;
        this.setMessage(expired ? 'search.refreshRequired' : 'search.pageFailed'); this.changed();
      }
    } finally {
      if (this.loadingRevision === revision) this.loadingRevision = null;
      this.requests = this.requests.filter(request => request !== abort);
    }
  }
  select(key: string) { this.frozen = true; this.selected = key; this.changed(); }
  move(delta: number) {
    if (!this.results.length) return;
    const index = this.results.findIndex(hit => hit.key === this.selected);
    this.select(this.results[Math.max(0, Math.min(this.results.length - 1, index + delta))].key);
  }
}
