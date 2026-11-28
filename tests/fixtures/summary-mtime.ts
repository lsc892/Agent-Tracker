// 즉시 이어지는 테스트에서도 변경 없는 로그의 시각을 갱신 경계 밖에 둔다.
import { utimesSync } from 'node:fs';

export function ageLogFixtures(...paths: string[]): void {
  const time = new Date('2020-01-01T00:00:00Z');
  for (const path of paths) utimesSync(path, time, time);
}
