// 통계 SQLite 연결의 설정·마이그레이션·트랜잭션·수명을 관리한다.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { migrateSchema } from './migrations';
import { calendarPeriod } from './timezone';
import { UsageRollupStore } from './rollups';
import { modelOrderKey, modelRelease } from '../models/modelOrder';
import type { StageProfiler, StorageStage } from '../profiling';

export type SqliteSessionOptions = string | { databasePath: string; cacheKiB?: number; timezone?: string };

/** 공유 SQLite 연결·고정 쿼리 캐시·트랜잭션과 유지보수를 관리한다. */
export class SqliteSession {
  readonly connection: DatabaseSync;
  readonly rollups: UsageRollupStore;
  private closed = false;
  private lastOptimizedAt: number | undefined;
  // Cache only fixed statements, so its size is independent of files, sessions and user queries.
  private readonly statements = new Map<string, StatementSync>();

  constructor(options: SqliteSessionOptions) {
    // [연결 정책] 문자열 경로에는 기본 시간대와 캐시 크기를 적용하고 파일 DB의 상위 폴더를 준비한다.
    const path = typeof options === 'string' ? options : options.databasePath;
    const cacheKiB = typeof options === 'string' ? 4096 : options.cacheKiB ?? 4096;
    const timezone = typeof options === 'string' ? 'UTC' : options.timezone ?? 'UTC';
    if (!Number.isSafeInteger(cacheKiB) || cacheKiB < 256 || cacheKiB > 65536) {
      throw new RangeError('Database cache must be between 256 and 65536 KiB');
    }
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.connection = new DatabaseSync(path);
    try {
      // [연결 정책] WAL과 외래 키를 켜고 메인·임시 캐시 크기를 제한한다.
      this.connection.exec(`PRAGMA busy_timeout = 5000;
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;
        PRAGMA temp_store = FILE;
        PRAGMA cache_size = -${cacheKiB};
        PRAGMA temp.cache_size = -${cacheKiB};
        PRAGMA mmap_size = 0;`);

      // [스키마 정책] 날짜 집계 SQL 함수를 먼저 등록해 기존 데이터 이관에도 같은 시간대 계산을 사용한다.
      this.connection.function('agent_tracker_period', { deterministic: true }, (timestamp, timezone, unit) => {
        if (timestamp === null) return null;
        return calendarPeriod(Number(timestamp), String(timezone), unit === 'month' ? 'month' : 'day');
      });
      migrateSchema(this.connection, timezone, action => this.transaction(action));
      this.optimizeConnection(true);
      this.rollups = new UsageRollupStore(this);
      this.connection.function('agent_tracker_model_release', { deterministic: true }, model => modelRelease(String(model ?? '')));
      this.connection.function('agent_tracker_model_key', { deterministic: true }, model => modelOrderKey(String(model ?? '')));
    } catch (error) {
      this.connection.close();
      throw error;
    }
  }

  statement(sql: string): StatementSync {
    // [연결 정책] 같은 SQL은 연결이 닫힐 때까지 준비된 문장을 재사용한다.
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.connection.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  /** 동기 DB 변경을 하나의 원자적 쓰기로 묶는다. */
  transaction<T>(action: () => T, profile?: StageProfiler<StorageStage>): T {
    const execute = (stage: 'begin' | 'commit' | 'rollback', sql: string): void => {
      if (profile) profile.measure(stage, () => this.connection.exec(sql));
      else this.connection.exec(sql);
    };

    // [SQL 트랜잭션 정책] BEGIN IMMEDIATE로 잠금을 확보하고 성공 시 COMMIT, 실패 시 ROLLBACK한다.
    execute('begin', 'BEGIN IMMEDIATE');
    try {
      const result = action();
      execute('commit', 'COMMIT');
      return result;
    } catch (error) {
      execute('rollback', 'ROLLBACK');
      throw error;
    }
  }

  /**
   * 책임: 조회 계획용 통계를 과도한 유지보수 비용 없이 갱신한다.
   * 알고리즘: 첫 스캔 완료 후와 이후 하루 간격으로 main.optimize를 시도하고 성공한 시각만 기록하며 유지보수 실패는 전파하지 않는다.
   */
  optimize(): void {
    // [유지보수 정책] 마지막 성공 시각으로 하루 간격을 계산해 실패해도 다음 호출에서 다시 시도한다.
    const now = Date.now();
    if (this.lastOptimizedAt !== undefined && now - this.lastOptimizedAt < 86_400_000) return;
    if (this.optimizeConnection()) this.lastOptimizedAt = now;
  }

  close(): void {
    // [연결 정책] 열린 연결만 최적화하고 문장 캐시를 비운 뒤 닫는다.
    if (!this.closed) {
      this.optimizeConnection();
      this.statements.clear();
      this.connection.close();
      this.closed = true;
    }
  }

  private optimizeConnection(onOpen = false): boolean {
    try {
      // [유지보수 정책] 메인 DB만 최적화하고 연결을 열 때는 이번 연결에서 조회하지 않은 테이블도 검토한다.
      this.connection.exec(onOpen ? 'PRAGMA main.optimize=0x10002;' : 'PRAGMA main.optimize;');
      return true;
    } catch {
      // [유지보수 정책] 최적화 실패는 호출부에 성공 여부로만 전달한다.
      return false;
    }
  }
}
