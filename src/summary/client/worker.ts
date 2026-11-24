// 통계 Worker에서 호스트 명령을 받아 DB 조회·갱신·설정·삭제를 실행한다.
import { parentPort, workerData } from 'node:worker_threads';
import { SummaryDatabase, usageChartFromPage } from '../db';
import { refreshSummary } from '../scanner';
import { acquireRefreshLock } from '../scanner/lock';
import type { RefreshOptions } from './refresh';
import type { SummaryOptions, UsageQuery, UsageResult, SourceRoot, RefreshResult, NameQuery } from '../types';
import type { BillingMode, Provider } from '../db/types';

if (!parentPort) throw new Error('Summary worker requires a parent');
const port = parentPort;
const options = workerData as SummaryOptions;
let database: SummaryDatabase | undefined;
let cancellation: AbortController | undefined;
let queue = Promise.resolve();
let lastRefresh: RefreshResult | undefined;
type WorkerMessage = {id?:number;method:string;payload?:unknown};
type RefreshPayload = RefreshOptions & { cancellation?: SharedArrayBuffer };

function queryUsage(query: UsageQuery, db: SummaryDatabase): UsageResult {
  if (query.section === 'skills') return queryCapabilities(query, db);
  const by = query.chartBy ?? 'provider';
  const groupBy = query.groupBy === 'turn' ? 'day' : query.groupBy ?? 'all';
  const page = { ...query, tableSort: query.tableSort ?? { key: 'period' as const, direction: 'desc' as const } };
  const {rows,total} = db.queryUsagePage(query,groupBy,query.timezone ?? options.timezone ?? 'UTC',page,by);
  const chart = query.chartMetric ? usageChartFromPage(rows, total, groupBy, query.chartMetric, by, query.excludeEmptyUsage) : undefined;
  const billing = query.includeCosts && query.provider && query.sessionId ? db.sessionBilling(query.provider,query.sessionId) : undefined;
  return {rows,total,by,chart,billing,coverage:db.diagnosticCounts(query.providers)};
}

function queryCapabilities(query: UsageQuery, db: SummaryDatabase): UsageResult {
  if (options.collectCapabilities === false) {
    return {rows:[],total:0,capabilitiesEnabled:false,coverage:db.diagnosticCounts(query.providers)};
  }
  const capabilities = Object.fromEntries((['skill','subagent','plugin','model'] as const)
    .map(category=>[category,db.queryCapabilities(query,category,query.capabilityOffsets?.[category],query.capabilityLimits?.[category] ?? query.limit)])) as
    NonNullable<UsageResult['capabilities']>;
  return {rows:[],total:0,capabilities,capabilitiesEnabled:true,coverage:db.diagnosticCounts(query.providers)};
}
/**
 * 책임: Worker 안에서 DB 작업을 직렬화하고 통계 결과를 반환한다.
 * 알고리즘: 취소는 즉시 전달하고 조회와 변경은 큐에서 실행한다. 갱신 중에는 고정된 메모리 조회 결과만 진행 알림으로 전달한다.
 */
port.on('message',(message: WorkerMessage) => {
  if (message.method === 'cancel') { cancellation?.abort(); return; }
  queue = queue.then(() => run(message));
});

async function run(message: WorkerMessage): Promise<void> {
  try {
    const refresh = message.method === 'refresh' ? (message.payload ?? {}) as RefreshPayload : undefined;
    if (refresh?.roots) options.roots = refresh.roots;
    if (refresh?.timezone) options.timezone = refresh.timezone;
    database ??= new SummaryDatabase({ databasePath: options.dbPath, timezone: options.timezone });
    let result: unknown;
    switch (message.method) {
      case 'initialize': break;
      case 'configureCapabilities': {
        const config=message.payload as {enabled?:unknown};
        if (typeof config.enabled !== 'boolean') throw new Error('Invalid capability collection setting');
        options.collectCapabilities=config.enabled;
        break;
      }
      case 'configureRetention': {
        const config=message.payload as {enabled?:unknown};
        if (typeof config.enabled !== 'boolean') throw new Error('Invalid deleted source retention setting');
        options.retainDeletedSourceUsage=config.enabled;
        break;
      }
      case 'refresh': {
        const config = refresh ?? {};
        cancellation = new AbortController();
        let recentUsage: UsageResult | undefined;
        const preview = config.recentUsage && {
          ...config.recentUsage,
          onReady: (snapshot: SummaryDatabase) => {
            recentUsage = queryUsage({
              ...config.recentUsage, timezone: options.timezone, groupBy: 'day', chartMetric: 'tokens',
              limit: 100, unknownTime: 'exclude',
            }, snapshot);
          },
        };
        try {
          lastRefresh = await refreshSummary(database, {...options,cancellation:config.cancellation}, cancellation.signal,
            progress => {
              port.postMessage({ progress: recentUsage ? { ...progress, recentUsage } : progress });
              recentUsage = undefined;
            }, preview);
          result=lastRefresh;
        } finally {
          cancellation = undefined;
        }
        break;
      }
      case 'query': result = queryUsage((message.payload ?? {}) as UsageQuery, database); break;
      case 'setBilling': {
        const {provider,sessionId,mode} = message.payload as {provider:Provider;sessionId:string;mode:BillingMode};
        const release = await acquireRefreshLock(options.dbPath,AbortSignal.timeout(30_000));
        try { database.setSessionBilling(provider,sessionId,mode); } finally { release(); }
        break;
      }
      case 'names': result = database.queryNames(message.payload as NameQuery); break;
      case 'diagnostics': result = {...database.diagnostics((message.payload ?? {}) as {limit?:number;offset?:number;afterId?:number;providers?:SourceRoot['provider'][]}),lastRefresh}; break;
      case 'clearData': {
        // Use the same cross-window lock as scanning; never unlink a live DB or lock file.
        const release = await acquireRefreshLock(options.dbPath, AbortSignal.timeout(30_000));
        try { database.clearData(); lastRefresh = undefined; }
        finally { release(); }
        break;
      }
      case 'dispose': database.close(); database=undefined; break;
      default: throw new Error('Unknown summary operation');
    }
    port.postMessage({id:message.id,result});
  } catch { port.postMessage({id:message.id,errorKey:'dashboard.workerFailed'}); }
}
