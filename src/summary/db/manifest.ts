import type { SqliteSession } from './connection';
import type { FileMetadata, ManifestRow, ProcessingStatus, Provider } from './types';
import { pageLimit } from './validation';

/**
 * 책임: 발견한 파일의 존재 여부와 승인된 메타데이터·처리 진단을 관리한다.
 * 알고리즘: 제공자·경로 키로 관측 정보를 기록하고 세션 저장 때 메타데이터를 확정하며 목록은 ID 기반 페이지로 순회한다.
 */
export class ManifestStore {
  constructor(private readonly database: SqliteSession) {}

  findManifest(provider: Provider, path: string): ManifestRow | undefined {
    return this.database.statement('SELECT * FROM manifest WHERE provider = ? AND path = ?')
      .get(provider, path) as unknown as ManifestRow | undefined;
  }

  /**
   * 책임: 이동한 파일의 기존 identity를 모호하지 않을 때만 재사용하게 한다.
   * 알고리즘: 유효한 device·inode로 최대 두 행만 조회해 후보가 하나인지 또는 중복인지 판별할 정보를 제공한다.
   */
  findIdentity(provider: Provider, dev: string | null, inode: string | null): ManifestRow[] {
    if (!dev || !inode || dev === '0' || inode === '0') return [];
    return this.database.statement('SELECT * FROM manifest WHERE provider = ? AND dev = ? AND inode = ? LIMIT 2')
      .all(provider, dev, inode) as unknown as ManifestRow[];
  }

  /** Discovery updates presence only; accepted metadata is replaced with the session. */
  observeFile(metadata: FileMetadata, scanId: string): ManifestRow {
    return this.database.statement(`INSERT INTO manifest (
      provider, source_root, path, last_seen_scan_id, processing_status, processing_position, recorded_at
    ) VALUES (?, ?, ?, ?, 'processing', 'discovery', ?)
    ON CONFLICT(provider, path) DO UPDATE SET last_seen_scan_id = excluded.last_seen_scan_id
    RETURNING *`)
      .get(metadata.provider, metadata.source_root, metadata.path, scanId, new Date().toISOString()) as unknown as ManifestRow;
  }

  markSeen(id: number, scanId: string): void {
    this.database.statement('UPDATE manifest SET last_seen_scan_id = ? WHERE id = ?').run(scanId, id);
  }

  setManifestDiagnostic(id: number, status: ProcessingStatus, position: string | null, error: string | null, offset: number | null = null): void {
    this.database.transaction(() => {
      const file = this.database.statement('SELECT provider, session_id FROM manifest WHERE id = ?').get(id);
      if (!file) throw new Error('Unknown manifest file');
      this.database.statement(`UPDATE manifest SET processing_status = ?, processing_position = ?, recorded_at = ?, last_error = ? WHERE id = ?`)
        .run(status, position, new Date().toISOString(), error, id);
      if (status === 'error' || status === 'interrupted') {
        this.database.statement(`UPDATE turn_summary SET diagnostic_file_id = ?, diagnostic_offset = ?, last_error = ?
          WHERE provider = ? AND session_id = ?`)
          .run(id, offset, error ?? status, file.provider, file.session_id);
        if (file.session_id !== null) this.database.rollups.refreshSession(file.provider as Provider, file.session_id as string);
      }
    });
  }

  *sessionFiles(provider: Provider, sessionId: string, limit = 100): IterableIterator<ManifestRow> {
    pageLimit(limit);
    let after = 0;
    const query = this.database.connection.prepare('SELECT * FROM manifest WHERE provider = ? AND session_id = ? AND id > ? ORDER BY id LIMIT ?');
    while (true) {
      const rows = query.all(provider, sessionId, after, limit) as unknown as ManifestRow[];
      for (const row of rows) yield row;
      if (rows.length < limit) return;
      after = rows[rows.length - 1].id;
    }
  }

  /**
   * 책임: 선택 루트의 전체 순회 성공 후 원본 부재 후보를 찾는다.
   * 알고리즘: 같은 제공자·루트에서 이번 scan ID로 관측하지 못한 행만 ID keyset 페이지로 반환해 다른 루트의 삭제 오판을 막는다.
   */
  *unseenFiles(provider: Provider, sourceRoot: string, scanId: string, limit = 100): IterableIterator<ManifestRow> {
    pageLimit(limit);
    let after = 0;
    const query = this.database.connection.prepare(`SELECT * FROM manifest WHERE provider = ? AND source_root = ?
      AND (last_seen_scan_id IS NULL OR last_seen_scan_id <> ?) AND id > ? ORDER BY id LIMIT ?`);
    while (true) {
      const rows = query.all(provider, sourceRoot, scanId, after, limit) as unknown as ManifestRow[];
      for (const row of rows) yield row;
      if (rows.length < limit) return;
      after = rows[rows.length - 1].id;
    }
  }
}
