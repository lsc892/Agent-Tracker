import { parentPort, workerData } from 'node:worker_threads';
import { SummaryDatabase } from './db';
import { refreshSummary } from './scanner';
import { acquireRefreshLock } from './lock';
import type { SummaryOptions, UsageQuery, SourceRoot, RefreshResult } from './types';

if (!parentPort) throw new Error('Summary worker requires a parent');
const port = parentPort;
const options = workerData as SummaryOptions;
let database: SummaryDatabase | undefined;
let cancellation: AbortController | undefined;
let queue = Promise.resolve();
let lastRefresh: RefreshResult | undefined;
port.on('message',(message: {id?:number;method:string;payload?:unknown}) => {
  if (message.method === 'cancel') { cancellation?.abort(); return; }
  queue = queue.then(async () => {
    try {
      database ??= new SummaryDatabase(options.dbPath);
      let result: unknown;
      if (message.method === 'initialize') result = undefined;
      else if (message.method === 'refresh') {
        const config = (message.payload ?? {}) as {roots?:SourceRoot[];timezone?:string;cancellation?:SharedArrayBuffer};
        if (config.roots) options.roots = config.roots;
        if (config.timezone) options.timezone = config.timezone;
        cancellation = new AbortController();
        try {
          lastRefresh = await refreshSummary(database,{...options,cancellation:config.cancellation},cancellation.signal,progress => port.postMessage({progress}));
          result=lastRefresh;
        }
        finally { cancellation = undefined; }
      } else if (message.method === 'query') {
        const query = (message.payload ?? {}) as UsageQuery;
        const rows = query.groupBy === 'turn' ? database.queryTurns(query,query)
          : database.queryUsage(query,query.groupBy === 'all' || !query.groupBy ? 'total' : query.groupBy,query.timezone ?? options.timezone ?? 'UTC',query);
        const total = query.groupBy === 'turn' ? database.queryTurnsCount(query)
          : database.queryUsageCount(query,query.groupBy === 'all' || !query.groupBy ? 'total' : query.groupBy,query.timezone ?? options.timezone ?? 'UTC');
        result = {rows,total,coverage:database.diagnostics({limit:1}).counts};
      } else if (message.method === 'diagnostics') result = {...database.diagnostics((message.payload ?? {}) as {limit?:number;offset?:number;afterId?:number}),lastRefresh};
      else if (message.method === 'clearData') {
        // Use the same cross-window lock as scanning; never unlink a live DB or lock file.
        const release = await acquireRefreshLock(options.dbPath, AbortSignal.timeout(30_000));
        try { database.clearData(); lastRefresh = undefined; }
        finally { await release(); }
      }
      else if (message.method === 'dispose') { database.close();database=undefined; }
      else throw new Error('Unknown summary operation');
      port.postMessage({id:message.id,result});
    } catch { port.postMessage({id:message.id,error:'Summary operation failed; check Diagnostics and source configuration.'}); }
  });
});
