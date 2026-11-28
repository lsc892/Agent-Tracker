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
  // [조회 정책] 도구 사용량은 전용 조회로 보내고 턴 단위 사용량 요청은 일 단위로 처리한다.
  if (query.section === 'skills') return queryCapabilities(query, db);
  const by = query.chartBy ?? 'provider';
  const groupBy = query.groupBy === 'turn' ? 'day' : query.groupBy ?? 'all';
  const page = { ...query, tableSort: query.tableSort ?? { key: 'period' as const, direction: 'desc' as const } };
  const {rows,total} = db.queryUsagePage(query,groupBy,query.timezone ?? options.timezone ?? 'UTC',page,by);

  // [DTO 정책] 조회 페이지에서 차트를 만들고 비용을 보는 특정 세션에만 결제 유형을 붙인다.
  const chart = query.chartMetric ? usageChartFromPage(rows, total, groupBy, query.chartMetric, by, query.excludeEmptyUsage) : undefined;
  const billing = query.includeCosts && query.provider && query.sessionId ? db.sessionBillingOverride(query.provider,query.sessionId) : undefined;
  return {rows,total,by,chart,billing,coverage:db.diagnosticCounts(query.providers)};
}

function queryCapabilities(query: UsageQuery, db: SummaryDatabase): UsageResult {
  // [조회 정책] 수집이 꺼져 있으면 도구 행은 비우고 조회 범위의 진단 건수는 반환한다.
  if (options.collectCapabilities === false) {
    return {rows:[],total:0,capabilitiesEnabled:false,coverage:db.diagnosticCounts(query.providers)};
  }

  const capabilities = db.queryCapabilityPages(query);
  return {rows:[],total:0,capabilities,capabilitiesEnabled:true,coverage:db.diagnosticCounts(query.providers)};
}
port.on('message',(message: WorkerMessage) => {
  // [작업 순서 정책] 취소는 즉시 전달하고 다른 명령은 Promise 큐에 연결해 한 번에 하나씩 처리한다.
  if (message.method === 'cancel') { cancellation?.abort(); return; }
  queue = queue.then(() => run(message));
});

async function run(message: WorkerMessage): Promise<void> {
  try {
    // [실행 정책] 갱신 요청의 원본 경로·시간대를 먼저 적용하고 DB는 첫 명령을 처리할 때 연다.
    const refresh = message.method === 'refresh' ? (message.payload ?? {}) as RefreshPayload : undefined;
    if (refresh?.roots) options.roots = refresh.roots;
    if (refresh?.timezone) options.timezone = refresh.timezone;
    database ??= new SummaryDatabase({ databasePath: options.dbPath, timezone: options.timezone });
    let result: unknown;
    switch (message.method) {
      case 'initialize': break;
      case 'configureCapabilities': {
        // [설정 정책] 불리언으로 전달된 도구 수집 설정을 이후 작업에 적용한다.
        const config=message.payload as {enabled?:unknown};
        if (typeof config.enabled !== 'boolean') throw new Error('Invalid capability collection setting');
        options.collectCapabilities=config.enabled;
        break;
      }
      case 'configureRetention': {
        // [설정 정책] 불리언으로 전달된 소실 원본의 사용량 보존 설정을 이후 갱신에 적용한다.
        const config=message.payload as {enabled?:unknown};
        if (typeof config.enabled !== 'boolean') throw new Error('Invalid deleted source retention setting');
        options.retainDeletedSourceUsage=config.enabled;
        break;
      }
      case 'refresh': {
        const config = refresh ?? {};
        cancellation = new AbortController();
        // [갱신 정책] 공유 취소 버퍼와 취소 신호를 넘기고 진행 상태를 알린다.
        try {
          lastRefresh = await refreshSummary(database, {...options,cancellation:config.cancellation}, cancellation.signal,
            progress => port.postMessage({ progress }));
          result=lastRefresh;
        } finally {
          cancellation = undefined;
        }
        break;
      }
      case 'query': result = queryUsage((message.payload ?? {}) as UsageQuery, database); break;
      case 'setBilling': {
        const {provider,sessionId,mode} = message.payload as {provider:Provider;sessionId:string;mode:BillingMode | null};
        // [잠금 정책] 다른 창의 스캔과 겹치지 않도록 같은 잠금을 얻은 뒤 결제 유형을 갱신한다.
        const release = await acquireRefreshLock(options.dbPath,AbortSignal.timeout(30_000));
        try { database.setSessionBilling(provider,sessionId,mode); } finally { release(); }
        break;
      }
      case 'names': result = database.queryNames(message.payload as NameQuery); break;
      case 'diagnostics': result = {...database.diagnostics((message.payload ?? {}) as {limit?:number;offset?:number;afterId?:number;providers?:SourceRoot['provider'][]}),lastRefresh}; break;
      case 'clearData': {
        // [삭제 정책] 스캔과 같은 잠금을 얻고 열린 DB에서 데이터와 마지막 갱신 결과를 비운다.
        const release = await acquireRefreshLock(options.dbPath, AbortSignal.timeout(30_000));
        try { database.clearData(); lastRefresh = undefined; }
        finally { release(); }
        break;
      }
      case 'dispose': database.close(); database=undefined; break;
      default: throw new Error('Unknown summary operation');
    }

    // [통신 정책] 원래 요청 ID로 결과를 반환하고 실패하면 번역용 오류 키를 보낸다.
    port.postMessage({id:message.id,result});
  } catch { port.postMessage({id:message.id,errorKey:'dashboard.workerFailed'}); }
}
