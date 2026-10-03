const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let value = formatters.get(timezone);
  if (!value) {
    value = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    // Bound this cache even when callers repeatedly change arbitrary timezones.
    if (formatters.size >= 16) formatters.delete(formatters.keys().next().value!);
    formatters.set(timezone, value);
  }
  return value;
}

export function calendarPeriod(timestamp: number, timezone: string, unit: 'day' | 'month'): string {
  const parts = formatter(timezone).formatToParts(new Date(timestamp));
  const part = (name: Intl.DateTimeFormatPartTypes): string => parts.find(item => item.type === name)!.value;
  const month = `${part('year')}-${part('month')}`;
  return unit === 'month' ? month : `${month}-${part('day')}`;
}

/** Convert local calendar boundaries, including 23/25-hour DST days, to a UTC range. */
export function periodBounds(period: string, timezone: string): { fromMs: number; toMs: number } {
  formatter(timezone); // Validate even if there are no rows to query.
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(period);
  if (!match) throw new RangeError('Expected YYYY-MM or YYYY-MM-DD');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3] ?? '1');
  const start = new Date(0);
  start.setUTCFullYear(year, month - 1, day);
  start.setUTCHours(0, 0, 0, 0);
  if (start.getUTCFullYear() !== year || start.getUTCMonth() !== month - 1 || start.getUTCDate() !== day) {
    throw new RangeError('Invalid calendar period');
  }
  const end = new Date(start);
  if (match[3]) end.setUTCDate(end.getUTCDate() + 1);
  else end.setUTCMonth(end.getUTCMonth() + 1);
  const boundary = (date: Date): number => {
    const localDate = date.toISOString().slice(0, 10);
    // Search for the first instant of the local date. This also handles zones
    // whose offset changes at midnight, where local 00:00 may not exist.
    let lower = date.getTime() - 36 * 60 * 60 * 1000;
    let upper = date.getTime() + 36 * 60 * 60 * 1000;
    while (lower < upper) {
      const middle = lower + Math.floor((upper - lower) / 2);
      if (calendarPeriod(middle, timezone, 'day') < localDate) lower = middle + 1;
      else upper = middle;
    }
    return lower;
  };
  return { fromMs: boundary(start), toMs: boundary(end) };
}
