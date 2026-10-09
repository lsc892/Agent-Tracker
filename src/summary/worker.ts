import { parentPort, workerData } from 'node:worker_threads';
import { SummaryDatabase, usageChartFromPage } from './db';
import { refreshSummary } from './scanner';
import { acquireRefreshLock } from './lock';
import type { SummaryOptions, UsageQuery, SourceRoot, RefreshResult, NameQuery } from './types';
import type { BillingMode, Provider } from './db/types';

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
      else if (message.method === 'configureCapabilities') {
        const config=message.payload as {enabled?:unknown};
        if (typeof config.enabled !== 'boolean') throw new Error('Invalid capability collection setting');
        options.collectCapabilities=config.enabled;
      } else if (message.method === 'refresh') {
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
        if (query.section === 'skills') {
          if (options.collectCapabilities === false) {
            result={rows:[],total:0,capabilitiesEnabled:false,coverage:database.diagnostics({limit:1,providers:query.providers}).counts};
          } else {
            const capabilities = Object.fromEntries((['skill','subagent','plugin','model'] as const)
              .map(category=>[category,database!.queryCapabilities(query,category,query.capabilityOffsets?.[category])]));
            result={rows:[],total:0,capabilities,capabilitiesEnabled:true,coverage:database.diagnostics({limit:1,providers:query.providers}).counts};
          }
        } else {
          const by = query.chartBy ?? 'provider';
          const rows = query.groupBy === 'turn' ? database.queryTurns(query,query,by)
          : database.queryUsage(query,query.groupBy === 'all' || !query.groupBy ? 'total' : query.groupBy,query.timezone ?? options.timezone ?? 'UTC',query,by);
          const total = query.groupBy === 'turn' ? database.queryTurnsCount(query,by)
          : database.queryUsageCount(query,query.groupBy === 'all' || !query.groupBy ? 'total' : query.groupBy,query.timezone ?? options.timezone ?? 'UTC',by);
          const chart = query.chartMetric ? usageChartFromPage(rows, total, query.groupBy ?? 'all', query.chartMetric, by, query.excludeEmptyUsage) : undefined;
          const cumulativeFilter = query.groupBy === 'day' || query.groupBy === 'month' ? {...query,unknownTime:'include' as const} : query;
          const cumulative = query.cumulativeBy ? database.queryCumulative(cumulativeFilter,query.cumulativeBy,query.cumulativeOffset) : undefined;
          const billing = query.includeCosts && query.provider && query.sessionId ? database.sessionBilling(query.provider,query.sessionId) : undefined;
          result = {rows,total,by,chart,cumulative,billing,coverage:database.diagnostics({limit:1,providers:query.providers}).counts};
        }
      } else if (message.method === 'setBilling') {
        const {provider,sessionId,mode} = message.payload as {provider:Provider;sessionId:string;mode:BillingMode};
        const release = await acquireRefreshLock(options.dbPath,AbortSignal.timeout(30_000));
        try { database.setSessionBilling(provider,sessionId,mode); } finally { await release(); }
      } else if (message.method === 'names') result = database.queryNames(message.payload as NameQuery);
      else if (message.method === 'diagnostics') result = {...database.diagnostics((message.payload ?? {}) as {limit?:number;offset?:number;afterId?:number;providers?:SourceRoot['provider'][]}),lastRefresh};
      else if (message.method === 'clearData') {
        // Use the same cross-window lock as scanning; never unlink a live DB or lock file.
        const release = await acquireRefreshLock(options.dbPath, AbortSignal.timeout(30_000));
        try { database.clearData(); lastRefresh = undefined; }
        finally { await release(); }
      }
      else if (message.method === 'dispose') { database.close();database=undefined; }
      else throw new Error('Unknown summary operation');
      port.postMessage({id:message.id,result});
    } catch { port.postMessage({id:message.id,errorKey:'dashboard.workerFailed'}); }
  });
});
