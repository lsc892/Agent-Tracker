// 한 갱신의 파일 상태·관계 색인·큐를 소유하고 상태 변경 시 색인 일관성을 유지한다.
import type { FileMetadata, SourceFileRow, Provider } from '../../db/types';
import { SummaryError } from '../../jsonl';
import type { ThreadLog } from '../../parsers/threadUsage';
import type { RefreshResult } from '../../types';
import { sqlText } from '../sourceReader';
import { addMember, removeMember, SourceQueue } from '../worklist';
import { ThreadAggregation } from './aggregation';

export const PARSER_VERSION = 25;
export const sessionKey = (provider: Provider, session: string): string => JSON.stringify([provider, sqlText(session)]);

type PreparedSource = Pick<ThreadLog, 'sessionId' | 'threadId' | 'parentThreadId'> & { hasLegacy: boolean };

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
  readonly preparedCodexFiles: FileState[] = [];
  readonly aggregation = new ThreadAggregation();
  readonly relatedQueue = new SourceQueue<FileState>();
  readonly savedSessionNames = new Map<string, string>();
  private indexesEnabled = false;

  constructor(private readonly result: RefreshResult) {}

  ready(file: FileState): boolean {
    return !file.attempted && !file.error && !file.removed;
  }

  private enqueueRelated(file: FileState): void {
    if (this.ready(file)) this.relatedQueue.add(file);
  }

  affect(provider: Provider, session: string | null | undefined): void {
    // [큐 정책] 세션이 처음 영향을 받을 때 아직 처리하지 않은 관련 파일을 예약한다.
    if (!session) return;
    const value = sessionKey(provider, session);
    if (this.affected.has(value)) return;
    this.affected.add(value);
    for (const file of this.sessionFiles.get(value) ?? []) this.enqueueRelated(file);
  }

  connect(provider: Provider, a: string | null | undefined, b: string | null | undefined): void {
    // [저장 정책] 파일의 이전·현재 세션을 양방향으로 연결해 같은 반영 단위에 둔다.
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
    // [진단 정책] 파일당 최초 실패만 세고 이전·현재 귀속 모두를 변경 대상으로 표시한다.
    if (!file.error) this.result.failed++;
    file.error = error instanceof SummaryError ? error : new SummaryError('source-read-error');
    this.affect(file.provider, file.previous?.session_id);
    this.affect(file.provider, file.session_id);
  }

  trackFile(file: FileState): void {
    this.files.set(file.id, file);
    if (this.indexesEnabled) this.indexSession(file);
  }

  /** 무변경 스캔은 관계 색인을 만들지 않는다. 이후에 등록한 파일은 바로 색인한다. */
  indexRelatedSources(): void {
    if (this.indexesEnabled) return;
    this.indexesEnabled = true;
    for (const file of this.files.values()) this.indexSession(file);
  }

  private indexSession(file: FileState): void {
    if (!file.session_id) return;
    const key = sessionKey(file.provider, file.session_id);
    addMember(this.sessionFiles, key, file);
    if (this.affected.has(key)) this.enqueueRelated(file);
  }

  setSession(file: FileState, session: string | null): void {
    // [색인 정책] 세션이 바뀌면 이전 멤버십을 지우고 새 세션에 등록한다.
    if (file.session_id === session) return;
    if (file.session_id) removeMember(this.sessionFiles, sessionKey(file.provider, file.session_id), file);
    file.session_id = session;
    this.indexSession(file);
  }

  registerPrepared(file: FileState, thread: ThreadLog): void {
    // [집계 정책] 스레드를 세션 집계에 넘기고 부모 검색에 필요한 식별자와 레거시 여부만 파일에 남긴다.
    const { sessionId, threadId, parentThreadId, legacy } = thread;
    this.aggregation.add(file, sessionKey(file.provider, sessionId), thread);
    file.prepared = { sessionId, threadId, parentThreadId, hasLegacy: legacy !== undefined };
    if (file.provider === 'codex') this.preparedCodexFiles.push(file);
  }
}
