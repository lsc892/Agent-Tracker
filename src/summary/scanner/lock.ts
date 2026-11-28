// 여러 VS Code 창의 통계 쓰기 작업을 직렬화하는 SQLite 잠금을 제공한다.
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SummaryError } from '../jsonl';

/** 별도 SQLite 파일에서 갱신 잠금을 얻고 잠금을 푸는 함수를 반환한다. */
export async function acquireRefreshLock(
  databasePath: string,
  signal?: AbortSignal,
  isCancelled?: () => boolean,
): Promise<() => void> {
  await mkdir(dirname(databasePath),{recursive:true});
  // 잠금 연결은 갱신 Worker에서 열도록 SQLite 모듈을 잠금 획득 시점에 불러온다.
  const {DatabaseSync}=await import('node:sqlite');
  const connection=new DatabaseSync(`${databasePath}.refresh-lock.sqlite`);
  try {
    // [SQL 트랜잭션 정책] SQLite 대기 대신 75ms마다 EXCLUSIVE 잠금을 다시 시도하며 그 사이 취소를 확인한다.
    connection.exec('PRAGMA busy_timeout=0');
    while (true) {
      if (signal?.aborted || isCancelled?.()) throw new SummaryError('interrupted');
      try {
        connection.exec('BEGIN EXCLUSIVE');
        // [SQL 트랜잭션 정책] 롤백과 연결 닫기는 한 번만 수행하고 잠금 파일은 다음 갱신에도 사용한다.
        let released=false;
        return () => {
          if (released) return;
          released=true;
          try { connection.exec('ROLLBACK'); } finally { connection.close(); }
        };
      } catch (error) {
        // 다른 연결이 잠금을 사용 중인 경우에만 재시도한다.
        const code=(error as {errcode?:number}).errcode;
        if (code!==5 && code!==6) throw new SummaryError('lock-unavailable');
      }
      await delay(75);
    }
  } catch (error) { connection.close();throw error; }
}
