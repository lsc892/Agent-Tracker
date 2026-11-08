// 호환 SQL staging의 공개 API와 연결·버퍼·집계 수명을 조율한다.
import type { DatabaseSync } from 'node:sqlite';
import type { FileMetadata, ManifestRow, TurnSummaryInput } from '../db/types';
import type { ParsedIdentity, ParseEvent, Provider, UsageEvent } from '../types';
import { SummaryMetadata } from '../metadata';
import { MemoryEvents } from './memoryEvents';
import { createStagingSchema, dropStagingSchema } from './schema';
import { StagingSources } from './sources';
import { StagingEvents } from './events';
import { StagingSummaries } from './summaries';
import { resolveLineage } from './lineage';
import { nextComponent, finishComponent, componentFailed, componentSessions } from './components';
import type { StagedFile } from './types';
export type { StagedFile, PreparedTurn } from './types';

/** 하나의 SQLite 연결에서 원본·이벤트·계보·집계의 처리 순서를 관리한다. */
export class SummaryStaging {
  private readonly memory = new MemoryEvents();
  private readonly sources: StagingSources;
  private readonly events: StagingEvents;
  private readonly metadata: SummaryMetadata;
  private readonly summariesStore: StagingSummaries;

  /** TEMP 스키마·이벤트 쓰기·원본 쓰기·metadata를 원래 순서로 준비한다. */
  constructor(readonly connection: DatabaseSync, collectCapabilities = true) {
    createStagingSchema(connection);
    this.events = new StagingEvents(connection, this.memory);
    this.sources = new StagingSources(connection, collectCapabilities, fileId => {
      this.memory.mainFile(fileId);
      this.flag(fileId, '*', 'standalone-subagent');
    });
    this.metadata = new SummaryMetadata(connection, collectCapabilities, this.memory);
    this.summariesStore = new StagingSummaries(connection, collectCapabilities, this.metadata, () => this.loadEvents());
  }

  /** 원본 상태를 적재하고 바뀐 이전 세션을 영향 목록에 기록한다. */
  addFile(file: FileMetadata & { id: number }, oldSession: string | null, changed: boolean, removed = false): void {
    this.sources.addFile(file, oldSession, changed, removed);
  }

  /** 해당 세션을 다음 연결 성분 교체의 영향 목록에 넣는다. */
  affect(provider: Provider, session: string): void { this.sources.affect(provider, session); }

  /** 파서가 확인한 원본 귀속과 독립 agent 처리를 반영한다. */
  identity(fileId: number, identity: ParsedIdentity): void { this.sources.identity(fileId, identity); }

  /** 파싱 이벤트와 품질 플래그를 현재 청크 버퍼에 추가한다. */
  event(fileId: number, event: ParseEvent): void { this.events.event(fileId, event); }

  /** 청크의 DTO와 공용 이름 SQL 쓰기를 하나의 실패 복구 경계로 처리한다. */
  batchEvents(parseRows: () => void): void { this.events.batchEvents(parseRows); }

  /** 원본 품질 플래그를 이벤트 적재 시점에 맞춰 보관하거나 기록한다. */
  flag(fileId: number, root: string, flag: string): void { this.events.flag(fileId, root, flag); }

  /** 실패한 원본을 임시 상태에 표시해 성분 교체를 보류한다. */
  fail(fileId: number): void { this.sources.fail(fileId); }

  /** 승인할 원본의 의미 식별자와 본문 해시를 기록한다. */
  acceptFingerprint(fileId: number, identity: string | null, hash: string | null): void {
    this.sources.acceptFingerprint(fileId, identity, hash);
  }

  /** 관측하지 않은 같은 원본의 이전 snapshot 후보를 페이지로 순회한다. */
  moveCandidates(file: StagedFile, scanId: string): Generator<ManifestRow> { return this.sources.moveCandidates(file, scanId); }

  /** 내용 검증을 마친 이전 원본과 새 원본을 같은 교체 성분으로 연결한다. */
  reconnectSource(previous: ManifestRow, current: StagedFile): void { this.sources.reconnectSource(previous, current); }

  /** 현재 성분의 검증된 이동 원본 ID 쌍을 순회한다. */
  reconnectedFiles(): Iterable<{ old_id: number; new_id: number }> { return this.sources.reconnectedFiles(); }

  /** 조건에 맞는 원본을 100행씩 읽어 큰 파일 목록을 한 번에 적재하지 않는다. */
  files(sql: string, parameters: (string | number)[] = []): Generator<StagedFile> { return this.sources.files(sql, parameters); }

  /** 다음 영향 세션의 양방향 연결 성분을 교체 대상으로 선택한다. */
  nextComponent(): boolean { return nextComponent(this.connection); }

  /** 성공한 성분의 DTO·서명 캐시를 먼저 해제하고 TEMP 입력을 정리한다. */
  finishComponent(): void {
    const files = [...this.files(`EXISTS(SELECT 1 FROM component c WHERE c.provider=scan_files.provider
      AND (c.session_id=scan_files.session_id OR c.session_id=scan_files.old_session))`)].map(file => file.id);
    this.memory.release(files);
    this.metadata.release(files);
    finishComponent(this.connection);
  }

  /** 현재 성분에 실패한 원본이 있는지 확인한다. */
  componentFailed(): boolean { return componentFailed(this.connection); }

  /** 현재 성분이 포함하는 제공자·세션 키를 순회한다. */
  componentSessions(): Iterable<{ provider: Provider; session_id: string }> { return componentSessions(this.connection); }

  /** 부모 우선 계보를 해소한 뒤 current와 겹치는 legacy 기여를 제외한다. */
  resolveLineage(): void {
    resolveLineage(this.connection);
    this.memory.excludeLegacy();
  }

  /** 검증된 부모·자식 복사 접두사와 그 누락 부모 경고를 제외한다. */
  excludeVerifiedPrefixes(): void { this.events.excludeVerifiedPrefixes([...this.files('1=1')]); }

  /** 복사 제외 뒤 잃은 후보를 복구할 원본 ID를 순회한다. */
  recoveryFiles(): Iterable<number> { return this.memory.recoveryFiles(); }

  /** 재읽은 legacy 후보를 원래 순번으로 복구한다. */
  recoverLegacy(fileId: number, event: UsageEvent, index: number): void { this.memory.recoverLegacy(fileId, event, index); }

  /** 해당 원본의 legacy 후보 복구를 완료한다. */
  finishRecovery(fileId: number): void { this.memory.finishRecovery(fileId); }

  /** 선택된 이벤트를 한 번만 적재하며 계측용 기존 메소드 경계를 유지한다. */
  private loadEvents(): void {
    if (this.events.loaded) return;
    this.events.loadEvents([...this.files('1=1')]);
  }

  /** 현재 성분을 포함한 정상 묶음의 변경 요청을 집계해 재사용한다. */
  prepareSummaries(): void { this.summariesStore.prepareSummaries(); }

  /** 준비된 변경 요청과 선택한 미변경 캐시를 저장 DTO로 순회한다. */
  summaries(includeUnchanged = false): Generator<TurnSummaryInput> { return this.summariesStore.summaries(includeUnchanged); }

  /** 현재 성분에서 입력이 달라진 요청 키를 순회한다. */
  changedTurns(): Iterable<{ provider: Provider; session_id: string; root_turn_id: string }> { return this.metadata.changedTurns(); }

  /** 요청 저장과 같은 트랜잭션에서 확정 metadata를 공개한다. */
  commitMetadata(): void { this.metadata.commit(); }

  /** DTO·플래그, metadata, staging TEMP 표를 기존 순서대로 해제한다. */
  close(): void {
    this.events.close();
    this.metadata.close();
    dropStagingSchema(this.connection);
  }

}
