// DB 조회·저장에 사용하는 페이지 상한과 비음수 정수를 검증한다.
/** All summary pages share the same bounded limit. */
export function pageLimit(limit = 100): number {
  // [조회 정책] 기본 100건을 사용하고 페이지 크기는 1~1,000 사이 정수만 허용한다.
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new RangeError('Page limit must be an integer between 1 and 1000');
  }
  return limit;
}

export function nonnegative(value: number, name: string): number {
  // [검증 정책] 0 이상의 안전 정수만 허용하고 위반하면 해당 필드 이름을 알린다.
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a nonnegative integer`);
  return value;
}
