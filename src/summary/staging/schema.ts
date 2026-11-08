// staging TEMP 표의 생성·정리를 같은 연결 수명에 묶는다.
import type { DatabaseSync } from 'node:sqlite';

/** 원본·이벤트·연결 성분의 TEMP 표와 인덱스를 기존 순서대로 만든다. */
export function createStagingSchema(connection: DatabaseSync): void {
  connection.exec(`
      CREATE TEMP TABLE scan_files (
        id INTEGER PRIMARY KEY, provider TEXT NOT NULL, source_root TEXT NOT NULL, path TEXT NOT NULL,
        session_id TEXT, old_session TEXT, size_bytes INTEGER NOT NULL, mtime_ms REAL NOT NULL,
        dev TEXT, inode TEXT, parser_version INTEGER NOT NULL, capabilities_collected INTEGER NOT NULL, changed INTEGER NOT NULL,
        source_identity TEXT, content_hash TEXT, reconnection_checked INTEGER NOT NULL DEFAULT 0,
        parsed INTEGER NOT NULL DEFAULT 0, removed INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
        settled INTEGER NOT NULL DEFAULT 0,
        project_key TEXT, project_name TEXT, session_name TEXT, thread_id TEXT, parent_thread_id TEXT, forked_from_id TEXT, is_main INTEGER DEFAULT 1
      );
      CREATE INDEX temp.scan_session ON scan_files(provider,session_id,id);
      CREATE INDEX temp.scan_old_session ON scan_files(provider,old_session,id);
      CREATE INDEX temp.scan_thread ON scan_files(provider,thread_id);
      CREATE INDEX temp.scan_source ON scan_files(provider,source_identity);
      CREATE TEMP TABLE source_reconnections(old_id INTEGER PRIMARY KEY,new_id INTEGER NOT NULL);
      CREATE TEMP TABLE affected(provider TEXT NOT NULL, session_id TEXT NOT NULL, PRIMARY KEY(provider,session_id));
      CREATE TEMP TABLE links(provider TEXT NOT NULL, a TEXT NOT NULL,b TEXT NOT NULL, PRIMARY KEY(provider,a,b));
      CREATE TEMP TABLE component(provider TEXT NOT NULL,session_id TEXT NOT NULL,PRIMARY KEY(provider,session_id));
      CREATE TEMP TABLE session_names(provider TEXT NOT NULL,session_id TEXT NOT NULL,session_name TEXT NOT NULL,
        priority INTEGER NOT NULL,PRIMARY KEY(provider,session_id)) WITHOUT ROWID;
      CREATE TEMP TABLE events (
        id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL, kind TEXT NOT NULL, root_id TEXT NOT NULL,
        response_id TEXT, request_id TEXT, thread_id TEXT, turn_id TEXT, model TEXT, billing_mode TEXT,
        input INTEGER,output INTEGER,cache_read INTEGER,cache_write INTEGER,reasoning INTEGER,
        is_main INTEGER,started INTEGER,completed_at INTEGER,last_assistant INTEGER,duration INTEGER,
        duration_quality TEXT,completed INTEGER,status TEXT,status_at INTEGER,flags TEXT,byte_offset INTEGER NOT NULL,schema_kind TEXT,
        category TEXT,name TEXT,event_key TEXT,request_title TEXT,canonical_request TEXT
      );
      CREATE INDEX temp.events_file ON events(file_id,id);
      CREATE INDEX temp.events_file_root ON events(file_id,root_id,kind);
      CREATE INDEX temp.events_response ON events(kind,response_id,request_id,file_id);
      CREATE INDEX temp.events_turn ON events(kind,thread_id,turn_id,id);
      CREATE TEMP TABLE flags(file_id INTEGER NOT NULL,root_id TEXT NOT NULL,flag TEXT NOT NULL,
        PRIMARY KEY(file_id,root_id,flag));
    `);
}

/** 남은 계보·집계 표와 기본 staging 표를 기존 해제 순서대로 제거한다. */
export function dropStagingSchema(connection: DatabaseSync): void {
  connection.exec(`DROP TABLE IF EXISTS temp.lineage_stack; DROP TABLE IF EXISTS temp.lineage;
      DROP TABLE IF EXISTS temp.summary_batch;
      DROP TABLE IF EXISTS temp.prepared_turns; DROP TABLE IF EXISTS temp.winners; DROP TABLE IF EXISTS temp.capability_winners; DROP TABLE IF EXISTS temp.component_events;
      DROP TABLE temp.flags; DROP TABLE temp.events; DROP TABLE temp.component; DROP TABLE temp.links;
      DROP TABLE temp.affected; DROP TABLE temp.scan_files; DROP TABLE temp.session_names; DROP TABLE temp.source_reconnections;`);
}
