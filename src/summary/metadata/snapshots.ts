// 확정된 요청·모델·Skill snapshot을 읽고 현재 연결 성분의 변경 결과만 저장한다.
import type { DatabaseSync } from 'node:sqlite';
import type { CapabilityUsageInput, ModelUsageInput } from '../db/types';
import type { Provider } from '../types';
import type { PreparedTurn } from '../staging/types';
import { COMMITTED_DIRTY_TURNS, type TurnKey } from './types';

/** TEMP 집계와 영속 metadata 사이에서 확정 snapshot의 읽기·쓰기를 담당한다. */
export class MetadataSnapshots {
  constructor(private readonly connection: DatabaseSync) {}

  /** 현재 연결 성분의 dirty 요청 식별자를 조회 순서대로 전달한다. */
  changedTurns(): Iterable<{ provider: Provider; session_id: string; root_turn_id: string }> {
    return this.connection.prepare(`SELECT m.provider,m.session_id,m.root_id root_turn_id FROM metadata_turns m
      JOIN component c ON c.provider=m.provider AND c.session_id=m.session_id WHERE m.dirty=1`)
      .iterate() as unknown as Iterable<{ provider: Provider; session_id: string; root_turn_id: string }>;
  }

  /** 현재 성분의 변경 없는 요청을 순회하며 저장된 JSON snapshot을 필요할 때 해석한다. */
  *unchangedTurns(): Generator<PreparedTurn> {
    const rows = this.connection.prepare(`SELECT a.prepared_json FROM turn_metadata a
      JOIN metadata_turns m ON m.provider=a.provider AND m.session_id=a.session_id AND m.root_id=a.root_id
      JOIN component c ON c.provider=a.provider AND c.session_id=a.session_id
      WHERE m.dirty=0 AND a.prepared_json IS NOT NULL`).iterate();
    for (const row of rows) yield JSON.parse(row.prepared_json as string) as PreparedTurn;
  }

  /** 저장된 요청 모델 값을 모델명 순서의 iterator로 반환한다. */
  models(key: TurnKey): Iterable<ModelUsageInput> {
    return this.connection.prepare(`SELECT model,input_tokens,output_tokens,cache_read_input_tokens,cache_write_input_tokens
      FROM turn_metadata_models WHERE provider=? AND session_id=? AND root_id=? ORDER BY model`)
      .iterate(key.provider, key.session_id, key.root_id) as unknown as Iterable<ModelUsageInput>;
  }

  /** 저장된 요청 Skill 값을 분류·이름 순서의 iterator로 반환한다. */
  capabilities(key: TurnKey): Iterable<CapabilityUsageInput> {
    return this.connection.prepare(`SELECT category,name,usage_count FROM turn_metadata_capabilities
      WHERE provider=? AND session_id=? AND root_id=? ORDER BY category,name`)
      .iterate(key.provider, key.session_id, key.root_id) as unknown as Iterable<CapabilityUsageInput>;
  }

  /** 현재 성분에 변경 요청이 있으면 확정 요청·모델·Skill을 기존 순서로 교체한다. */
  commit(): boolean {
    if (!this.hasDirtyComponent()) return false;
    this.deleteDirtySnapshots();
    this.savePreparedTurns();
    this.saveUsage();
    return true;
  }

  /** 현재 연결 성분에서 dirty 요청이 하나라도 있는지 확인한다. */
  private hasDirtyComponent(): boolean {
    return Boolean(this.connection.prepare(`SELECT 1 FROM metadata_turns m JOIN component c
      ON c.provider=m.provider AND c.session_id=m.session_id WHERE m.dirty=1 LIMIT 1`).get());
  }

  /** 현재 성분의 dirty metadata를 먼저 삭제해 사라진 요청과 자식 snapshot을 정리한다. */
  private deleteDirtySnapshots(): void {
    this.connection.exec(`DELETE FROM turn_metadata WHERE (provider,session_id,root_id) IN (
      SELECT m.provider,m.session_id,m.root_id FROM metadata_turns m
      JOIN component c ON c.provider=m.provider AND c.session_id=m.session_id WHERE m.dirty=1);`);
  }

  /** 유효 세션·서명이 있는 요청마다 준비된 행을 JSON으로 저장하고 없는 행은 null로 남긴다. */
  private savePreparedTurns(): void {
    const connection = this.connection;
    const insert = connection.prepare('INSERT INTO turn_metadata VALUES(?,?,?,?,?)');
    const prepared = connection.prepare('SELECT * FROM prepared_turns WHERE provider=? AND session_id=? AND root_id=?');
    const rows = connection.prepare(`SELECT m.* FROM metadata_turns m JOIN component c
      ON c.provider=m.provider AND c.session_id=m.session_id JOIN sessions s
      ON s.provider=m.provider AND s.session_id=m.session_id WHERE m.dirty=1 AND m.signature IS NOT NULL`).iterate();
    for (const raw of rows) {
      const key = raw as unknown as TurnKey;
      const value = prepared.get(key.provider, key.session_id, key.root_id);
      insert.run(key.provider, key.session_id, key.root_id, raw.signature as string, value ? JSON.stringify(value) : null);
    }
  }

  /** 확정 dirty 요청의 winner에서 모델 토큰·Skill·모델 호출 횟수를 차례로 저장한다. */
  private saveUsage(): void {
    this.connection.exec(`INSERT INTO turn_metadata_models
      SELECT w.provider,w.session_id,w.root_id,coalesce(w.model,''),sum(w.input),sum(w.output),
        sum(min(w.input,w.cache_read)),sum(min(max(0,w.input-w.cache_read),w.cache_write))
      FROM winners w JOIN metadata_turns m ON m.provider=w.provider AND m.session_id=w.session_id AND m.root_id=w.root_id
      ${COMMITTED_DIRTY_TURNS} GROUP BY w.provider,w.session_id,w.root_id,coalesce(w.model,'')
      HAVING coalesce(w.model,'')<>'' OR sum(w.input+w.output)>0;
      INSERT INTO turn_metadata_capabilities
      SELECT w.provider,w.session_id,w.root_id,w.category,w.name,count(*) FROM capability_winners w
      JOIN metadata_turns m ON m.provider=w.provider AND m.session_id=w.session_id AND m.root_id=w.root_id
      ${COMMITTED_DIRTY_TURNS} GROUP BY w.provider,w.session_id,w.root_id,w.category,w.name;
      INSERT INTO turn_metadata_capabilities
      SELECT w.provider,w.session_id,w.root_id,'model',coalesce(w.model,''),count(*) FROM winners w
      JOIN metadata_turns m ON m.provider=w.provider AND m.session_id=w.session_id AND m.root_id=w.root_id
      ${COMMITTED_DIRTY_TURNS} AND (coalesce(w.model,'')<>'' OR w.input+w.output>0)
      GROUP BY w.provider,w.session_id,w.root_id,coalesce(w.model,'');`);
  }
}
