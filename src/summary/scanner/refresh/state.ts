// 한 갱신의 파일 상태·관계 색인·큐를 소유하고 상태 변경 시 색인 일관성을 유지한다.
import type { SourceWinnersSnapshot } from '../../aggregation/sourceWinners';
import type { FileMetadata, SourceFileRow, Provider } from '../../db/types';
import { SummaryError } from '../../jsonl';
import type { ParsedIdentity, RefreshResult } from '../../types';
import { sqlText } from '../sourceReader';
import { addMember, removeMember, SourceQueue } from '../worklist';

export const PARSER_VERSION = 26;

/** 제공자와 정규화한 세션 ID를 묶어 스캔 상태의 조회 키를 만든다. */
export const sessionKey = (provider: Provider, session: string): string => JSON.stringify([provider, sqlText(session)]);

export interface PreparedSource {
  identity: ParsedIdentity;
  winners: SourceWinnersSnapshot;
  partialLine: boolean;
  parentRootId?: string;
}

export type StoredSource = FileMetadata & Pick<SourceFileRow, 'id' | 'source_missing' | 'processing_status'>;

/** 저장된 원본과 현재 관측값·파서 버전·기능 수집 상태를 비교해 다시 읽을지 판단한다. */
export function needsSourceRead(file: Pick<FileMetadata, 'mtime_ms' | 'source_root'>,
  previous: StoredSource | undefined, collect: boolean): boolean {
  return !previous || previous.mtime_ms !== file.mtime_ms || previous.source_root !== file.source_root
    || previous.source_missing === 1 || previous.processing_status !== 'done'
    || previous.parser_version !== PARSER_VERSION || collect && previous.capabilities_collected !== 1;
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

/** 집계에 사용할 수 있는 준비 결과가 있는지 확인한다. */
export function isPreparedFile(file: FileState): file is PreparedFile {
  return file.prepared !== undefined && !file.error && !file.removed;
}

/** 한 번의 갱신에 필요한 원본 상태, 세션 관계 색인, 재처리 큐를 관리한다. */
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

  /** 파일 처리 실패를 기록할 갱신 결과를 연결한다. */
  constructor(private readonly result: RefreshResult) {}

  /** 아직 읽기를 시도하지 않은 원본을 처리할 수 있는지 확인한다. */
  ready(file: FileState): boolean {
    return !file.attempted && !file.error && !file.removed;
  }

  /** 처리 가능한 관련 원본을 파일 ID 우선 큐에 넣는다. */
  private enqueueRelated(file: FileState): void {
    if (this.ready(file)) this.relatedQueue.add(file);
  }

  /** 세션을 재집계 대상으로 등록하고 해당 원본을 큐에 넣는다. */
  affect(provider: Provider, session: string | null | undefined): void {
    if (!session) return;
    const value = sessionKey(provider, session);
    if (this.affected.has(value)) return;
    this.affected.add(value);
    for (const file of this.sessionFiles.get(value) ?? []) this.enqueueRelated(file);
  }

  /** 원본 이동 등으로 연결된 두 세션을 함께 재집계하고 저장하도록 등록한다. */
  connect(provider: Provider, a: string | null | undefined, b: string | null | undefined): void {
    if (!a || !b || a === b) return;
    const left = sessionKey(provider, a), right = sessionKey(provider, b);
    // 어느 쪽 세션에서 탐색해도 같은 저장 묶음을 찾도록 양방향으로 연결한다.
    for (const [from, to] of [[left, right], [right, left]]) {
      let set = this.links.get(from);
      if (!set) this.links.set(from, set = new Set());
      set.add(to);
    }
    this.affect(provider, a);
    this.affect(provider, b);
  }

  /** 파일 오류를 기록하고 이전 세션과 현재 세션을 재집계 범위에 넣는다. */
  fail(file: FileState, error: unknown): void {
    // 같은 파일에 오류가 다시 기록돼도 실패 건수는 한 번만 센다.
    if (!file.error) this.result.failed++;
    file.error = error instanceof SummaryError ? error : new SummaryError('source-read-error');
    this.affect(file.provider, file.previous?.session_id);
    this.affect(file.provider, file.session_id);
  }

  /** 파일 ID로 원본을 보관하고 관계 색인이 활성화된 경우 함께 갱신한다. */
  trackFile(file: FileState): void {
    this.files.set(file.id, file);
    if (this.indexesEnabled) this.indexFile(file);
  }

  /** 처음 필요할 때 기존 원본을 색인하고 이후에 등록하는 원본은 즉시 색인한다. */
  indexRelatedSources(): void {
    if (this.indexesEnabled) return;
    this.indexesEnabled = true;
    for (const file of this.files.values()) this.indexFile(file);
  }

  /** 원본을 세션별 색인에 넣고 Codex 원본은 부모 탐색 목록에도 추가한다. */
  private indexFile(file: FileState): void {
    this.indexSession(file);
    if (file.provider === 'codex') this.codexFiles.push(file);
  }

  /** 현재 세션으로 파일을 색인하고 재집계 대상이면 관련 원본 큐에 넣는다. */
  private indexSession(file: FileState): void {
    if (!file.session_id) return;
    const key = sessionKey(file.provider, file.session_id);
    addMember(this.sessionFiles, key, file);
    if (this.affected.has(key)) this.enqueueRelated(file);
  }

  /** 파일의 세션이 바뀌면 기존 색인에서 제거하고 새 세션의 색인에 넣는다. */
  setSession(file: FileState, session: string | null): void {
    if (file.session_id === session) return;
    if (file.session_id) removeMember(this.sessionFiles, sessionKey(file.provider, file.session_id), file);
    file.session_id = session;
    this.indexSession(file);
  }

  /** 원본 준비 결과를 저장하고 추가 탐색이 필요한 스레드 참조를 등록한다. */
  registerPrepared(file: FileState, prepared: PreparedSource): void {
    file.prepared = prepared;
    this.preparedFiles.push(file);
    const { identity } = prepared;
    // 이미 준비한 스레드는 추가 탐색 목록에서 제거한다.
    this.seenReferences.add(identity.threadId);
    this.pendingReferences.delete(identity.threadId);
    if (file.provider !== 'codex') return;
    this.preparedCodex.push(file);
    this.lineageDirty = true;
    // 처음 발견한 Codex 부모·복사 원본 참조만 다음 탐색에 넘긴다.
    for (const reference of [identity.parentThreadId, identity.forkedFromId]) {
      if (!reference || this.seenReferences.has(reference)) continue;
      this.seenReferences.add(reference);
      this.pendingReferences.add(reference);
    }
  }

  /** 계보나 귀속을 확인할 Codex 준비 결과를 파일 ID 순서로 반환한다. */
  preparedCodexFiles(): PreparedFile[] {
    return this.preparedCodex.filter(isPreparedFile).sort((a, b) => a.id - b.id);
  }
}
