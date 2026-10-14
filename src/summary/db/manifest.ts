import type { SqliteSession } from './connection';
import type { FileMetadata, ManifestRow, ProcessingStatus, Provider } from './types';
import { pageLimit } from './validation';

/** File discovery, accepted metadata and processing diagnostics share one database session. */
export class ManifestStore {
  constructor(private readonly database: SqliteSession) {}

  findManifest(provider: Provider, path: string): ManifestRow | undefined {
    return this.database.statement('SELECT * FROM manifest WHERE provider = ? AND path = ?')
      .get(provider, path) as unknown as ManifestRow | undefined;
  }

  /** At most two candidates are needed: multiple identities disable the move shortcut. */
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

  /** Call only after all selected roots were successfully traversed. */
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
