// 이벤트 청크·품질 플래그의 메모리 수명과 SQL 적재를 담당한다.
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { ParseEvent } from '../types';
import type { StagedFile } from './types';
import { MemoryEvents } from './memoryEvents';
import { EVENT_COLUMNS, eventValues } from './eventValues';

/** 청크 실패 복구와 승인된 이벤트의 일회 SQL 적재를 소유한다. */
export class StagingEvents {
  private readonly insertEvent: StatementSync;
  private readonly insertFlag: StatementSync;
  private readonly pendingFlags: [number, string, string][] = [];
  private eventsLoaded = false;

  /** 기존 순서로 이벤트·품질 플래그 쓰기 문장을 준비한다. */
  constructor(private readonly connection: DatabaseSync, private readonly memory: MemoryEvents) {
    this.insertEvent = connection.prepare(`INSERT INTO events(id,${EVENT_COLUMNS.join(',')},canonical_request)
      VALUES (${Array.from({ length: EVENT_COLUMNS.length + 2 }, () => '?').join(',')})`);
    this.insertFlag = connection.prepare('INSERT OR IGNORE INTO flags VALUES (?,?,?)');
  }

  /** facade가 불필요한 원본 조회 전에 이벤트 적재 완료 여부를 확인하게 한다. */
  get loaded(): boolean { return this.eventsLoaded; }

  /** 파싱 이벤트를 메모리에 추가하고 원본 품질 플래그를 같은 순서로 모은다. */
  event(fileId: number, event: ParseEvent): void {
    if (this.eventsLoaded) throw new Error('Cannot parse after event loading');
    this.memory.add(fileId, event);
    if (!('flags' in event)) return;
    for (const flag of event.flags ?? []) this.flag(fileId, event.rootId, flag);
  }

  /** 청크 DTO와 이름 SQL 쓰기를 함께 확정하고 실패한 청크만 되돌린다. */
  batchEvents(parseRows: () => void): void {
    const flagCount = this.pendingFlags.length;
    this.connection.exec('BEGIN DEFERRED');
    this.memory.beginBatch();
    try {
      parseRows();
      this.memory.commitBatch();
      this.connection.exec('COMMIT');
    } catch (error) {
      this.memory.rollbackBatch();
      this.pendingFlags.length = flagCount;
      this.connection.exec('ROLLBACK');
      throw error;
    }
  }

  /** SQL 적재 전에는 플래그를 모으고 적재 뒤에는 즉시 저장한다. */
  flag(fileId: number, root: string, flag: string): void {
    if (!this.eventsLoaded) {
      this.pendingFlags.push([fileId, root, flag]);
      return;
    }
    this.insertFlag.run(fileId, root, flag);
  }

  /** 검증된 복사 접두사를 제외하고 해당 원본의 누락 부모 플래그를 지운다. */
  excludeVerifiedPrefixes(files: StagedFile[]): void {
    const checked = new Set(this.memory.excludePrefixes(files));
    this.removePendingParentFlags(checked);
    const removeFlag = this.connection.prepare("DELETE FROM flags WHERE file_id=? AND flag='missing-parent'");
    for (const file of checked) removeFlag.run(file);
  }

  /** 확인한 원본의 누락 부모 플래그만 뒤에서 지워 나머지 순서를 유지한다. */
  private removePendingParentFlags(checked: Set<number>): void {
    for (let index = this.pendingFlags.length - 1;index >= 0;index--) {
      const [file, , flag] = this.pendingFlags[index];
      if (!checked.has(file) || flag !== 'missing-parent') continue;
      this.pendingFlags.splice(index, 1);
    }
  }

  /** 선택한 DTO·플래그를 한 SQL 트랜잭션에 적재하고 성공 뒤 버퍼를 비운다. */
  loadEvents(files: StagedFile[]): void {
    if (this.eventsLoaded) return;
    const selected = this.memory.deduplicate(files);
    this.connection.exec('BEGIN DEFERRED');
    try {
      for (const row of selected.rows) {
        this.insertEvent.run(row.id, ...eventValues(row.fileId, row.event), selected.canonical.get(row.id) ?? null);
      }
      for (const flag of this.pendingFlags) this.insertFlag.run(...flag);
      this.connection.exec('COMMIT');
      this.pendingFlags.length = 0;
      this.eventsLoaded = true;
    } catch (error) {
      this.connection.exec('ROLLBACK');
      throw error;
    }
  }

  /** 메모리 DTO와 미적재 플래그를 비워 연결 종료에 남기지 않는다. */
  close(): void {
    this.memory.clear();
    this.pendingFlags.length = 0;
  }
}
