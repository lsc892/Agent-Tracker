// 파일을 한 번 읽으며 winner DTO를 갱신하고 관련 원본의 최종 값만 저장한다.
import { opendir, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setImmediate as yieldToWorker } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { SummaryDatabase } from '../db';
import type { FileMetadata, ManifestRow, Provider } from '../db/types';
import { SummaryError } from '../jsonl';
import { SourceEvidence, StreamingAggregation, type StreamingAggregateFile, type MemoryAggregateResult } from '../aggregation/memoryAggregate';
import { SourceWinners } from '../aggregation/sourceWinners';
import { groupParents } from '../aggregation/parentGroups';
import { acquireRefreshLock } from './lock';
import { includesSourceSnapshot } from './sourceFingerprint';
import { readSource, sqlText } from './sourceReader';
import { readNames } from './names';
import { addMember, removeMember, OrderedGroups, SourceQueue } from './worklist';
import { StageProfiler, type ScanStage, type StorageStage } from '../profiling';
import type { ParsedIdentity, SummaryOptions, SummaryProgress, RefreshResult } from '../types';

export const PARSER_VERSION = 17;

interface PreparedSource {
  identity: ParsedIdentity;
  evidence: SourceEvidence;
  winners: SourceWinners;
  partialLine: boolean;
  sourceIdentity: string;
  contentHash: string;
}
interface FileState extends FileMetadata {
  id: number;
  previous?: ManifestRow;
  changed: boolean;
  removed: boolean;
  selected: boolean;
  prepared?: PreparedSource;
  session: string | null;
  error?: SummaryError;
  settled?: boolean;
  attempted?: boolean;
  sequence?: number;
  deferred?: boolean;
}

const fingerprint = (file: FileMetadata): string => JSON.stringify([file.provider, file.path, file.source_root,
  file.size_bytes, file.mtime_ms, file.dev, file.inode, file.parser_version]);
const key = (provider: Provider, session: string): string => JSON.stringify([provider, sqlText(session)]);

async function* walk(directory: string, check: () => void, compressed: boolean): AsyncGenerator<string> {
  check();
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new SummaryError('source-root-not-directory');
  const handle = await opendir(directory, { bufferSize: 32 });
  for await (const entry of handle) {
    check();
    if (entry.isSymbolicLink())
      continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      yield* walk(path, check, compressed);
    else if (entry.isFile() && (entry.name.toLowerCase().endsWith('.jsonl')
      || compressed && entry.name.toLowerCase().endsWith('.jsonl.zst')))
      yield path;
  }
}

/** 파일 한 번 읽기 → 그룹 winner DTO 갱신·패자 폐기 → 성분별 최종 저장. */
export async function refreshSummary(
  database: SummaryDatabase, options: SummaryOptions, signal?: AbortSignal,
  progress?: (value: SummaryProgress) => void,
): Promise<RefreshResult> {
  const started = performance.now();
  const scan = new StageProfiler<ScanStage>(), storage = new StageProfiler<StorageStage>();
  const result: RefreshResult = { scanId: randomUUID(), discovered: 0, parsed: 0, reused: 0, failed: 0,
    bodyBytes: 0, interrupted: false, completedAt: '', timings: { totalMs: 0, scan: scan.timings, storage: storage.timings } };
  const cancellation = options.cancellation ? new Int32Array(options.cancellation) : undefined;
  const cancelled = (): boolean => Boolean(signal?.aborted || cancellation && Atomics.load(cancellation, 0));
  const check = (): void => {
    if (cancelled())
      throw new SummaryError('interrupted');
  };
  let phase: SummaryProgress['phase'] = 'scanning', lastProgress = 0, release: (() => void) | undefined;
  const report = (force = false): void => {
    if (force || Date.now() - lastProgress > 100) {
      progress?.({ phase, discovered: result.discovered, parsed: result.parsed, failed: result.failed, bodyBytes: result.bodyBytes });
      lastProgress = Date.now();
    }
  };
  const files = new Map<number, FileState>(), affected = new Set<string>(), links = new Map<string, Set<string>>();
  const sessionFiles = new Map<string, Set<FileState>>(), identityFiles = new Map<string, Set<FileState>>();
  const codexFiles = new Set<FileState>(), preparedCodex = new Set<FileState>();
  const fileOrder = new Map<FileState, number>();
  const knownThreads = new Set<string>(), missingReferences = new Set<string>();
  const unsearchedReferences = new Set<string>();
  const parentReasons = new Map<FileState, Set<string>>();
  const relatedQueue = new SourceQueue<FileState>(), parentQueue = new SourceQueue<FileState>();
  let lineageDirty = false;
  let sequence = 0;
  const missingParents = new Set<number>();
  const reconnections: { old_id: number; new_id: number }[] = [];
  const collect = options.collectCapabilities !== false, retain = options.retainDeletedSourceUsage !== false;
  const roots = options.roots.map(root => ({ ...root, path: resolve(root.path) }));
  const affect = (provider: Provider, session: string | null | undefined): void => {
    if (!session) return;
    const value = key(provider, session);
    if (affected.has(value)) return;
    affected.add(value);
    for (const file of sessionFiles.get(value) ?? []) enqueueRelated(file);
  };
  const connect = (provider: Provider, a: string | null | undefined, b: string | null | undefined): void => {
    if (!a || !b || a === b)
      return;
    const left = key(provider, a), right = key(provider, b);
    for (const [from, to] of [[left, right], [right, left]]) {
      let set = links.get(from);
      if (!set)
        links.set(from, set = new Set());
      set.add(to);
    }
    affect(provider, a);
    affect(provider, b);
  };
  const fail = (file: FileState, error: unknown): void => {
    if (!file.error)
      result.failed++;
    file.error = error instanceof SummaryError ? error : new SummaryError('source-read-error');
    affect(file.provider, file.previous?.session_id);
    affect(file.provider, file.session);
  };
  try {
    check();
    release = await scan.measureAsync('lock', () => acquireRefreshLock(options.dbPath, signal, cancelled));
    report(true);
    await scan.measureAsync('discover', discoverSources);
    check();
    const names = await scan.measureAsync('names', () => readNames(roots, cancelled));
    phase = 'parsing';
    report(true);
    await scan.measureAsync('parseChanged', async () => {
      for (const file of [...files.values()].sort((a, b) => a.id - b.id))
        if (file.changed && !file.removed)
          await inspectSource(file);
    });
    await scan.measureAsync('expandRelated', expandRelatedSources);
    scan.measure('resolveParents', resolveParentRequests);
    await scan.measureAsync('reconnect', reconnectSources);
    check();
    const aggregated = await scan.measureAsync('aggregate', () => collectWinners(names));
    phase = 'committing';
    report(true);
    check();
    await scan.measureAsync('commitComponents', () => commitComponents(aggregated));
    scan.measure('finishScan', () => finishScan(names));
    scan.measure('optimize', () => database.optimize());
  }
  catch (error) {
    result.interrupted = true;
    result.error = cancelled() ? 'interrupted' : error instanceof SummaryError ? error.code : 'source-discovery-error';
    if (!cancelled())
      result.failed++;
    for (const file of files.values())
      if (!file.settled && (file.changed || file.prepared) && !file.removed) {
        file.error = new SummaryError(result.error);
        recordFailure(file);
      }
  }
  finally {
    release?.();
    result.completedAt = new Date().toISOString();
    phase = 'complete';
    report(true);
    result.timings!.totalMs = performance.now() - started;
  }
  return result;

  function ready(file: FileState): boolean {
    return files.get(file.id) === file && !file.attempted && !file.prepared && !file.error && !file.removed;
  }
  function enqueueRelated(file: FileState): void {
    if (ready(file)) relatedQueue.add(file);
  }
  function trackFile(file: FileState): void {
    const previous = files.get(file.id);
    const order = previous ? fileOrder.get(previous)! : fileOrder.size;
    if (previous) {
      removeMember(sessionFiles, key(previous.provider, previous.session ?? ''), previous);
      if (previous.source_identity)
        removeMember(identityFiles, JSON.stringify([previous.provider, previous.source_identity]), previous);
      codexFiles.delete(previous);
      fileOrder.delete(previous);
    }
    files.set(file.id, file);
    fileOrder.set(file, order);
    addMember(sessionFiles, key(file.provider, file.session ?? ''), file);
    if (file.source_identity)
      addMember(identityFiles, JSON.stringify([file.provider, file.source_identity]), file);
    if (file.provider === 'codex') codexFiles.add(file);
    if (affected.has(key(file.provider, file.session ?? ''))) enqueueRelated(file);
  }
  function setSession(file: FileState, session: string | null): void {
    if (file.session === session) return;
    removeMember(sessionFiles, key(file.provider, file.session ?? ''), file);
    file.session = session;
    addMember(sessionFiles, key(file.provider, session ?? ''), file);
    if (affected.has(key(file.provider, session ?? ''))) enqueueRelated(file);
  }
  function setSourceIdentity(file: FileState, identity: string | null | undefined): void {
    if (file.source_identity === identity) return;
    if (file.source_identity)
      removeMember(identityFiles, JSON.stringify([file.provider, file.source_identity]), file);
    file.source_identity = identity;
    if (identity) addMember(identityFiles, JSON.stringify([file.provider, identity]), file);
  }
  function registerPrepared(file: FileState): void {
    const identity = file.prepared!.identity;
    knownThreads.add(identity.threadId);
    missingReferences.delete(identity.threadId);
    if (file.provider !== 'codex') return;
    preparedCodex.add(file);
    lineageDirty = true;
    for (const reference of [identity.parentThreadId, identity.forkedFromId]) {
      if (!reference || knownThreads.has(reference) || missingReferences.has(reference)) continue;
      missingReferences.add(reference);
      unsearchedReferences.add(reference);
    }
  }
  function enqueueParents(): void {
    for (const reference of unsearchedReferences) {
      if (!missingReferences.has(reference)) continue;
      // manifest에 thread가 없으므로 새 미해결 참조마다 기존 substring 후보를 한 번 찾는다.
      for (const candidate of codexFiles) {
        if (!ready(candidate) || !candidate.path.includes(reference)) continue;
        let reasons = parentReasons.get(candidate);
        if (!reasons) parentReasons.set(candidate, reasons = new Set());
        reasons.add(reference);
        parentQueue.add(candidate);
      }
    }
    unsearchedReferences.clear();
  }

  async function discoverSources(): Promise<void> {
    const manifest = database.connection.prepare('SELECT * FROM manifest ORDER BY id').all() as unknown as ManifestRow[];
    const paths = new Map(manifest.map(file => [key(file.provider, file.path), file]));
    const inodes = new Map<string, Set<ManifestRow>>();
    if (process.platform !== 'win32')
      for (const file of manifest) addMember(inodes, JSON.stringify([file.provider, file.dev, file.inode]), file);
    let nextId = manifest.reduce((max, file) => Math.max(max, file.id), 0) + 1;
    const observed = new Set<number>();
    for (const root of roots) {
      try {
        for await (const path of walk(root.path, check, root.provider === 'codex')) {
          const stat = await lstat(path);
          if (!stat.isFile() || stat.isSymbolicLink())
            continue;
          let previous = paths.get(key(root.provider, resolve(path)));
          if (!previous && process.platform !== 'win32') {
            const candidates = [...inodes.get(JSON.stringify([root.provider, String(stat.dev), String(stat.ino)])) ?? []]
              .filter(file => !observed.has(file.id));
            if (candidates.length === 1) {
              try {
                await lstat(candidates[0].path);
              }
              catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                  previous = candidates[0];
              }
            }
          }
          const metadata: FileMetadata = { provider: root.provider, source_root: root.path, path: resolve(path), session_id: previous?.session_id ?? null,
            size_bytes: stat.size, mtime_ms: stat.mtimeMs, dev: String(stat.dev), inode: String(stat.ino), parser_version: PARSER_VERSION,
            capabilities_collected: collect ? 1 : 0, source_identity: previous?.source_identity, content_hash: previous?.content_hash };
          const changed = !previous || previous.source_missing === 1 || previous.processing_status !== 'done'
            || fingerprint(previous) !== fingerprint(metadata) || collect && previous.capabilities_collected !== 1
            || previous.session_id !== null && previous.size_bytes > 0 && (!previous.source_identity || !previous.content_hash);
          const file: FileState = { ...metadata, id: previous?.id ?? nextId++, previous, changed, removed: false, selected: true, session: metadata.session_id };
          trackFile(file);
          observed.add(file.id);
          result.discovered++;
          if (changed)
            affect(file.provider, file.session);
          else
            result.reused++;
          report();
        }
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT'
          || manifest.some(file => file.provider === root.provider && file.source_root === root.path))
          throw error;
      }
    }
    for (const previous of manifest)
      if (!observed.has(previous.id)) {
        const selected = roots.some(root => root.provider === previous.provider && root.path === previous.source_root);
        const file: FileState = { ...previous, id: previous.id, previous, changed: selected && (!previous.source_missing || !retain),
          removed: selected, selected, session: previous.session_id };
        trackFile(file);
        if (file.changed)
          affect(file.provider, file.session);
      }
  }
  async function commitComponents(aggregated: MemoryAggregateResult): Promise<void> {
    if (!affected.size) return;
    const memberGroups = new OrderedGroups(files.values(), file => [key(file.provider, file.session ?? ''),
      key(file.provider, file.previous?.session_id ?? '')]);
    const summaryGroups = new OrderedGroups(aggregated.summaries, row => [key(row.provider, row.session_id)]);
    const orphanGroups = new OrderedGroups(aggregated.orphans, row => [key(row.provider, row.session_id)]);
    for (const seed of [...affected].sort()) {
      if (!affected.has(seed))
        continue;
      const component = new Set([seed]), pending = [seed];
      for (let index = 0; index < pending.length; index++)
        for (const linked of links.get(pending[index]) ?? [])
          if (!component.has(linked)) {
            component.add(linked);
            pending.push(linked);
          }
      const members = memberGroups.members(component);
      await yieldToWorker();
      check();
      commitComponent(component, members, { summaries: summaryGroups.members(component), orphans: orphanGroups.members(component) });
      for (const value of component)
        affected.delete(value);
      report();
    }
  }

  function commitComponent(component: Set<string>, members: FileState[], aggregated: MemoryAggregateResult): void {
    if (members.some(file => file.deferred)) {
      settleDeferredComponent(members);
      return;
    }
    const sourceError = members.find(file => file.error)?.error;
    if (sourceError) {
      for (const file of members)
        if (!file.error)
          file.error = new SummaryError(sourceError.code);
      preserveMissingSources(members);
      return;
    }
    const missing = members.some(file => file.removed);
    const orphan = !retain || !missing ? aggregated.orphans[0] : undefined;
    if (orphan) {
      const file = files.get(orphan.fileId)!;
      fail(file, new SummaryError('missing-root-turn', orphan.offset));
      for (const sibling of members)
        if (!sibling.error)
          sibling.error = file.error;
      preserveMissingSources(members);
      return;
    }
    try {
      const summaries = aggregated.summaries.filter(row => !retain || !missing || row.hasMain);
      const memberIds = new Set(members.map(file => file.id));
      const sessions = [...component].map(value => {
        const [provider, session_id] = JSON.parse(value) as [Provider, string];
        return { provider, session_id };
      });
      database.replaceMemory({ sessions, summaries, files: members.filter(file => !file.removed).map(finalFile),
        removedFileIds: members.filter(file => file.removed).map(file => file.id),
        reconnectedFiles: reconnections.filter(link => memberIds.has(link.old_id)),
        preserveCapabilities: !collect, retainDeletedSourceUsage: retain, scanId: result.scanId }, storage);
      for (const file of members)
        file.settled = true;
    }
    catch (error) {
      for (const file of members)
        fail(file, error instanceof SummaryError ? error : new SummaryError('session-commit-error'));
      preserveMissingSources(members);
    }
  }

  function settleDeferredComponent(members: FileState[]): void {
    database.transaction(() => {
      for (const file of members) {
        file.settled = true;
        if (file.deferred)
          database.connection.prepare(`UPDATE manifest SET processing_status='done',
            processing_position='partial-line: waiting for newline',recorded_at=?,last_error=NULL WHERE id=?`)
            .run(new Date().toISOString(), file.id);
      }
    });
  }

  function finishScan(names: Map<string, string>): void {
    const unsettled = [...files.values()].filter(file => file.selected && file.attempted
      && !file.settled && !file.error && !file.removed && file.session === null);
    if (unsettled.length)
      database.replaceMemory({ sessions: [], summaries: [], files: unsettled.map(finalFile), scanId: result.scanId }, storage);
    const removedEmpty = [...files.values()].filter(file => file.removed && file.previous?.session_id === null);
    if (removedEmpty.length)
      database.replaceMemory({ sessions: [], summaries: [], files: [], removedFileIds: removedEmpty.map(file => file.id),
        retainDeletedSourceUsage: retain, scanId: result.scanId }, storage);
    database.transaction(() => {
      const update = database.connection.prepare('UPDATE sessions SET session_name=? WHERE provider=? AND session_id=? AND session_name IS NOT ?');
      for (const [value, name] of names) {
        const [provider, session] = JSON.parse(value) as [Provider, string];
        update.run(name, provider, session, name);
      }
      const seen = database.connection.prepare('UPDATE manifest SET last_seen_scan_id=? WHERE id=?');
      for (const file of files.values())
        if (file.selected && file.previous)
          seen.run(result.scanId, file.id);
    });
    for (const file of files.values())
      if (file.error)
        recordFailure(file);
  }
  function finalFile(file: FileState): FileMetadata & { id: number } {
    return { id: file.id, provider: file.provider, source_root: file.source_root, path: file.path,
      session_id: file.session, size_bytes: file.size_bytes, mtime_ms: file.mtime_ms, dev: file.dev, inode: file.inode,
      parser_version: file.parser_version, capabilities_collected: file.capabilities_collected,
      source_identity: file.prepared?.sourceIdentity ?? file.source_identity, content_hash: file.prepared?.contentHash ?? file.content_hash };
  }
  function sourceFlags(file: FileState): { rootId: string; flag: string }[] {
    const flags: { rootId: string; flag: string }[] = [];
    if (file.prepared?.partialLine)
      flags.push({ rootId: '*', flag: 'partial-line' });
    if (file.prepared?.identity.standaloneSubagent)
      flags.push({ rootId: '*', flag: 'standalone-subagent' });
    if (missingParents.has(file.id))
      flags.push({ rootId: '*', flag: 'missing-parent-agent' });
    return flags;
  }
  function recordFailure(file: FileState): void {
    let previous = database.findManifest(file.provider, file.path);
    if (!previous) {
      previous = database.observeFile(file, result.scanId);
      file.id = previous.id;
    }
    database.setManifestDiagnostic(previous.id, file.error!.code === 'interrupted' ? 'interrupted' : 'error', `parse: byte=${file.error!.offset}`, file.error!.code, file.error!.offset);
  }
  async function inspectSource(file: FileState): Promise<void> {
    check();
    if (file.attempted || file.prepared || file.error || file.removed)
      return;
    file.attempted = true;
    file.sequence = ++sequence;
    if (!file.changed && file.selected)
      result.reused = Math.max(0, result.reused - 1);
    if (!file.selected && !await refreshOutsideSource(file))
      return;
    const winners = new SourceWinners(file.provider), evidence = winners.evidence;
    const onIdentity = (identity: ParsedIdentity): void => { setSession(file, identity.sessionId); connect(file.provider, file.previous?.session_id, file.session); };
    try {
      const read = await scan.measureAsync('readSources', () => readSource(file, (event, index) => winners.add(event, index), { signal, cancelled,
        maxLineBytes: options.maxLineBytes, collectCapabilities: collect, onBytes: bytes => { result.bodyBytes += bytes; report(); }, onIdentity,
        onChild: (reference, rootId) => evidence.child(reference, rootId) }));
      result.parsed++;
      if (!read.rows) {
        if (read.partialLine && file.previous?.session_id) {
          file.deferred = true;
          return;
        }
        file.content_hash = null;
        setSourceIdentity(file, null);
        setSession(file, file.previous?.session_id ?? null);
        return;
      }
      setSession(file, read.identity!.sessionId);
      file.prepared = { identity: read.identity!, evidence, winners, partialLine: read.partialLine, sourceIdentity: read.sourceIdentity!, contentHash: read.contentHash };
      setSourceIdentity(file, read.sourceIdentity);
      file.content_hash = read.contentHash;
      registerPrepared(file);
      affect(file.provider, file.session);
      connect(file.provider, file.previous?.session_id, file.session);
    }
    catch (error) {
      fail(file, error);
      if (cancelled())
        throw error;
    }
  }

  async function refreshOutsideSource(file: FileState): Promise<boolean> {
    try {
      const stat = await lstat(file.path);
      file.size_bytes = stat.size;
      file.mtime_ms = stat.mtimeMs;
      file.dev = String(stat.dev);
      file.inode = String(stat.ino);
      return true;
    }
    catch (error) {
      const replacement = [...identityFiles.get(JSON.stringify([file.provider, file.source_identity])) ?? []]
        .some(candidate => candidate.prepared && !candidate.error && !candidate.removed);
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && (replacement || retain && file.previous?.source_missing)) {
        file.removed = true;
        file.changed = true;
        affect(file.provider, file.session);
        return false;
      }
      fail(file, new SummaryError('source-unavailable-outside-scan'));
      return false;
    }
  }

  async function collectWinners(names: Map<string, string>): Promise<MemoryAggregateResult> {
    const sources = [...files.values()].filter(file => !file.removed && !file.error && file.prepared && file.session)
      .sort((a, b) => a.sequence! - b.sequence!);
    const inputs: StreamingAggregateFile[] = sources.map(file => ({ id: file.id, provider: file.provider, session_id: file.session!,
      identity: { ...file.prepared!.identity, sessionName: names.get(key(file.provider, file.session!)) ?? file.prepared!.identity.sessionName },
      evidence: file.prepared!.evidence, flags: sourceFlags(file) }));
    const aggregation = new StreamingAggregation(inputs, collect);
    for (const file of sources) {
      check();
      for (const root of file.prepared!.winners.roots)
        aggregation.observeRoot(file.id, root);
      for (const { event, index } of file.prepared!.winners.events()) {
        if (file.prepared!.identity.standaloneSubagent && event.kind === 'turn')
          event.isMain = true;
        aggregation.add(file.id, event, index);
      }
    }
    return aggregation.finish();
  }
  function resolveLineage(): void {
    if (!lineageDirty) return;
    lineageDirty = false;
    missingParents.clear();
    const candidates = [...preparedCodex].filter(file => !file.removed && !file.error)
      .sort((a, b) => fileOrder.get(a)! - fileOrder.get(b)!);
    const { groups, unresolved } = groupParents(candidates.map(file => ({ id: file.prepared!.identity.threadId,
      parentId: file.prepared!.identity.parentThreadId, value: file })));
    const sessions = new Map<string, string | null>();
    for (const file of candidates) {
      const identity = file.prepared!.identity, group = groups.get(identity.threadId)!;
      if (!sessions.has(group.rootId)) {
        const targets = new Set(group.members.get(group.rootId)!.map(parent => parent.prepared!.identity.sessionId));
        sessions.set(group.rootId, targets.size === 1 ? targets.values().next().value! : null);
      }
      const target = sessions.get(group.rootId)!;
      const resolved = !unresolved.has(identity.threadId) && target !== null;
      if (!resolved)
        missingParents.add(file.id);
      const session = resolved ? target : identity.sessionId;
      if (file.session !== session) {
        connect(file.provider, file.session, session);
        setSession(file, session);
      }
    }
  }

  /** 자식 자체 요청 행 대신 검증된 생성 호출의 부모 요청에 사용량을 붙인다. */
  function resolveParentRequests(): void {
    const sources = [...preparedCodex].filter(file => !file.error && !file.removed)
      .sort((a, b) => fileOrder.get(a)! - fileOrder.get(b)!);
    const threads = new Map<string, FileState[]>();
    for (const file of sources) {
      const id = file.prepared!.identity.threadId, previous = threads.get(id);
      if (previous) previous.push(file); else threads.set(id, [file]);
    }
    const memo = new Map<number, string | null>(), visiting = new Set<number>();
    const resolve = (file: FileState): string | null => {
      if (memo.has(file.id)) return memo.get(file.id)!;
      if (visiting.has(file.id)) return null;
      visiting.add(file.id);
      const identity = file.prepared!.identity;
      const parents = threads.get(identity.parentThreadId ?? '') ?? [];
      const references = identity.agentPath ? [identity.threadId, identity.agentPath] : [identity.threadId];
      const roots = new Set<string | null>();
      for (const parent of parents) {
        const prepared = parent.prepared!;
        if (prepared.identity.rootlessSubagent) { roots.add(resolve(parent)); continue; }
        for (const reference of references)
          if (reference && prepared.evidence.childRequests.has(reference)) roots.add(prepared.evidence.childRequests.get(reference)!);
      }
      const target = roots.size === 1 ? roots.values().next().value! : null;
      visiting.delete(file.id); memo.set(file.id, target);
      return target;
    };
    for (const file of sources) {
      if (!file.prepared!.identity.rootlessSubagent) continue;
      if (file.prepared!.evidence.eventCount === 0) continue;
      const root = resolve(file);
      if (root === null || missingParents.has(file.id)) fail(file, new SummaryError('missing-root-turn'));
      else file.prepared!.identity.parentRootId = root;
    }
  }
  async function expandRelatedSources(): Promise<void> {
    while (true) {
      resolveLineage();
      enqueueParents();
      const parents: FileState[] = [];
      let candidate: FileState | undefined;
      while ((candidate = parentQueue.take())) {
        const reasons = parentReasons.get(candidate);
        parentReasons.delete(candidate);
        if (ready(candidate) && reasons && [...reasons].some(reference => missingReferences.has(reference)))
          parents.push(candidate);
      }
      if (parents.length) {
        // 새 참조가 생겨도 이번 반복 시작에 확정한 부모 batch의 id 순서를 먼저 보존한다.
        for (const file of parents)
          await inspectSource(file);
        continue;
      }
      let next: FileState | undefined;
      while ((candidate = relatedQueue.take()))
        if (ready(candidate) && affected.has(key(candidate.provider, candidate.session ?? ''))) {
          next = candidate;
          break;
        }
      if (!next) break;
      await inspectSource(next);
    }
  }
  async function reconnectSources(): Promise<void> {
    for (const file of files.values())
      if (file.prepared && !file.error && !file.removed) {
        const matching = [...identityFiles.get(JSON.stringify([file.provider, file.source_identity])) ?? []]
          .sort((a, b) => fileOrder.get(a)! - fileOrder.get(b)!);
        const active = matching.filter(item => !item.removed && !item.error);
        if (active.length !== 1)
          continue;
        for (const old of matching)
          if (old.removed && old.session === file.session && old.content_hash && old.size_bytes > 0) {
            try {
              if (await includesSourceSnapshot(file, old, { check, onBytes: bytes => { result.bodyBytes += bytes; report(); } }))
                reconnections.push({ old_id: old.id, new_id: file.id });
            }
            catch (error) {
              fail(file, error);
              if (cancelled())
                throw error;
              break;
            }
          }
      }
  }
  function preserveMissingSources(members: FileState[]): void {
    const removed = members.filter(file => file.removed);
    if (removed.length && retain)
      database.replaceMemory({ sessions: removed.filter(file => file.session).map(file => ({ provider: file.provider, session_id: file.session! })),
        summaries: [], files: [], removedFileIds: removed.map(file => file.id), retainDeletedSourceUsage: true, scanId: result.scanId }, storage);
  }
}
