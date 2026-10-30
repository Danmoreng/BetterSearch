import {type Api} from './search-controller.js';
import {t, localize, currentLocale, type MessageKey} from './i18n.js';
type Row = Record<string, any>;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const errorKeys: Record<string, MessageKey> = {
  INDEX_BUSY: 'settings.busy', INDEX_PAUSED: 'settings.isPaused', INVALID_SOURCE: 'settings.invalidSource',
  SOURCE_EXISTS: 'settings.sourceExists', INVALID_LABEL: 'settings.invalidLabel',
  DIALOG_UNAVAILABLE: 'settings.dialogFailed', SAVE_FAILED: 'settings.saveFailed',
};
export class Settings {
  state: Row | null = null;
  private busy = false;
  private reading: Promise<void> | null = null;
  private revision = 0;
  private searchRevision = 0;
  private focus: HTMLElement | null = null;
  private confirmAction = '';
  private loadError = false;
  constructor(private api: Api, private changed: (preferences: Row, searchScope: string) => void) {
    document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-setting]').forEach(field => {
      field.onchange = () => void this.save({[field.dataset.setting!]: field instanceof HTMLInputElement && field.type === 'checkbox' ? field.checked : field.value});
    });
    document.querySelectorAll<HTMLButtonElement>('[data-action]').forEach(button => {
      button.onclick = () => {
        const action = button.dataset.action!;
        if (action === 'pause') void this.save({paused: !this.state?.preferences.paused});
        else if (action === 'rebuild' || action === 'clear') this.confirm(action);
        else void this.action(action);
      };
    });
    $('confirm-cancel').onclick = () => $<HTMLDialogElement>('settings-confirm').close();
    $('confirm-accept').onclick = () => {
      $<HTMLDialogElement>('settings-confirm').close();
      void this.action(this.confirmAction, {confirmed: true});
    };
    $('retry-settings').onclick = () => void this.load().catch(() => {});
  }
  load() {
    if (this.reading) return this.reading;
    if (this.busy) return Promise.resolve();
    const revision = this.revision;
    this.reading = this.api('read_settings').then(state => {
      // A poll started before a save must never replace its newer response.
      if (!this.busy && revision === this.revision) this.accept(state);
    }).catch(error => {if (!this.busy && revision === this.revision) this.error(error, false); throw error;}).finally(() => {this.reading = null;});
    return this.reading;
  }
  private accept(state: Row) {
    if (!state.preferences) throw Error('REQUEST_FAILED');
    if (this.loadError) {$('settings-error').hidden = true; this.loadError = false;}
    $('retry-settings').hidden = true;
    this.state = state;
    const searchScope = JSON.stringify({revision: this.searchRevision, archived: state.preferences.include_archived,
      sources: state.sources.filter((source: Row) => source.enabled).map((source: Row) => source.id).sort()});
    this.changed(state.preferences, searchScope); this.render();
    $('settings-loading').hidden = true; $('settings-content').hidden = false;
  }
  private error(error: unknown, saving = true) {
    this.loadError = !saving;
    const code = error instanceof Error ? error.message : '';
    $('settings-error').textContent = t(errorKeys[code] || (saving ? 'settings.saveFailed' : 'settings.failed'));
    $('settings-error').hidden = false; $('retry-settings').hidden = this.state !== null;
    if (saving) $('save-status').textContent = t('settings.notSaved');
  }
  private async save(patch: Row) {
    if (this.busy) return;
    this.setBusy(true); $('settings-error').hidden = true;
    $('save-status').textContent = t('settings.saving');
    try {this.accept(await this.api('update_settings', patch)); $('save-status').textContent = t('settings.saved');}
    catch (error) {if (this.state) this.render(); this.error(error);}
    finally {this.setBusy(false);}
  }
  private async action(action: string, values: Row = {}) {
    if (this.busy) return;
    this.setBusy(true); $('settings-error').hidden = true;
    $('save-status').textContent = t('settings.working');
    try {
      const result = await this.api('settings_action', {action, ...values});
      if (!result.cancelled && (action === 'clear' || action === 'rebuild')) ++this.searchRevision;
      if (result.preferences) this.accept(result);
      else this.accept(await this.api('read_settings'));
      $('save-status').textContent = result.cancelled ? '' : t(action === 'export_diagnostics' ? 'settings.exported' : 'settings.saved');
    } catch (error) {if (this.state) this.render(); this.error(error);}
    finally {this.setBusy(false);}
  }
  private setBusy(value: boolean) {
    if (value) {++this.revision; this.focus = document.activeElement instanceof HTMLElement ? document.activeElement : null;}
    this.busy = value;
    $<HTMLFieldSetElement>('settings-fields').disabled = value;
    $('settings-page').setAttribute('aria-busy', String(value));
    if (!value && !this.focus?.isConnected && this.focus?.id) this.focus = document.getElementById(this.focus.id);
    if (!value && !$('settings-page').hidden && document.activeElement === document.body) this.focus?.focus({preventScroll: true});
  }
  private confirm(action: string) {
    this.confirmAction = action;
    $('confirm-title').textContent = t(action === 'rebuild' ? 'settings.rebuildConfirm' : 'settings.clearConfirm');
    $('confirm-description').textContent = t(action === 'rebuild' ? 'settings.rebuildHelp' : 'settings.clearHelp');
    $('confirm-accept').textContent = t(action === 'rebuild' ? 'settings.rebuild' : 'settings.clear');
    $<HTMLDialogElement>('settings-confirm').showModal(); $('confirm-cancel').focus();
  }
  render() {
    if (!this.state) return;
    const {preferences: prefs, sources, status, model} = this.state;
    document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-setting]').forEach(field => {
      if (field instanceof HTMLInputElement && field.type === 'checkbox') field.checked = Boolean(prefs[field.dataset.setting!]);
      else field.value = prefs[field.dataset.setting!];
    });
    const running = status.indexing || status.embedding;
    const warning = status.progress.error || sources.some((source: Row) => source.enabled && source.warning);
    $('index-phase').textContent = t(prefs.paused ? running ? 'settings.pausing' : 'settings.paused' :
      warning ? 'settings.attention' : status.indexing ? 'settings.importing' : status.embedding ? 'settings.embedding' : status.threads ? 'settings.ready' : 'settings.emptyIndex');
    $('status-card').dataset.state = warning ? 'warning' : prefs.paused ? 'paused' : 'ready';
    $('index-summary').textContent = t('settings.indexed', {chats: status.threads, embedded: status.embedded || 0, chunks: status.chunks});
    const last = sources.filter((source: Row) => source.enabled && source.last_sync).map((source: Row) => String(source.last_sync)).sort().at(-1);
    $('last-updated').textContent = last ? t('settings.updated', {date: new Date(last).toLocaleString(currentLocale(), {dateStyle: 'medium', timeStyle: 'short'})}) : t('settings.neverUpdated');
    const progress = $<HTMLProgressElement>('index-progress');
    progress.hidden = !running;
    progress.max = Math.max(1, status.progress.total); progress.value = status.progress.done;
    $('pause-index').textContent = t(prefs.paused ? 'settings.resumeIndexing' : 'settings.pauseIndexing');
    const names: Record<string, MessageKey> = {efficient: 'settings.efficientHelp', balanced: 'settings.balancedHelp', fast: 'settings.fastHelp'};
    $('profile-description').textContent = t(names[prefs.profile] || 'settings.balancedHelp');
    this.renderSources(sources, Boolean(running || model.busy));
    $('model-state').textContent = t(model.busy ? model.phase === 'downloading' ? 'settings.downloading' : model.phase === 'verifying' ? 'settings.verifying' : 'settings.checking' :
      model.phase === 'error' ? 'settings.modelError' : status.model_ready ? 'settings.modelReady' : 'settings.modelMissing');
    const mb = (bytes: number) => (bytes / 1048576).toLocaleString(currentLocale(), {maximumFractionDigits: 0});
    $('model-size').textContent = model.busy && model.phase === 'downloading' ? t('settings.downloadSize', {done: mb(model.bytes || 0), total: model.total ? mb(model.total) : '…'}) :
      model.installed_bytes ? t('settings.installedSize', {size: mb(model.installed_bytes)}) : t('settings.downloadInfo');
    const meter = $<HTMLProgressElement>('model-progress'); meter.hidden = !model.busy;
    if (model.phase === 'downloading' && model.total) {meter.max = model.total; meter.value = model.bytes || 0;} else meter.removeAttribute('value');
    const install = $<HTMLButtonElement>('install-model');
    install.textContent = t(model.busy ? 'settings.installing' : model.phase === 'error' ? 'settings.retryModel' : status.model_ready ? 'settings.verifyModel' : 'settings.installModel');
    install.disabled = Boolean(model.busy || running);
    $('model-busy-help').hidden = !running;
    for (const id of ['refresh-index', 'repair-index']) $<HTMLButtonElement>(id).disabled = Boolean(prefs.paused || running || model.busy);
    for (const id of ['rebuild-index', 'clear-index', 'add-source']) $<HTMLButtonElement>(id).disabled = Boolean(running || model.busy);
    $('diagnostic-version').textContent = status.version;
    $('diagnostic-storage').textContent = t('settings.storageSize', {size: mb(status.database_bytes || 0)});
  }
  private renderSources(sources: Row[], running: boolean) {
    const container = $('source-list');
    // Polling must preserve focus, caret position and an unfinished label edit.
    if (container.contains(document.activeElement)) return;
    container.replaceChildren();
    for (const source of sources) {
      const item = document.createElement('div'); item.className = 'source-card';
      const top = document.createElement('div'); top.className = 'source-heading';
      const name = document.createElement('input'); name.value = source.label; name.maxLength = 100;
      name.id = `source-name-${source.id}`;
      name.className = 'source-name'; name.setAttribute('aria-label', t('settings.sourceName')); name.disabled = running;
      name.onchange = () => {if (name.value !== source.label) void this.action('rename_source', {id: source.id, label: name.value});};
      name.onkeydown = event => {
        if (event.key === 'Escape') {name.value = source.label; name.blur();}
        if (event.key === 'Enter') name.blur();
      };
      const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.className = 'switch';
      toggle.id = `source-enabled-${source.id}`;
      toggle.checked = source.enabled; toggle.setAttribute('aria-label', t('settings.enableSource', {name: source.label}));
      toggle.onchange = () => void this.action('source_enabled', {id: source.id, enabled: toggle.checked});
      top.append(name, toggle);
      const path = document.createElement('p'); path.className = 'source-path'; path.textContent = source.codex_home;
      const health = document.createElement('p'); health.className = 'source-health';
      health.textContent = t(!source.enabled ? 'settings.sourceDisabled' : source.warning ? 'settings.sourceWarning' : source.last_sync ? 'settings.sourceConnected' : 'settings.sourcePending');
      item.append(top, path, health); container.append(item);
    }
    localize(container);
  }
}
