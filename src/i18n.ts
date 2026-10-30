import english from '../locales/en.json' with {type: 'json'};
export type MessageKey = keyof typeof english;
type Catalog = Record<MessageKey, string>;
// Add reviewed catalogs here. Search language is independent of interface language.
const catalogs: Record<string, Catalog> = {en: english};
let locale = 'en';
let messages: Catalog = english;
export function setLocale(value?: string) {
  try { locale = Intl.getCanonicalLocales(value || 'en')[0] || 'en'; }
  catch { locale = 'en'; }
  messages = catalogs[locale] || catalogs[locale.split('-')[0]] || english;
  if (typeof document !== 'undefined') document.documentElement.lang = catalogs[locale] ? locale : catalogs[locale.split('-')[0]] ? locale.split('-')[0] : 'en';
}
export function currentLocale() { return locale; }
export function t(key: MessageKey, values: Record<string, string | number> = {}) {
  return (messages[key] || english[key]).replace(/\{(\w+)\}/g, (match, name) =>
    values[name] === undefined ? match : String(values[name]));
}
export function localize(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach(element => {
    element.textContent = t(element.getAttribute('data-i18n') as MessageKey);
  });
  for (const attribute of ['aria-label', 'placeholder', 'title']) {
    root.querySelectorAll<HTMLElement>(`[data-i18n-${attribute}]`).forEach(element => {
      element.setAttribute(attribute, t(element.getAttribute(`data-i18n-${attribute}`) as MessageKey));
    });
  }
}
