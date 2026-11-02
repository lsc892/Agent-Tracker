// DB 조회·저장에 사용하는 페이지 상한과 비음수 정수를 검증한다.
/** All summary pages share the same bounded limit. */
export function pageLimit(limit = 100): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new RangeError('Page limit must be an integer between 1 and 1000');
  }
  return limit;
}

export function nonnegative(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a nonnegative integer`);
  return value;
}
