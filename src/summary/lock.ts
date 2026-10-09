import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SummaryError } from './jsonl';

/**
 * The separate, table-free SQLite file holds an OS lock for the whole refresh.
 * It never locks the statistics DB, and the OS releases it if its worker exits.
 * Keep this file in place: unlinking a live lock file would split its identity.
 */
export async function acquireRefreshLock(
  databasePath: string,
  signal?: AbortSignal,
  isCancelled?: () => boolean,
): Promise<() => Promise<void>> {
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
        return async () => {
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
