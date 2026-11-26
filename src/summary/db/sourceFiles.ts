// 원본 로그의 등록·메타데이터 조회·처리 진단을 맡는다.
import type { SqliteSession } from './connection';
import type { FileMetadata, SourceFileRow, ProcessingStatus, Provider, StoredSourceRelation } from './types';
import { pageLimit } from './validation';

// node:sqlite truncates TEXT returned to JS at an embedded NUL. Read those IDs as bytes.
export const SOURCE_THREAD_ID = 'CASE WHEN instr(thread_id,char(0))>0 THEN CAST(thread_id AS BLOB) ELSE thread_id END AS thread_id';

export function sourceThreadId(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
}

/** 파일 식별·진단과 세션별 파일 조회를 관리한다. */
export class SourceFileStore {
  constructor(private readonly database: SqliteSession) {}

  loadRelations(fileId: number): StoredSourceRelation | undefined {
    const row = this.database.statement(`SELECT ${SOURCE_THREAD_ID},thread_usage FROM source_file WHERE id=?`).get(fileId);
    const threadId = sourceThreadId(row?.thread_id);
    if (threadId === undefined) return;
    const identity = { threadId };
    return row?.thread_usage === 1 ? { identity, threadUsage: true } : { identity };
  }

  codexThreadIds(): Map<number, string> {
    const rows = this.database.statement(`SELECT id,${SOURCE_THREAD_ID} FROM source_file WHERE provider='codex' AND thread_id IS NOT NULL`)
      .iterate();
    const ids = new Map<number, string>();
    for (const row of rows) {
      const threadId = sourceThreadId(row.thread_id);
      if (typeof row.id === 'number' && threadId !== undefined) ids.set(row.id, threadId);
    }
    return ids;
  }

  findSourceFile(provider: Provider, path: string): SourceFileRow | undefined {
    return this.database.statement('SELECT * FROM source_file WHERE provider = ? AND path = ?')
      .get(provider, path) as unknown as SourceFileRow | undefined;
  }

  /** 실패를 기록할 신규 원본 행을 준비하고, 이미 저장한 원본의 메타데이터를 보존한다. */
  observeFile(metadata: FileMetadata): SourceFileRow {
    const { provider, source_root, path } = metadata;
    const inserted = this.database.statement(`INSERT INTO source_file (
      provider, source_root, path, processing_status, processing_position, recorded_at
    ) VALUES (?, ?, ?, 'processing', 'discovery', ?)
    ON CONFLICT(provider, path) DO NOTHING
    RETURNING *`)
      .get(provider, source_root, path, new Date().toISOString()) as unknown as SourceFileRow | undefined;
    const file = inserted ?? this.findSourceFile(provider, path);
    if (!file) throw new Error('Source file observation did not return a row');
    return file;
  }

  setSourceDiagnostic(id: number, status: ProcessingStatus, position: string | null, error: string | null): void {
    const updated = this.database.statement(`UPDATE source_file
      SET processing_status=?, processing_position=?, recorded_at=?, last_error=? WHERE id=?`)
      .run(status, position, new Date().toISOString(), error, id);
    if (!updated.changes) throw new Error('Unknown source_file file');
  }

  *sessionFiles(provider: Provider, sessionId: string, limit = 100): IterableIterator<SourceFileRow> {
    pageLimit(limit);
    let after = 0;
    const query = this.database.connection.prepare('SELECT * FROM source_file WHERE provider = ? AND session_id = ? AND id > ? ORDER BY id LIMIT ?');
    while (true) {
      const rows = query.all(provider, sessionId, after, limit) as unknown as SourceFileRow[];
      for (const row of rows) yield row;
      if (rows.length < limit) return;
      after = rows[rows.length - 1].id;
    }
  }
}
