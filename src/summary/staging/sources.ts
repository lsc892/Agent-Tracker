// 원본 관측·귀속·이동과 파일 페이지 조회를 담당한다.
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { FileMetadata, ManifestRow } from '../db/types';
import type { ParsedIdentity, Provider } from '../types';
import type { StagedFile } from './types';

/** 한 연결의 임시 원본 상태와 영향 세션 쓰기를 관리한다. */
export class StagingSources {
  private readonly insertAffected: StatementSync;

  /** 같은 연결의 원본 쓰기와 독립 agent 통지를 준비한다. */
  constructor(private readonly connection: DatabaseSync, private readonly collectCapabilities: boolean,
    private readonly standaloneSubagent: (fileId: number) => void) {
    this.insertAffected = connection.prepare('INSERT OR IGNORE INTO affected VALUES (?,?)');
  }

  /** 관측한 원본 상태를 저장하고 바뀐 이전 세션을 영향 목록에 넣는다. */
  addFile(file: FileMetadata & { id: number }, oldSession: string | null, changed: boolean, removed = false): void {
    this.connection.prepare(`INSERT OR REPLACE INTO scan_files
        (id,provider,source_root,path,session_id,old_session,size_bytes,mtime_ms,dev,inode,parser_version,capabilities_collected,changed,removed,
          source_identity,content_hash)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(file.id, file.provider, file.source_root, file.path, file.session_id, oldSession,
      file.size_bytes, file.mtime_ms, file.dev, file.inode, file.parser_version, Number(this.collectCapabilities), Number(changed), Number(removed),
      file.source_identity ?? null, file.content_hash ?? null);
    if (changed && oldSession) this.affect(file.provider, oldSession);
  }

  /** 제공자·세션 키를 영향 목록에 중복 없이 추가한다. */
  affect(provider: Provider, session: string): void {
    this.insertAffected.run(provider, session);
  }

  /** 확인한 원본 귀속을 저장하고 독립 agent·세션 변경을 처리한다. */
  identity(fileId: number, identity: ParsedIdentity): void {
    const previous = this.connection.prepare('SELECT * FROM scan_files WHERE id=?').get(fileId) as unknown as StagedFile;
    this.connection.prepare(`UPDATE scan_files SET session_id=?,project_key=?,project_name=?,session_name=?,thread_id=?,parent_thread_id=?,forked_from_id=?,is_main=?,parsed=1 WHERE id=?`)
      .run(identity.sessionId, identity.projectKey, identity.projectName, identity.sessionName ?? null,
        identity.threadId, identity.parentThreadId, identity.forkedFromId ?? null, Number(identity.isMain), fileId);
    if (identity.standaloneSubagent) {
      this.standaloneSubagent(fileId);
    }
    this.affect(previous.provider, identity.sessionId);
    if (previous.old_session && previous.old_session !== identity.sessionId) {
      this.connection.prepare('INSERT OR IGNORE INTO links VALUES (?,?,?)').run(previous.provider, previous.old_session, identity.sessionId);
    }
  }

  /** 실패한 원본을 표시해 해당 연결 성분의 교체를 막는다. */
  fail(fileId: number): void { this.connection.prepare('UPDATE scan_files SET failed=1 WHERE id=?').run(fileId); }

  /** 승인할 원본 식별자와 내용 해시를 임시 원본 상태에 기록한다. */
  acceptFingerprint(fileId: number, identity: string | null, hash: string | null): void {
    this.connection.prepare('UPDATE scan_files SET source_identity=?,content_hash=? WHERE id=?').run(identity, hash, fileId);
  }

  /** 관측하지 않은 같은 원본 후보를 ID 순서로 100행씩 읽는다. */
  *moveCandidates(file: StagedFile, scanId: string): Generator<ManifestRow> {
    let after = 0;
    const query = this.connection.prepare(`SELECT m.* FROM manifest m WHERE m.provider=? AND m.source_identity=? AND m.id>?
        AND m.id<>? AND m.session_id IS NOT NULL AND m.content_hash IS NOT NULL AND m.size_bytes>0 AND m.size_bytes<=?
        AND (m.last_seen_scan_id IS NULL OR m.last_seen_scan_id<>?)
        AND NOT EXISTS(SELECT 1 FROM source_reconnections r WHERE r.old_id=m.id) ORDER BY m.id LIMIT 100`);
    while (true) {
      const rows = query.all(file.provider, file.source_identity!, after, file.id, file.size_bytes, scanId) as unknown as ManifestRow[];
      if (!rows.length) return;
      for (const row of rows) {
        after = row.id;
        yield row;
      }
    }
  }

  /** 검증된 이전 원본을 삭제 후보로 묶고 현재 원본과 연결한다. */
  reconnectSource(previous: ManifestRow, current: StagedFile): void {
    this.addFile(previous, previous.session_id, true, true);
    this.connection.prepare('INSERT INTO source_reconnections VALUES (?,?)').run(previous.id, current.id);
    if (previous.session_id !== current.session_id) {
      this.connection.prepare('INSERT OR IGNORE INTO links VALUES (?,?,?)').run(current.provider, previous.session_id, current.session_id);
    }
  }

  /** 현재 연결 성분의 검증된 원본 이동 쌍을 순회한다. */
  reconnectedFiles(): Iterable<{ old_id: number; new_id: number }> {
    return this.connection.prepare(`SELECT r.old_id,r.new_id FROM source_reconnections r JOIN scan_files f ON f.id=r.old_id
        JOIN component c ON c.provider=f.provider AND c.session_id=f.old_session`).iterate() as unknown as Iterable<{ old_id: number; new_id: number }>;
  }

  /** 조건에 맞는 임시 원본을 ID 순서로 100행씩 순회한다. */
  *files(sql: string, parameters: (string | number)[] = []): Generator<StagedFile> {
    let after = 0;
    while (true) {
      const rows = this.connection.prepare(`SELECT * FROM scan_files WHERE id>? AND (${sql}) ORDER BY id LIMIT 100`)
        .all(after, ...parameters) as unknown as StagedFile[];
      if (!rows.length) return;
      for (const row of rows) {
        after = row.id;
        yield row;
      }
    }
  }
}
