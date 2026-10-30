import {App} from '@modelcontextprotocol/ext-apps';
import {SearchController, type Hit, type Api} from './search-controller.js';
import {renderResults} from './result-list.js';
import {t, setLocale, localize, currentLocale, type MessageKey} from './i18n.js';
import pkg from '../package.json' with {type: 'json'};
import {Settings} from './settings.js';
import {dateFilters, type SearchFilters, type DateSelection, type DatePreset} from './search-filters.js';
type Row = Record<string, any>;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = $<HTMLInputElement>('query');
let app: App | null = null, composing = false, page = 'search', hostTheme = '';
let scope: SearchFilters = {}, projects: Row[] = [], dates: DateSelection = {preset: 'any', from: '', through: ''};
let preferences: Row = {include_archived: true, density: 'comfortable', language: 'auto'}, hostLocale = navigator.language;
let searchMessage = '', scrollPosition = 0, settingsScope = '', settingsChanged = false, loadingProjects = false;
let projectRequestRevision = 0, projectRefreshQueued = false;
const api: Api = async (method, params = {}, signal) => {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (!app) throw Error('HOST_REQUIRED');
  const response = await app.callServerTool({name: method === 'search_chats' ? 'search_panel' : method, arguments: params});
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (response.isError) {
    let code = response._meta?.code || response.structuredContent?.code;
    if (!code) {try {code = JSON.parse((response.content?.find(c => c.type === 'text') as {text: string})?.text || '{}').code;} catch { /* Use the generic boundary code. */ }}
    throw Error(String(code || 'REQUEST_FAILED'));
  }
  return response.structuredContent || JSON.parse((response.content?.find(c => c.type === 'text') as {text: string})?.text || '{}');
};
const search = new SearchController(api, stage => {
  render(); if (stage === 'complete') $('results').scrollTop = 0;
}, text => {searchMessage = text; $('live-status').textContent = page === 'search' ? text : '';}, () => {
  const available = $('palette').clientHeight - document.querySelector<HTMLElement>('.input-row')!.offsetHeight - $('filter-bar').offsetHeight;
  const rowHeight = parseFloat(getComputedStyle($('results')).getPropertyValue('--result-row-height')) || 166;
  return Math.ceil(available / rowHeight) + 1;
});
const settings = new Settings(api, (value, fingerprint) => {
  if (settingsScope && fingerprint !== settingsScope) settingsChanged = true;
  settingsScope = fingerprint;
  preferences = value; document.body.dataset.density = value.density;
  setLocale(value.language === 'auto' ? hostLocale : value.language); localize();
  if (settingsChanged && page === 'search') {settingsChanged = false; updateSearch(); void loadProjects();}
  else {renderFilters(); render();}
});
function applyTheme() {
  document.body.dataset.theme = hostTheme || (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light');
  document.documentElement.style.colorScheme = document.body.dataset.theme;
}
function applyHost(context: Row) {
  if (context.theme) {hostTheme = context.theme; applyTheme();}
  if (context.locale) {hostLocale = context.locale; setLocale(preferences.language === 'auto' ? hostLocale : preferences.language); localize(); renderFilters(); render(); settings.render();}
  if (context.safeAreaInsets) for (const [side, value] of Object.entries(context.safeAreaInsets))
    document.documentElement.style.setProperty(`--safe-${side}`, `${value}px`);
  const deep = context['openai/deepLink'];
  if (deep?.url && typeof deep.url === 'string') {
    try {
      const url = new URL(deep.url, 'https://better-search.local');
      input.value = url.searchParams.get('q') || '';
      const project = url.searchParams.get('project');
      scope = project ? {project_key: project} : {}; dates = {preset: 'any', from: '', through: ''};
      showSearch(true);
    } catch { /* Ignore malformed optional deep links. */ }
  }
}
function projectName() {return projects.find(project => project.key === scope.project_key)?.name || t('search.project');}
function render() {
  renderResults($('results'), input, $('empty'), search, key => void activateResult(search.results.find(hit => hit.key === key)!));
  const noResults = search.state === 'ready' && search.results.length === 0;
  $('idle').hidden = search.results.length > 0 || noResults;
  $('empty').hidden = !noResults;
  const narrowed = Boolean(scope.updated_after || scope.updated_before);
  $('empty-message').textContent = narrowed ? t('search.noFilteredResults') : scope.project_key ? t('search.noProjectResults', {project: projectName()}) : t('search.noResults');
  $('empty-action').hidden = !scope.project_key && !narrowed;
  $('empty-action').textContent = t(narrowed ? 'search.clearFilters' : 'search.clearProject');
  $('search-recovery').hidden = search.recovery === 'none';
  $('retry-search').textContent = t(search.recovery === 'refresh' ? 'search.refresh' : 'search.retry');
  $('results').setAttribute('aria-busy', String(search.state === 'loading'));
  $('live-status').textContent = page === 'search' ? searchMessage : '';
}
function labelDate(value: string) {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0); date.setFullYear(year, month - 1, day); date.setHours(0, 0, 0, 0);
  return new Intl.DateTimeFormat(currentLocale(), {day: 'numeric', month: 'short', year: 'numeric'}).format(date);
}
function dateLabel() {
  const presetKeys: Partial<Record<DatePreset, MessageKey>> = {'7': 'filters.last7', '30': 'filters.last30', '90': 'filters.last90'};
  if (presetKeys[dates.preset]) return t(presetKeys[dates.preset]!);
  if (dates.from && dates.through) return t('filters.dateRange', {from: labelDate(dates.from), through: labelDate(dates.through)});
  return dates.from ? t('filters.since', {date: labelDate(dates.from)}) : t('filters.until', {date: labelDate(dates.through)});
}
function renderDateControl() {
  const select = $<HTMLSelectElement>('date-filter');
  let applied = select.querySelector<HTMLOptionElement>('option[value="applied-custom"]');
  // A separate selected value makes choosing Date range again reopen the editor.
  if (dates.preset === 'custom') {
    if (!applied) {applied = document.createElement('option'); applied.value = 'applied-custom'; applied.hidden = true; select.append(applied);}
    applied.textContent = t('filters.custom'); select.title = dateLabel();
  } else {applied?.remove(); select.title = t('filters.updated');}
  select.value = !$('date-range').hidden ? 'custom' : dates.preset === 'custom' ? 'applied-custom' : dates.preset;
}
function addChip(label: string, filter: string, remove: () => void) {
  const button = document.createElement('button'), text = document.createElement('span'), cross = document.createElement('span');
  button.className = 'chip'; button.setAttribute('aria-label', t('filters.remove', {filter}));
  text.className = 'chip-label'; text.textContent = label; cross.className = 'chip-close'; cross.textContent = '×'; cross.setAttribute('aria-hidden', 'true');
  button.append(text, cross); button.onclick = () => {remove(); closeDateRange(false); updateSearch(); input.focus();}; $('active-filters').append(button);
}
function renderFilters() {
  $('settings').title = t('nav.settings');
  const select = $<HTMLSelectElement>('project-filter');
  const options = [{key: '', name: t('filters.allProjects')}, ...projects];
  if (scope.project_key && !projects.some(project => project.key === scope.project_key)) options.push({key: scope.project_key, name: t('search.project')});
  select.replaceChildren(...options.map(project => {const option = document.createElement('option'); option.value = project.key; option.textContent = project.name; return option;}));
  select.value = scope.project_key || '';
  $('active-filters').replaceChildren();
  if (scope.project_key) addChip(projectName(), t('filters.project'), () => {delete scope.project_key;});
  if (scope.updated_after || scope.updated_before) addChip(dateLabel(), t('filters.updated'), () => {delete scope.updated_after; delete scope.updated_before; dates = {preset: 'any', from: '', through: ''};});
  $('active-filters').hidden = !$('active-filters').children.length;
  renderDateControl();
}
function currentFilters() {return {...scope, include_archived: preferences.include_archived};}
function updateSearch() {
  $('toast').hidden = true; $('clear').hidden = !input.value;
  renderFilters(); scrollPosition = 0; $('results').scrollTop = 0;
  search.begin(input.value, currentFilters(), composing);
}
function showSearch(force = false) {
  const returning = page === 'settings';
  page = 'search'; $('palette').hidden = false; $('settings-page').hidden = true;
  $('settings').hidden = false;
  $('settings').setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-expanded', 'true'); input.focus({preventScroll: true});
  $('clear').hidden = !input.value; renderFilters();
  if (force || settingsChanged) {settingsChanged = false; updateSearch();}
  else {const restarted = search.resume(input.value, currentFilters(), composing); if (returning && !restarted) $('results').scrollTop = scrollPosition;}
  render();
  if (returning) void loadProjects();
}
function clearSearch() {input.value = ''; input.focus(); updateSearch();}
function toast(text: string) {$('toast').textContent = text; $('toast').hidden = false;}
async function activateResult(hit: Hit) {
  if (!hit) return;
  const action = hit.navigation;
  if (action.kind !== 'open-original' || !action.url || !/^codex:\/\/threads\/[A-Za-z0-9_-]{1,100}$/.test(action.url)) {
    toast(t('navigation.unavailable')); return;
  }
  try {if (!app || (await app.openLink({url: action.url})).isError) throw Error('OPEN_FAILED');}
  catch {toast(t('navigation.failed'));}
}
async function loadProjects() {
  if (!app) return;
  const revision = ++projectRequestRevision;
  if (loadingProjects) {projectRefreshQueued = true; return;}
  loadingProjects = true; $<HTMLButtonElement>('retry-projects').disabled = true;
  try {
    const tree = await api('search_filters');
    if (revision === projectRequestRevision) {projects = tree.projects || []; $('project-error').hidden = true; renderFilters();}
  } catch {if (revision === projectRequestRevision) $('project-error').hidden = false;}
  finally {
    loadingProjects = false; $<HTMLButtonElement>('retry-projects').disabled = false;
    if (projectRefreshQueued) {projectRefreshQueued = false; void loadProjects();}
  }
}
function closeDateRange(focus = true) {
  $('date-range').hidden = true;
  renderDateControl();
  if (focus) $('date-filter').focus();
}
function openDateRange() {
  $<HTMLInputElement>('date-from').value = dates.from;
  $<HTMLInputElement>('date-through').value = dates.through;
  $('date-error').hidden = true;
  $('date-range').hidden = false; $('date-from').focus();
}
function applyDates(selection: DateSelection) {
  try {
    const result = dateFilters(selection);
    scope = {...(scope.project_key ? {project_key: scope.project_key} : {}), ...result.filters};
    dates = result.selection; closeDateRange(false); updateSearch(); input.focus();
  } catch {
    $('date-error').textContent = t('filters.invalidDates'); $('date-error').hidden = false;
  }
}
async function init() {
  setLocale(navigator.language); localize(); applyTheme(); renderFilters();
  matchMedia('(prefers-color-scheme:dark)').addEventListener('change', applyTheme);
  input.oninput = updateSearch;
  input.addEventListener('compositionstart', () => {composing = true; updateSearch();});
  input.addEventListener('compositionend', () => {composing = false; updateSearch();});
  $('clear').onclick = clearSearch;
  $<HTMLSelectElement>('project-filter').onchange = event => {const value = (event.target as HTMLSelectElement).value; if (value) scope.project_key = value; else delete scope.project_key; closeDateRange(false); updateSearch(); input.focus();};
  $('cancel-dates').onclick = () => closeDateRange();
  $<HTMLSelectElement>('date-filter').onchange = event => {
    const value = (event.target as HTMLSelectElement).value;
    if (value === 'applied-custom') return;
    const preset = value as DatePreset;
    if (preset === 'custom') openDateRange(); else applyDates({preset, from: '', through: ''});
  };
  $('date-range').onsubmit = event => {event.preventDefault(); applyDates({preset: 'custom', from: $<HTMLInputElement>('date-from').value, through: $<HTMLInputElement>('date-through').value});};
  $('retry-projects').onclick = () => void loadProjects();
  $('retry-search').onclick = () => {search.retry(); input.focus();};
  $('empty-action').onclick = () => {scope = {}; dates = {preset: 'any', from: '', through: ''}; closeDateRange(false); updateSearch(); input.focus();};
  $('results').onscroll = () => {const list = $('results'); if (page === 'search' && list.scrollHeight - list.scrollTop - list.clientHeight < 100) void search.loadMore();};
  $('settings').onclick = () => {
    if (page === 'settings') {showSearch(); return;}
    scrollPosition = $('results').scrollTop; search.suspend(); closeDateRange(false);
    page = 'settings'; $('palette').hidden = true; $('settings-page').hidden = false; $('live-status').textContent = ''; $('toast').hidden = true;
    $('settings').hidden = true;
    $('settings').setAttribute('aria-expanded', 'true');
    $('settings-page').querySelector<HTMLButtonElement>('.back')!.focus(); void settings.load().catch(() => {});
  };
  document.querySelectorAll<HTMLButtonElement>('.back').forEach(button => button.onclick = () => showSearch());
  document.addEventListener('keydown', event => {
    if (event.isComposing || composing) return;
    if (event.key === 'Escape' && page === 'search') {
      event.preventDefault(); event.stopPropagation();
      if (!$('date-range').hidden) closeDateRange(); else clearSearch(); return;
    }
    if (page !== 'search' || event.target !== input) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (event.key === 'ArrowDown' && search.results.at(-1)?.key === search.selected) void search.loadMore();
      search.move(event.key === 'ArrowDown' ? 1 : -1);
      document.getElementById(input.getAttribute('aria-activedescendant') || '')?.scrollIntoView({block: 'nearest'});
    }
    if (event.key === 'Enter') {event.preventDefault(); void activateResult(search.results.find(hit => hit.key === search.selected)!);}
  });
  render();
  try {
    if (window.parent === window) {toast(t('host.required')); return;}
    app = new App({name: 'BetterSearch', version: pkg.version}, {availableDisplayModes: ['inline']});
    app.onhostcontextchanged = applyHost; await app.connect();
    const context = app.getHostContext(); if (context) applyHost(context);
    await settings.load().catch(() => {});
    showSearch(); void loadProjects();
    setInterval(() => {if (!document.hidden && page === 'settings') void settings.load().catch(() => {});}, 2000);
  } catch {toast(t('host.unsupported'));}
}
void init();
