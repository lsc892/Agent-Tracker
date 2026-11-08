// 현재 응답·누계 의존 키를 소유하고 연결된 dirty 요청을 확장·확정한다.
import type { DatabaseSync } from 'node:sqlite';
import { COMMITTED_DIRTY_TURNS, type MetadataDependency, type MetadataScope } from './types';

/** dirty 요청이 있을 때 승인한 의존 키를 유지해 같은 세션 저장에서만 영속화한다. */
export class MetadataDependencies {
  private current: MetadataDependency[] = [];

  constructor(private readonly connection: DatabaseSync) {}

  /** 현재 의존 키를 교체하고 TEMP 적재 뒤 이전 의존 키와 함께 dirty 연결을 확장한다. */
  prepare(sessions: MetadataScope, dependencies: Map<string, MetadataDependency>): void {
    this.current = [...dependencies.values()];
    this.stageCurrentDependencies();
    this.expandDirtyTurns(sessions);
  }

  /** 의존 키를 한 DEFERRED 트랜잭션으로 적재하고 실패 시 rollback 후 같은 오류를 전달한다. */
  private stageCurrentDependencies(): void {
    const connection = this.connection;
    const insert = connection.prepare('INSERT OR IGNORE INTO metadata_dependencies VALUES(?,?,?,?)');
    connection.exec('BEGIN DEFERRED');
    try {
      for (const dependency of this.current) insert.run(...dependency);
      connection.exec('COMMIT');
    } catch (error) {
      connection.exec('ROLLBACK');
      throw error;
    }
  }

  /** 이전·현재 의존 키의 공유 연결을 재귀 SQL로 순회해 영향 요청의 dirty 표시를 확장한다. */
  private expandDirtyTurns(sessions: MetadataScope): void {
    this.connection.exec(`INSERT OR IGNORE INTO metadata_dependencies SELECT d.* FROM turn_metadata_dependencies d
        JOIN ${sessions} s ON s.provider=d.provider AND s.session_id=d.session_id;
      WITH RECURSIVE dirty(provider,session_id,root_id) AS (
        SELECT provider,session_id,root_id FROM metadata_turns WHERE dirty=1
        UNION
        SELECT b.provider,b.session_id,b.root_id FROM dirty x
          JOIN metadata_dependencies a ON a.provider=x.provider AND a.session_id=x.session_id AND a.root_id=x.root_id
          JOIN metadata_dependencies b ON b.provider=a.provider AND b.session_id=a.session_id AND b.dependency=a.dependency
      ) UPDATE metadata_turns SET dirty=1 WHERE (provider,session_id,root_id) IN (SELECT * FROM dirty);`);
  }

  /** 확정된 dirty 요청 키만 골라 이번 원본의 의존 키를 같은 저장 트랜잭션에 반영한다. */
  commit(): void {
    const connection = this.connection;
    const current = new Set(connection.prepare(`SELECT m.provider,m.session_id,m.root_id FROM metadata_turns m
      ${COMMITTED_DIRTY_TURNS}`).all().map(row => JSON.stringify([row.provider, row.session_id, row.root_id])));
    const insert = connection.prepare('INSERT OR IGNORE INTO turn_metadata_dependencies VALUES(?,?,?,?)');
    for (const dependency of this.current) {
      if (!current.has(JSON.stringify(dependency.slice(0, 3)))) continue;
      insert.run(...dependency);
    }
  }

  /** 갱신 종료 시 현재 확정 후보 의존 키를 해제한다. */
  clear(): void {
    this.current = [];
  }
}
