export type SearchFilters = {project_key?: string; updated_after?: string; updated_before?: string};
export type DatePreset = 'any' | '7' | '30' | '90' | 'custom';
export type DateSelection = {preset: DatePreset; from: string; through: string};

export function calendarDate(date: Date) {
  return `${date.getFullYear().toString().padStart(4, '0')}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`;
}
function midnight(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw Error('INVALID_DATES');
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0); date.setFullYear(year, month - 1, day); date.setHours(0, 0, 0, 0);
  if (calendarDate(date) !== value || year < 1 || year > 9998) throw Error('INVALID_DATES');
  return date;
}

/** Freeze relative periods once, with local calendar boundaries that respect daylight saving. */
export function dateFilters(selection: DateSelection, now = new Date()): {filters: SearchFilters; selection: DateSelection} {
  let {preset, from, through} = selection;
  if (preset === 'any') return {filters: {}, selection: {preset, from: '', through: ''}};
  if (preset !== 'custom') {
    if (!['7', '30', '90'].includes(preset)) throw Error('INVALID_DATES');
    const first = new Date(now); first.setDate(first.getDate() - Number(preset) + 1);
    from = calendarDate(first); through = calendarDate(now);
  }
  if (!from && !through) throw Error('INVALID_DATES');
  const start = from ? midnight(from) : null, end = through ? midnight(through) : null;
  if (start && end && start > end) throw Error('INVALID_DATES');
  if (end) end.setDate(end.getDate() + 1);
  return {filters: {...(start ? {updated_after: start.toISOString()} : {}), ...(end ? {updated_before: end.toISOString()} : {})}, selection: {preset, from, through}};
}
