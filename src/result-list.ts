import {t,currentLocale} from './i18n.js';
import type { Hit, SearchController } from "./search-controller.js";

type SearchState = Pick<SearchController, "results" | "revision" | "frozen" | "selected" | "select">;
const renderedHits = new WeakMap<HTMLLIElement, Hit>();
const renderedLocales = new WeakMap<HTMLLIElement, string>();
let nextRowId = 0;

function date(value: string | null) {
  if (!value) return {label:"",iso:""};
  const d = /^\d+(\.\d+)?$/.test(value) ? new Date(Number(value)*(Number(value)<1e12?1000:1)) : new Date(value);
  return Number.isNaN(+d) ? {label:"",iso:""} : {label:new Intl.DateTimeFormat(currentLocale(),{day:"numeric",month:"short",year:"numeric"}).format(d),iso:d.toISOString()};
}
function color(key: string) { let hash=0; for(const char of key) hash=(hash*31+char.charCodeAt(0))|0; return ["#4388ef","#8b5ce5","#30b65a","#e0a52a","#d65e96"][Math.abs(hash)%5]; }

/** Keep click targets attached during selection and asynchronous search updates. */
export function renderResults(list: HTMLElement, input: HTMLInputElement, empty: HTMLElement,
  search: SearchState, activate: (key: string) => void) {
  const document = list.ownerDocument;
  const old = new Map(Array.from(list.children).map(el => [(el as HTMLElement).dataset.key!, el as HTMLLIElement]));
  const rows: HTMLLIElement[] = [];
  for (const hit of search.results) {
    let li = old.get(hit.key);
    if (!li) {
      li = document.createElement("li"); li.className="hit"; li.dataset.key=hit.key;
      li.id=`search-hit-${++nextRowId}`; li.setAttribute("role","option");
      li.onpointermove=() => { if(search.selected!==hit.key) search.select(hit.key); else search.frozen=true; };
      li.onpointerdown=e=>{ if(e.button!==0)return; e.preventDefault();search.select(hit.key); };
      li.onclick=e=>{ if(e.button===0)activate(hit.key); };
    }
    if (renderedHits.get(li) !== hit || renderedLocales.get(li) !== currentLocale()) {
      const main=document.createElement("div");main.className="hit-main";
      const title=document.createElement("div");title.className="hit-title";title.textContent=hit.title;main.append(title);
      const snippet=document.createElement("div");snippet.className="snippet";
      for(const segment of hit.snippet.segments){const part=document.createElement(segment.matched?"mark":"span");part.textContent=hit.snippet.provenance==="metadata"?t("search.metadataMatch"):segment.text;snippet.append(part);}
      main.append(snippet);
      const project=document.createElement("span");project.className="project";project.textContent=hit.project?.name||t('result.noProject');project.style.setProperty("--dot",color(hit.project?.id||""));
      const updated=document.createElement("time");updated.className="updated";const d=date(hit.updatedAt);updated.textContent=d.label;updated.dateTime=d.iso;updated.setAttribute("aria-label",d.label?t("result.updated",{date:d.label}):t("result.noDate"));
      li.replaceChildren(main,project,updated);
      renderedHits.set(li,hit); renderedLocales.set(li,currentLocale());
    }
    li.dataset.revision=String(search.revision);
    li.setAttribute("aria-selected",String(search.selected===hit.key));rows.push(li);
  }
  // A fragment + replaceChildren detaches even unchanged rows between down/up,
  // which can suppress the browser's subsequent click. Reconcile in place.
  for(const [index,row] of rows.entries()) {
    if(list.children[index]!==row)list.insertBefore(row,list.children[index]||null);
  }
  while(list.children.length>rows.length)list.lastElementChild!.remove();
  const selected=rows.find(row=>row.dataset.key===search.selected);
  if(selected)input.setAttribute("aria-activedescendant",selected.id);else input.removeAttribute("aria-activedescendant");
  empty.hidden=search.results.length>0;
}
