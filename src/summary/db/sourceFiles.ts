// 원본 로그의 등록·메타데이터 조회·처리 진단을 맡는다.
import { deserialize } from 'node:v8';
import type { SqliteSession } from './connection';
import type { FileMetadata, SourceFileRow, ProcessingStatus, Provider, SourceRelationMetadata } from './types';
import { pageLimit } from './validation';

/** 파일 식별·진단과 세션별 파일 조회를 관리한다. */
export class SourceFileStore {
  constructor(private readonly database: SqliteSession) {}

  loadRelations(fileId: number): SourceRelationMetadata | undefined {
    const row = this.database.statement('SELECT relation_meta FROM source_file WHERE id=?').get(fileId);
    if (row?.relation_meta instanceof Uint8Array) return deserialize(row.relation_meta) as SourceRelationMetadata;
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

  setSourceDiagnostic(id: number, status: ProcessingStatus, position: string | null, error: string | null, offset: number | null = null): void {
    this.database.transaction(() => {
      const file = this.database.statement('SELECT provider, session_id FROM source_file WHERE id = ?').get(id);
      if (!file) throw new Error('Unknown source_file file');
      this.database.statement(`UPDATE source_file SET processing_status = ?, processing_position = ?, recorded_at = ?, last_error = ? WHERE id = ?`)
        .run(status, position, new Date().toISOString(), error, id);
      if (status !== 'error' && status !== 'interrupted') return;
      this.database.statement(`UPDATE turn_summary SET diagnostic_file_id = ?, diagnostic_offset = ?, last_error = ?
          WHERE provider = ? AND session_id = ?`)
        .run(id, offset, error ?? status, file.provider, file.session_id);
    });
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
