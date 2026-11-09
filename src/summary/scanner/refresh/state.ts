// 한 갱신의 파일 상태·관계 색인·큐를 소유하고 상태 변경 시 색인 일관성을 유지한다.
import type { SourceEvidence } from '../../aggregation/sourceEvidence';
import type { SourceWinners } from '../../aggregation/sourceWinners';
import type { FileMetadata, ManifestRow, Provider } from '../../db/types';
import { SummaryError } from '../../jsonl';
import type { ParsedIdentity, RefreshResult } from '../../types';
import { sqlText } from '../sourceReader';
import { addMember, removeMember, SourceQueue } from '../worklist';

export const PARSER_VERSION = 17;
export const sessionKey = (provider: Provider, session: string): string => JSON.stringify([provider, sqlText(session)]);

export interface PreparedSource {
  identity: ParsedIdentity;
  evidence: SourceEvidence;
  winners: SourceWinners;
  partialLine: boolean;
  sourceIdentity: string;
  contentHash: string;
}

export interface FileState extends FileMetadata {
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

/** Map·Set은 갱신당 한 번 만들고 책임별 모듈은 같은 상태를 사용한다. */
export class ScanState {
  readonly files = new Map<number, FileState>();
  readonly affected = new Set<string>();
  readonly links = new Map<string, Set<string>>();
  readonly sessionFiles = new Map<string, Set<FileState>>();
  readonly identityFiles = new Map<string, Set<FileState>>();
  readonly codexFiles = new Set<FileState>();
  readonly preparedCodex = new Set<FileState>();
  readonly fileOrder = new Map<FileState, number>();
  readonly knownThreads = new Set<string>();
  readonly missingReferences = new Set<string>();
  readonly unsearchedReferences = new Set<string>();
  readonly parentReasons = new Map<FileState, Set<string>>();
  readonly relatedQueue = new SourceQueue<FileState>();
  readonly parentQueue = new SourceQueue<FileState>();
  readonly missingParents = new Set<number>();
  readonly reconnections: { old_id: number; new_id: number }[] = [];
  lineageDirty = false;
  sequence = 0;

  constructor(private readonly result: RefreshResult) {}

  ready(file: FileState): boolean {
    return this.files.get(file.id) === file && !file.attempted && !file.prepared && !file.error && !file.removed;
  }

  enqueueRelated(file: FileState): void {
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
    this.affect(file.provider, file.session);
  }

  trackFile(file: FileState): void {
    const previous = this.files.get(file.id);
    const order = previous ? this.fileOrder.get(previous)! : this.fileOrder.size;
    if (previous) {
      removeMember(this.sessionFiles, sessionKey(previous.provider, previous.session ?? ''), previous);
      if (previous.source_identity)
        removeMember(this.identityFiles, JSON.stringify([previous.provider, previous.source_identity]), previous);
      this.codexFiles.delete(previous);
      this.fileOrder.delete(previous);
    }
    this.files.set(file.id, file);
    this.fileOrder.set(file, order);
    addMember(this.sessionFiles, sessionKey(file.provider, file.session ?? ''), file);
    if (file.source_identity)
      addMember(this.identityFiles, JSON.stringify([file.provider, file.source_identity]), file);
    if (file.provider === 'codex') this.codexFiles.add(file);
    if (this.affected.has(sessionKey(file.provider, file.session ?? ''))) this.enqueueRelated(file);
  }

  setSession(file: FileState, session: string | null): void {
    if (file.session === session) return;
    removeMember(this.sessionFiles, sessionKey(file.provider, file.session ?? ''), file);
    file.session = session;
    addMember(this.sessionFiles, sessionKey(file.provider, session ?? ''), file);
    if (this.affected.has(sessionKey(file.provider, session ?? ''))) this.enqueueRelated(file);
  }

  setSourceIdentity(file: FileState, identity: string | null | undefined): void {
    if (file.source_identity === identity) return;
    if (file.source_identity)
      removeMember(this.identityFiles, JSON.stringify([file.provider, file.source_identity]), file);
    file.source_identity = identity;
    if (identity) addMember(this.identityFiles, JSON.stringify([file.provider, identity]), file);
  }

  registerPrepared(file: FileState): void {
    const identity = file.prepared!.identity;
    this.knownThreads.add(identity.threadId);
    this.missingReferences.delete(identity.threadId);
    if (file.provider !== 'codex') return;
    this.preparedCodex.add(file);
    this.lineageDirty = true;
    for (const reference of [identity.parentThreadId, identity.forkedFromId]) {
      if (!reference || this.knownThreads.has(reference) || this.missingReferences.has(reference)) continue;
      this.missingReferences.add(reference);
      this.unsearchedReferences.add(reference);
    }
  }
}
