import { opendir, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setImmediate as yieldToWorker } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { SummaryDatabase } from './db';
import type { FileMetadata, ManifestRow } from './db';
import { SummaryStaging, type StagedFile } from './staging';
import { readJsonl, SummaryError } from './jsonl';
import { ClaudeParserAdapter, CodexCurrentParserAdapter } from './parsers';
import { acquireRefreshLock } from './lock';
import { applySessionNames, readSessionNames } from './names';
import type { SourceRoot, SummaryOptions, SummaryProgress, RefreshResult } from './types';

export const PARSER_VERSION = 14;
const componentPredicate = `EXISTS(SELECT 1 FROM component c WHERE c.provider=scan_files.provider
  AND (c.session_id=scan_files.session_id OR c.session_id=scan_files.old_session))`;

/**
 * 책임: 지원하는 로그 파일을 제한된 메모리로 발견한다.
 * 알고리즘: 디렉터리를 깊이 우선 순회하며 symlink를 제외하고 JSONL 및 허용된 Zstd 파일만 yield하며 매 단계 취소를 확인한다.
 */
async function* walk(directory: string, signal?: AbortSignal, compressed = false): AsyncGenerator<string> {
  if (signal?.aborted) throw new SummaryError('interrupted');
  const rootStat = await lstat(directory);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new SummaryError('source-root-not-directory');
  const handle = await opendir(directory, { bufferSize: 32 });
  for await (const item of handle) {
    if (signal?.aborted) throw new SummaryError('interrupted');
    if (item.isSymbolicLink()) continue;
    const path = join(directory,item.name);
    if (item.isDirectory()) yield* walk(path,signal,compressed);
    else if (item.isFile() && (item.name.toLowerCase().endsWith('.jsonl')
      || compressed && item.name.toLowerCase().endsWith('.jsonl.zst'))) yield path;
  }
}

/**
 * 책임: 원본 로그의 변경을 세션 단위 통계로 안전하게 반영한다.
 * 알고리즘: 전역 갱신 잠금 아래 파일 메타데이터를 배치 수집하고 변경·연결 세션을 재파싱한 뒤 성공한 연결 성분만 원자적으로 교체한다.
 */
export async function refreshSummary(
  database: SummaryDatabase,
  options: SummaryOptions,
  signal?: AbortSignal,
  progress?: (value: SummaryProgress) => void,
): Promise<RefreshResult> {
  const result: RefreshResult = { scanId:randomUUID(),discovered:0,parsed:0,reused:0,failed:0,bodyBytes:0,interrupted:false,completedAt:'' };
  const cancellation = options.cancellation ? new Int32Array(options.cancellation) : undefined;
  const collectCapabilities = options.collectCapabilities !== false;
  const retainDeletedSourceUsage = options.retainDeletedSourceUsage !== false;
  const isCancelled = (): boolean => Boolean(signal?.aborted || cancellation && Atomics.load(cancellation,0));
  if (isCancelled()) return {...result,interrupted:true,error:'interrupted',completedAt:new Date().toISOString()};
  let release: () => Promise<void>;
  try { release = await acquireRefreshLock(options.dbPath,signal,isCancelled); }
  catch (error) {
    return {...result,interrupted:true,failed:isCancelled()?0:1,error:error instanceof SummaryError?error.code:'lock-unavailable',completedAt:new Date().toISOString()};
  }
  let staging: SummaryStaging;
  let roots: SourceRoot[];
  try {
    staging = new SummaryStaging(database.connection,collectCapabilities);
    roots = options.roots.map(root => ({ ...root,path:resolve(root.path) }));
  } catch (error) { await release();throw error; }
  let phase: SummaryProgress['phase'] = 'scanning';
  let lastProgress = 0;
  const report = (force = false): void => {
    if (force || Date.now() - lastProgress > 100) {
      progress?.({phase,discovered:result.discovered,parsed:result.parsed,failed:result.failed,bodyBytes:result.bodyBytes});
      lastProgress = Date.now();
    }
  };
  const check = (): void => { if (isCancelled()) throw new SummaryError('interrupted'); };
  const failFile = (file: StagedFile, error: unknown): void => {
    const code = error instanceof SummaryError ? error.code : 'source-read-error';
    const offset = error instanceof SummaryError ? error.offset : 0;
    staging.fail(file.id);
    database.setManifestDiagnostic(file.id,code === 'interrupted' ? 'interrupted' : 'error',`parse: byte=${offset}`,code,offset);
    result.failed++;
  };
  try {
    report(true);
    await discoverSources();
    check();
    markMissingSources();
    await readSessionNames(staging,roots,isCancelled);
    check();
    phase = 'parsing'; report(true);
    for (const file of staging.files('changed=1 AND removed=0')) await parseSource(file);
    await expandAffectedSessions();
    staging.excludeVerifiedPrefixes();
    check();
    phase = 'committing'; report(true);
    await commitComponents();
    check();
    database.transaction(() => applySessionNames(database.connection));
    database.optimize();
  } catch (error) {
    result.interrupted = true;
    const code = isCancelled() ? 'interrupted' : error instanceof SummaryError ? error.code : 'source-discovery-error';
    result.error = code;
    for (const file of staging.files('(changed=1 OR parsed=1) AND failed=0 AND removed=0 AND settled=0')) {
      database.setManifestDiagnostic(file.id,code === 'interrupted' ? 'interrupted' : 'error','scan',code);
    }
    if (!isCancelled()) result.failed++;
  } finally {
    try { staging.close(); } finally { await release(); }
    phase = 'complete';result.completedAt = new Date().toISOString();report(true);
  }
  return result;

  async function discoverSources(): Promise<void> {
    // Discovery has bounded metadata batches. Body reads begin only after all roots complete.
    let batch: (FileMetadata & { previous?: ManifestRow })[] = [];
    let batchBytes = 0;
    /**
     * 책임: 발견한 파일의 변경 여부를 정하고 메타데이터 배치를 저장한다.
     * 알고리즘: manifest의 경로·크기·수정 시각·파서 버전을 비교해 재사용 여부를 표시하고 한 트랜잭션으로 staging에 반영한다.
     */
    const flush = (): void => {
      database.transaction(() => {
        for (const file of batch) {
          const previous = file.previous;
          const observed = previous ? (database.markSeen(previous.id,result.scanId),previous) : database.observeFile(file,result.scanId);
          const changed = !previous || previous.source_missing === 1 || previous.path !== file.path || previous.source_root !== file.source_root || previous.processing_status !== 'done' || previous.size_bytes !== file.size_bytes
            || previous.mtime_ms !== file.mtime_ms || previous.dev !== file.dev || previous.inode !== file.inode
            || previous.parser_version !== PARSER_VERSION || collectCapabilities && previous.capabilities_collected !== 1;
          staging.addFile({...file,id:observed.id,session_id:previous?.session_id ?? null},previous?.session_id ?? null,changed);
          if (!changed) result.reused++;
        }
      });
      batch = []; batchBytes = 0;
    };
    for (const root of roots) {
      try {
        for await (const path of walk(root.path,signal,root.provider === 'codex')) {
          check();
          const stat = await lstat(path);
          if (!stat.isFile() || stat.isSymbolicLink()) continue;
          const file: FileMetadata & { previous?: ManifestRow } = {provider:root.provider,source_root:root.path,path:resolve(path),session_id:null,
            size_bytes:stat.size,mtime_ms:stat.mtimeMs,dev:String(stat.dev),inode:String(stat.ino),parser_version:PARSER_VERSION};
          file.previous = database.findManifest(root.provider,file.path);
          const identityCandidates = !file.previous && process.platform !== 'win32'
            ? database.findIdentity(file.provider,file.dev,file.inode) : undefined;
          const movedSource = identityCandidates?.length === 1 ? identityCandidates[0] : undefined;
          if (movedSource && movedSource.last_seen_scan_id !== result.scanId) {
            try { await lstat(movedSource.path); }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') file.previous = movedSource;
            }
          }
          const bytes = Buffer.byteLength(file.path + file.source_root,'utf8') + 256;
          if (batch.length && (batch.length >= Math.min(options.batchSize ?? 256,256) || batchBytes + bytes > (options.metadataBytes ?? 256 * 1024))) flush();
          batch.push(file); batchBytes += bytes;
          result.discovered++;
          report();
        }
        flush();
      } catch (error) {
        flush();
        const missingEmptyRoot = (error as NodeJS.ErrnoException).code === 'ENOENT'
          && !database.connection.prepare('SELECT 1 FROM manifest WHERE provider=? AND source_root=? LIMIT 1').get(root.provider,root.path);
        if (!missingEmptyRoot) throw error;
      }
    }
  }

  function markMissingSources(): void {
    for (const root of roots) for (const file of database.unseenFiles(root.provider,root.path,result.scanId)) {
      staging.addFile(file,file.session_id,file.source_missing !== 1 || !retainDeletedSourceUsage,true);
    }
  }

  /**
   * 책임: 관측한 파일 스냅샷을 파싱하고 변경·실패를 진단으로 남긴다.
   * 알고리즘: 읽기 전후 파일 identity·크기·수정 시각을 검사하고 JSONL 청크를 TEMP에 적재하며, 실패한 세션의 기존 통계는 보존한다.
   */
  async function parseSource(file: StagedFile): Promise<void> {
    check();
    database.setManifestDiagnostic(file.id,'processing','parse: byte=0',null);
    const sink = { identity: staging.identity.bind(staging,file.id),event: staging.event.bind(staging,file.id) };
    const context = {provider:file.provider,path:file.path,sourceRoot:file.source_root,fileId:file.id,collectCapabilities};
    const parser = file.provider === 'claude' ? new ClaudeParserAdapter(context,sink) : new CodexCurrentParserAdapter(context,sink);
    try {
      const snapshot = await lstat(file.path);
      if (!snapshot.isFile() || snapshot.isSymbolicLink() || String(snapshot.dev) !== file.dev || String(snapshot.ino) !== file.inode || snapshot.size < file.size_bytes) {
        throw new SummaryError('file-replaced-during-read');
      }
      const read = await readJsonl(file.path,file.size_bytes,(row,offset) => parser.row(row,offset),
        {signal,isCancelled,maxLineBytes:options.maxLineBytes,onBytes:bytes => { result.bodyBytes += bytes; report(); },
          processBatch:parseRows => staging.batchEvents(parseRows)});
      const after = await lstat(file.path);
      if (String(after.dev) !== file.dev || String(after.ino) !== file.inode || after.size < file.size_bytes
          || after.size === file.size_bytes && after.mtimeMs !== file.mtime_ms) throw new SummaryError('file-rewritten-during-read');
      if (read.rows === 0) {
        recordEmptySource(file,read.partialLine);
        result.parsed++;
        return;
      }
      parser.finish();
      if (read.partialLine) staging.flag(file.id,'*','partial-line');
      result.parsed++;
    } catch (error) {
      const identity=parser.getIdentity();
      if (identity) staging.identity(file.id,identity);
      failFile(file,error);
      if (isCancelled()) throw error;
    }
    report();
  }

  function recordEmptySource(file: StagedFile, partialLine: boolean): void {
    database.connection.prepare('UPDATE scan_files SET parsed=1,failed=? WHERE id=?')
      .run(Number(partialLine && file.old_session !== null),file.id);
    if (partialLine) {
      // There is no complete provider record yet. Keep an accepted session intact without reporting a parse error.
      database.setManifestDiagnostic(file.id,'done','partial-line: waiting for newline',null);
      return;
    }
    if (file.old_session !== null) return;
    database.replaceSessions({sessions:[],summaries:[],files:[{...file,session_id:null}]});
    database.connection.prepare('UPDATE scan_files SET settled=1 WHERE id=?').run(file.id);
  }

  async function expandAffectedSessions(): Promise<void> {
    // Expands the set on disk: every surviving source of an affected logical session is reread.
    while (true) {
      staging.resolveLineage();
      // A new descendant can point to an unchanged parent whose root-session metadata is already accepted.
      // Verify only filename candidates; do not scan unrelated source bodies to guess lineage.
      let locatedParent = false;
      for (const candidate of staging.files(`provider='codex' AND parsed=0 AND failed=0 AND removed=0 AND EXISTS(
        SELECT 1 FROM scan_files child WHERE child.provider='codex' AND child.parsed=1 AND child.removed=0
        AND (child.parent_thread_id IS NOT NULL OR child.forked_from_id IS NOT NULL)
        AND instr(scan_files.path,coalesce(child.forked_from_id,child.parent_thread_id))>0
        AND NOT EXISTS(SELECT 1 FROM scan_files parent WHERE parent.provider='codex'
          AND parent.thread_id=coalesce(child.forked_from_id,child.parent_thread_id) AND parent.parsed=1 AND parent.removed=0))`)) {
        let metadataThread: string | undefined;
        try {
          await readJsonl(candidate.path,candidate.size_bytes,row => {
            const payload = row.payload as {id?:unknown;thread_id?:unknown}|undefined;
            if (row.type !== 'session_meta' || !payload) return false;
            const id = payload.id ?? payload.thread_id;
            if (typeof id === 'string') metadataThread=id;
            return false;
          },{signal,maxLineBytes:options.maxLineBytes,onBytes:bytes=>{result.bodyBytes+=bytes;}});
          const referenced = metadataThread && database.connection.prepare(`SELECT 1 FROM scan_files child
            WHERE child.provider='codex' AND child.parsed=1 AND child.removed=0 AND (child.parent_thread_id=? OR child.forked_from_id=?) LIMIT 1`)
            .get(metadataThread,metadataThread);
          if (referenced) { result.reused=Math.max(0,result.reused-1);await parseSource(candidate);locatedParent=true; }
        } catch { check(); }
      }
      if (locatedParent) staging.resolveLineage();
      // A source root excluded from this scan is not a deletion. Preserve its contribution
      // by including known sources when a shared logical session needs rebuilding.
      const excluded = database.connection.prepare(`SELECT m.* FROM manifest m JOIN affected a
        ON a.provider=m.provider AND a.session_id=m.session_id
        WHERE NOT EXISTS(SELECT 1 FROM scan_files f WHERE f.id=m.id) ORDER BY m.id LIMIT 100`).all() as unknown as ManifestRow[];
      for (const previous of excluded) {
        try {
          const stat = await lstat(previous.path);
          staging.addFile({...previous,size_bytes:stat.size,mtime_ms:stat.mtimeMs,dev:String(stat.dev),inode:String(stat.ino)},previous.session_id,true);
        } catch {
          if (previous.source_missing && retainDeletedSourceUsage) {
            staging.addFile(previous,previous.session_id,false,true);
            continue;
          }
          staging.addFile(previous,previous.session_id,true);
          failFile({...previous,old_session:previous.session_id,changed:1,parsed:0,removed:0,failed:0,project_key:null,project_name:null,session_name:null,thread_id:null,parent_thread_id:null,is_main:1,forked_from_id:null},new SummaryError('source-unavailable-outside-scan'));
        }
      }
      const next = staging.files(`parsed=0 AND failed=0 AND removed=0 AND EXISTS(
        SELECT 1 FROM affected a WHERE a.provider=scan_files.provider AND a.session_id=scan_files.session_id)`).next();
      if (!next.done) {
        result.reused = Math.max(0,result.reused - 1);
        await parseSource(next.value);
        continue;
      }
      if (!excluded.length) break;
    }
  }

  async function commitComponents(): Promise<void> {
    while (staging.nextComponent()) {
      await yieldToWorker();
      check();
      if (!staging.componentFailed()) {
        commitPreparedComponent();
      } else {
        preserveFailedComponent();
      }
      staging.finishComponent();
      report();
    }
    // Empty/new malformed files have no known session and cannot participate in a session replacement.
    for (const file of staging.files('removed=1 AND old_session IS NULL')) {
      database.replaceSessions({sessions:[],summaries:[],files:[],removedFileIds:[file.id]});
    }
  }

  function commitPreparedComponent(): void {
    staging.prepareSummaries();
    check();
    if (retainDeletedSourceUsage) {
      // Surviving subagents cannot recreate a deleted main request. Keep the stored
      // usable snapshot instead of inventing a replacement from orphaned events.
      database.connection.exec(`DELETE FROM prepared_turns WHERE has_main=0 AND EXISTS(
            SELECT 1 FROM scan_files f WHERE f.provider=prepared_turns.provider
              AND f.old_session=prepared_turns.session_id AND f.removed=1)`);
    }
    // Rootless subagents already have independent sessions; unresolved explicit roots remain diagnostics.
    const orphan = database.connection.prepare('SELECT file_id,byte_offset FROM prepared_turns WHERE has_main=0 LIMIT 1').get() as {file_id:number;byte_offset:number}|undefined;
    if (orphan) {
      const file = database.connection.prepare('SELECT * FROM scan_files WHERE id=?').get(orphan.file_id) as unknown as StagedFile;
      failFile(file,new SummaryError('missing-root-turn',orphan.byte_offset));
      return;
    }
    try {
      database.replaceSessions({sessions:staging.componentSessions(),summaries:staging.summaries(),
        preserveCapabilities:!collectCapabilities,
        retainDeletedSourceUsage,
        files:staging.files(`removed=0 AND ${componentPredicate}`),
        removedFileIds:(function* () { for (const file of staging.files(`removed=1 AND ${componentPredicate}`)) yield file.id; })()});
    } catch {
      for (const file of staging.files(componentPredicate)) failFile(file,new SummaryError('session-commit-error'));
    }
  }

  function preserveFailedComponent(): void {
    const failure = database.connection.prepare(`SELECT f.id,f.failed,m.last_error FROM scan_files f JOIN manifest m ON m.id=f.id
          WHERE f.failed=1 AND ${componentPredicate.replaceAll('scan_files.','f.')} LIMIT 1`).get() as {id:number;last_error:string|null}|undefined;
    if (failure?.last_error) for (const file of staging.files(`failed=0 AND ${componentPredicate}`)) {
      database.setManifestDiagnostic(file.id,'error','session: preserved',failure.last_error);
    }
    if (retainDeletedSourceUsage) {
      database.replaceSessions({retainDeletedSourceUsage:true,files:[],summaries:[],
        sessions:(function* () {
          for (const file of staging.files(`removed=1 AND old_session IS NOT NULL AND ${componentPredicate}`)) {
            yield {provider:file.provider,session_id:file.old_session!};
          }
        })(),
        removedFileIds:(function* () { for (const file of staging.files(`removed=1 AND ${componentPredicate}`)) yield file.id; })()});
    }
  }
}
