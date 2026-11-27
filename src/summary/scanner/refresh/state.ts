// 한 갱신의 파일 상태·관계 색인·큐를 소유하고 상태 변경 시 색인 일관성을 유지한다.
import type { SourceWinnersSnapshot } from '../../aggregation/sourceWinners';
import type { FileMetadata, SourceFileRow, Provider } from '../../db/types';
import { SummaryError } from '../../jsonl';
import type { ParsedIdentity, RefreshResult } from '../../types';
import { sqlText } from '../sourceReader';
import { addMember, removeMember, SourceQueue } from '../worklist';

export const PARSER_VERSION = 26;
export const sessionKey = (provider: Provider, session: string): string => JSON.stringify([provider, sqlText(session)]);

export interface PreparedSource {
  identity: ParsedIdentity;
  winners: SourceWinnersSnapshot;
  partialLine: boolean;
  parentRootId?: string;
}

export type StoredSource = FileMetadata & Pick<SourceFileRow, 'id' | 'source_missing' | 'processing_status'>;

/** 경로의 마지막 반영 시각과 재수집이 필요한 상태를 비교한다. */
export function needsSourceRead(file: Pick<FileMetadata, 'mtime_ms' | 'source_root'>,
  previous: StoredSource | undefined): boolean {
  // [재수집 정책] 수정 시각·원본 루트·파서 버전이 달라졌거나 마지막 처리가 완료되지 않은 파일을 다시 읽는다.
  return !previous || previous.mtime_ms !== file.mtime_ms || previous.source_root !== file.source_root
    || previous.source_missing === 1 || previous.processing_status !== 'done'
    || previous.parser_version !== PARSER_VERSION;
}

export interface FileState extends FileMetadata {
  id: number;
  size_bytes: number;
  previous?: StoredSource;
  changed: boolean;
  removed: boolean;
  selected: boolean;
  prepared?: PreparedSource;
  error?: SummaryError;
  settled?: boolean;
  attempted?: boolean;
  deferred?: boolean;
}

export type PreparedFile = FileState & { prepared: PreparedSource };

export function isPreparedFile(file: FileState): file is PreparedFile {
  return file.prepared !== undefined && !file.error && !file.removed;
}

/** Map·Set은 갱신당 한 번 만들고 책임별 모듈은 같은 상태를 사용한다. */
export class ScanState {
  readonly files = new Map<number, FileState>();
  readonly affected = new Set<string>();
  readonly links = new Map<string, Set<string>>();
  private readonly sessionFiles = new Map<string, Set<FileState>>();
  readonly codexFiles: FileState[] = [];
  private readonly preparedCodex: FileState[] = [];
  readonly preparedFiles: FileState[] = [];
  private readonly seenReferences = new Set<string>();
  readonly pendingReferences = new Set<string>();
  readonly relatedQueue = new SourceQueue<FileState>();
  readonly missingParents = new Set<number>();
  readonly savedSessionNames = new Map<string, string>();
  lineageDirty = false;
  private indexesEnabled = false;

  constructor(private readonly result: RefreshResult) {}

  ready(file: FileState): boolean {
    return !file.attempted && !file.error && !file.removed;
  }

  private enqueueRelated(file: FileState): void {
    if (this.ready(file)) this.relatedQueue.add(file);
  }

  affect(provider: Provider, session: string | null | undefined): void {
    if (!session) return;
    const value = sessionKey(provider, session);
    if (this.affected.has(value)) return;
    this.affected.add(value);
    for (const file of this.sessionFiles.get(value) ?? []) this.enqueueRelated(file);
  }

  connect(provider: Provider, a: string | null | undefined, b: string | null | undefined): void {
    if (!a || !b || a === b) return;
    const left = sessionKey(provider, a), right = sessionKey(provider, b);
    for (const [from, to] of [[left, right], [right, left]]) {
      let set = this.links.get(from);
      if (!set) this.links.set(from, set = new Set());
      set.add(to);
    }
    this.affect(provider, a);
    this.affect(provider, b);
  }

  fail(file: FileState, error: unknown): void {
    if (!file.error) this.result.failed++;
    file.error = error instanceof SummaryError ? error : new SummaryError('source-read-error');
    this.affect(file.provider, file.previous?.session_id);
    this.affect(file.provider, file.session_id);
  }

  trackFile(file: FileState): void {
    this.files.set(file.id, file);
    if (this.indexesEnabled) this.indexFile(file);
  }

  /** 무변경 스캔은 관계 색인을 만들지 않는다. 이후에 등록한 파일은 바로 색인한다. */
  indexRelatedSources(): void {
    if (this.indexesEnabled) return;
    this.indexesEnabled = true;
    for (const file of this.files.values()) this.indexFile(file);
  }

  private indexFile(file: FileState): void {
    this.indexSession(file);
    if (file.provider === 'codex') this.codexFiles.push(file);
  }

  private indexSession(file: FileState): void {
    if (!file.session_id) return;
    const key = sessionKey(file.provider, file.session_id);
    addMember(this.sessionFiles, key, file);
    if (this.affected.has(key)) this.enqueueRelated(file);
  }

  setSession(file: FileState, session: string | null): void {
    if (file.session_id === session) return;
    if (file.session_id) removeMember(this.sessionFiles, sessionKey(file.provider, file.session_id), file);
    file.session_id = session;
    this.indexSession(file);
  }

  registerPrepared(file: FileState, prepared: PreparedSource): void {
    file.prepared = prepared;
    this.preparedFiles.push(file);
    const { identity } = prepared;
    this.seenReferences.add(identity.threadId);
    this.pendingReferences.delete(identity.threadId);
    if (file.provider !== 'codex') return;
    this.preparedCodex.push(file);
    this.lineageDirty = true;
    for (const reference of [identity.parentThreadId, identity.forkedFromId]) {
      if (!reference || this.seenReferences.has(reference)) continue;
      this.seenReferences.add(reference);
      this.pendingReferences.add(reference);
    }
  }

  preparedCodexFiles(): PreparedFile[] {
    return this.preparedCodex.filter(isPreparedFile).sort((a, b) => a.id - b.id);
  }
}
