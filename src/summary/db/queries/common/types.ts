// SQL 텍스트·바인딩과 통계 집계 기준의 공통 계약을 정의한다.
import type { SQLInputValue } from 'node:sqlite';

export type UsageBasis = 'provider' | 'model';

/** Filter/period bindings come first; database methods append validated pagination bindings. */
export interface QuerySql {
  sql: string;
  values: SQLInputValue[];
}
