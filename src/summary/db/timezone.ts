// 지정 시간대의 일·월 집계 키와 해당 기간의 UTC 경계를 계산한다.
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  // [시간대 정책] 시간대별 포매터를 재사용하고 등록 순서가 가장 오래된 항목부터 제거해 16개로 제한한다.
  const cached = formatters.get(timezone);
  if (cached) return cached;
  const value = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  if (formatters.size >= 16) formatters.delete(formatters.keys().next().value!);
  formatters.set(timezone, value);
  return value;
}

/**
 * 책임: UTC 시각을 지정 시간대의 일·월 집계 키로 변환한다.
 * 알고리즘: 최대 16개로 제한한 Intl formatter cache에서 날짜 요소를 얻어 연·월·일 문자열을 조합한다.
 */
export function calendarPeriod(timestamp: number, timezone: string, unit: 'day' | 'month'): string {
  // [시간대 정책] 지정 시간대의 달력에서 연·월·일을 추출하고 월 단위에서는 일을 생략한다.
  const parts = formatter(timezone).formatToParts(new Date(timestamp));
  const part = (name: Intl.DateTimeFormatPartTypes): string => parts.find(item => item.type === name)!.value;
  const month = `${part('year')}-${part('month')}`;
  return unit === 'month' ? month : `${month}-${part('day')}`;
}

/**
 * 책임: DST와 자정 오프셋 변화를 포함한 현지 기간의 UTC 경계를 구한다.
 * 알고리즘: 달력 입력을 검증한 뒤 시작일·다음 경계일 각각의 전후 36시간에서 현지 날짜가 바뀌는 첫 밀리초를 이진 탐색한다.
 */
export function periodBounds(period: string, timezone: string): { fromMs: number; toMs: number } {
  formatter(timezone); // Validate even if there are no rows to query.
  // [시간대 정책] 달력 입력을 검증하고 다음 날 또는 월의 시작일을 정한다.
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
    // [시간대 정책] UTC 자정 전후 36시간을 이진 탐색해 현지 자정이 건너뛰어진 날도 첫 밀리초를 찾는다.
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
