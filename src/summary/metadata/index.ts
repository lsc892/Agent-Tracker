// 요청 서명 비교·dirty 확장·확정 snapshot을 조율하고 metadata TEMP 표의 수명을 관리한다.
import type { DatabaseSync } from 'node:sqlite';
import type { CapabilityUsageInput, ModelUsageInput } from '../db/types';
import type { Provider } from '../types';
import type { PreparedTurn } from '../staging/types';
import type { MemoryEvents } from '../staging/memoryEvents';
import { MetadataSignatures } from './signatures';
import { MetadataDependencies } from './dependencies';
import { MetadataSnapshots } from './snapshots';
import type { MetadataScope, TurnKey } from './types';

/** 공유 연결의 metadata 수명과 처리 순서를 소유하고 책임별 구성요소에 계산·저장을 위임한다. */
export class SummaryMetadata {
  private readonly signatures: MetadataSignatures;
  private readonly dependencies: MetadataDependencies;
  private readonly snapshots: MetadataSnapshots;

  constructor(
    private readonly connection: DatabaseSync, collectCapabilities: boolean, memory: MemoryEvents,
  ) {
    this.signatures = new MetadataSignatures(connection, collectCapabilities, memory);
    this.dependencies = new MetadataDependencies(connection);
    this.snapshots = new MetadataSnapshots(connection);
    this.createTables();
  }

  /** 요청 범위를 만든 뒤 의미 서명을 비교하고 변경 요청이 있을 때만 의존성을 확장한다. */
  prepare(sessions: MetadataScope): void {
    this.resetTurns(sessions);
    const dependencies = this.signatures.prepare(sessions);
    if (!this.hasDirtyTurns()) return;
    this.dependencies.prepare(sessions, dependencies);
  }

  /** 현재 집계 SQL에서 파일·이벤트가 dirty 요청에 속하는지 검사할 조건을 만든다. */
  dirtyPredicate(fileAlias: string, eventAlias: string): string {
    return `EXISTS(SELECT 1 FROM metadata_turns m WHERE m.provider=${fileAlias}.provider
      AND m.session_id=${fileAlias}.session_id AND m.root_id=${eventAlias}.root_id AND m.dirty=1)`;
  }

  /** 현재 연결 성분의 변경 요청 식별자를 확정 snapshot 저장소에서 읽는다. */
  changedTurns(): Iterable<{ provider: Provider; session_id: string; root_turn_id: string }> {
    return this.snapshots.changedTurns();
  }

  /** 변경 없는 확정 요청을 지연 순회해 다음 집계에서 재사용한다. */
  *unchangedTurns(): Generator<PreparedTurn> {
    yield* this.snapshots.unchangedTurns();
  }

  /** 변경 없는 요청의 모델별 확정 토큰 iterator를 반환한다. */
  models(key: TurnKey): Iterable<ModelUsageInput> {
    return this.snapshots.models(key);
  }

  /** 변경 없는 요청의 분류·이름별 확정 Skill iterator를 반환한다. */
  capabilities(key: TurnKey): Iterable<CapabilityUsageInput> {
    return this.snapshots.capabilities(key);
  }

  /** 세션 저장 트랜잭션 안에서 확정 snapshot을 저장한 뒤 현재 의존 키를 공개한다. */
  commit(): void {
    if (!this.snapshots.commit()) return;
    this.dependencies.commit();
  }

  /** 반영을 끝낸 파일의 서명 근거만 해제해 나머지 파일 캐시를 재사용한다. */
  release(fileIds: Iterable<number>): void {
    this.signatures.release(fileIds);
  }

  /** 원본·의존 키 상태를 해제한 뒤 metadata TEMP 표를 생성의 역순으로 제거한다. */
  close(): void {
    this.signatures.clear();
    this.dependencies.clear();
    this.connection.exec('DROP TABLE temp.metadata_dependencies; DROP TABLE temp.metadata_turns;');
  }

  /** 요청 비교와 공유 의존성 확장을 위한 TEMP 표·인덱스를 갱신당 한 번 생성한다. */
  private createTables(): void {
    this.connection.exec(`CREATE TEMP TABLE metadata_turns(
      provider TEXT NOT NULL,session_id TEXT NOT NULL,root_id TEXT NOT NULL,signature TEXT,dirty INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY(provider,session_id,root_id)) WITHOUT ROWID;
      CREATE TEMP TABLE metadata_dependencies(
        provider TEXT NOT NULL,session_id TEXT NOT NULL,root_id TEXT NOT NULL,dependency TEXT NOT NULL,
        PRIMARY KEY(provider,session_id,root_id,dependency)) WITHOUT ROWID;
      CREATE INDEX temp.metadata_dependency ON metadata_dependencies(provider,session_id,dependency,root_id);`);
  }

  /** 현재 이벤트와 이전 metadata·facts의 요청 키를 합쳐 비교할 전체 범위를 초기화한다. */
  private resetTurns(sessions: MetadataScope): void {
    this.connection.exec(`DELETE FROM metadata_turns; DELETE FROM metadata_dependencies;
      INSERT INTO metadata_turns(provider,session_id,root_id)
        SELECT f.provider,f.session_id,e.root_id FROM ${sessions} s
        JOIN scan_files f ON f.provider=s.provider AND f.session_id=s.session_id
        JOIN events e ON e.file_id=f.id WHERE f.removed=0 AND f.failed=0
        GROUP BY f.provider,f.session_id,e.root_id;
      INSERT OR IGNORE INTO metadata_turns(provider,session_id,root_id)
        SELECT m.provider,m.session_id,m.root_id FROM turn_metadata m JOIN ${sessions} s
          ON s.provider=m.provider AND s.session_id=m.session_id;
      INSERT OR IGNORE INTO metadata_turns(provider,session_id,root_id)
        SELECT t.provider,t.session_id,t.root_turn_id FROM turn_summary t JOIN ${sessions} s
          ON s.provider=t.provider AND s.session_id=t.session_id;`);
  }

  /** 의미 서명 비교 후 dirty 요청이 남아 있는지 확인한다. */
  private hasDirtyTurns(): boolean {
    return Boolean(this.connection.prepare('SELECT 1 FROM metadata_turns WHERE dirty=1 LIMIT 1').get());
  }
}
