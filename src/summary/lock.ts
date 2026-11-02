// 여러 VS Code 창의 통계 쓰기 작업을 직렬화하는 SQLite 잠금을 제공한다.
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SummaryError } from './jsonl';

/**
 * 책임: 여러 창의 통계 갱신이 동시에 쓰지 못하도록 잠금을 소유한다.
 * 알고리즘: 별도 SQLite 파일에 EXCLUSIVE 트랜잭션을 시도하고 busy·locked일 때 75ms 후 재시도하며 취소와 동기 해제를 처리한다. 잠금 파일은 삭제하지 않는다.
 */
export async function acquireRefreshLock(
  databasePath: string,
  signal?: AbortSignal,
  isCancelled?: () => boolean,
): Promise<() => void> {
  await mkdir(dirname(databasePath),{recursive:true});
  // Import only in the worker/acquisition path; the extension host never opens this connection.
  const {DatabaseSync}=await import('node:sqlite');
  const connection=new DatabaseSync(`${databasePath}.refresh-lock.sqlite`);
  try {
    connection.exec('PRAGMA busy_timeout=0');
    while (true) {
      if (signal?.aborted || isCancelled?.()) throw new SummaryError('interrupted');
      try {
        connection.exec('BEGIN EXCLUSIVE');
        let released=false;
        return () => {
          if (released) return;
          released=true;
          try { connection.exec('ROLLBACK'); } finally { connection.close(); }
        };
      } catch (error) {
        const code=(error as {errcode?:number}).errcode;
        if (code!==5 && code!==6) throw new SummaryError('lock-unavailable');
      }
      await delay(75);
    }
  } catch (error) { connection.close();throw error; }
}
