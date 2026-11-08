// TEMP 방문 상태와 디스크 스택으로 부모 우선 세션 계보를 계산한다.
import type { DatabaseSync, StatementSync } from 'node:sqlite';

interface LineageFrame {
  depth: number;
  file_id: number;
  last_parent: number;
  target: string | null;
  ambiguous: number;
  blocked: number;
  parent_thread_id: string;
  previous: string;
}
interface ParentCandidate { id: number; state: number; target: string | null }
interface LineageQueries {
  nextFile: StatementSync;
  visit: StatementSync;
  push: StatementSync;
  top: StatementSync;
  parent: StatementSync;
  advance: StatementSync;
  finish: StatementSync;
  pop: StatementSync;
}

/** TEMP 작업 공간 준비 → 부모 우선 순회 → 확정 귀속·품질 경고 반영을 순서대로 실행한다. */
export function resolveLineage(connection: DatabaseSync): void {
  createLineageTables(connection);
  const queries = prepareLineageQueries(connection);
  resolvePendingFiles(queries);
  applyResolvedLineage(connection);
}

/** 정상 부모가 없거나 이미 해소된 원본을 먼저 확정하고 미해결 경로의 TEMP 스택을 만든다. */
function createLineageTables(connection: DatabaseSync): void {
  connection.exec(`CREATE TEMP TABLE lineage (
        id INTEGER PRIMARY KEY,previous TEXT NOT NULL,target TEXT,state INTEGER NOT NULL,missing INTEGER NOT NULL
      );
      CREATE INDEX temp.lineage_state ON lineage(state,id);
      CREATE TEMP TABLE lineage_stack (
        depth INTEGER PRIMARY KEY,file_id INTEGER NOT NULL,last_parent INTEGER NOT NULL DEFAULT 0,
        target TEXT,ambiguous INTEGER NOT NULL DEFAULT 0,blocked INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO lineage
        SELECT id,session_id,CASE WHEN terminal THEN session_id END,CASE WHEN terminal THEN 2 ELSE 0 END,
          parent_thread_id IS NOT NULL AND terminal
        FROM (SELECT f.*,parent_thread_id IS NULL OR NOT EXISTS(
          SELECT 1 FROM scan_files p WHERE p.provider='codex' AND p.thread_id=f.parent_thread_id
            AND p.parsed=1 AND p.removed=0 AND p.failed=0) terminal
          FROM scan_files f WHERE f.provider='codex' AND f.removed=0 AND f.thread_id IS NOT NULL AND f.session_id IS NOT NULL);
      WITH ready AS MATERIALIZED (
        SELECT child.id,CASE WHEN count(DISTINCT parent.target)=1 THEN min(parent.target) ELSE child.previous END target
        FROM lineage child JOIN scan_files f ON f.id=child.id
        JOIN scan_files p ON p.provider='codex' AND p.thread_id=f.parent_thread_id
          AND p.parsed=1 AND p.removed=0 AND p.failed=0
        JOIN lineage parent ON parent.id=p.id WHERE child.state=0
        GROUP BY child.id HAVING min(parent.state)=2
      ) UPDATE lineage SET state=2,target=ready.target FROM ready WHERE lineage.id=ready.id;`);
}

/** 방문·스택·부모 탐색 SQL을 기존 순서대로 준비해 한 번의 계보 순회에서 재사용한다. */
function prepareLineageQueries(connection: DatabaseSync): LineageQueries {
  return {
    nextFile: connection.prepare('SELECT id FROM lineage WHERE state=0 ORDER BY id LIMIT 1'),
    visit: connection.prepare('UPDATE lineage SET state=1 WHERE id=?'),
    push: connection.prepare('INSERT INTO lineage_stack(file_id) VALUES (?)'),
    top: connection.prepare(`SELECT s.*,f.parent_thread_id,l.previous FROM lineage_stack s
      JOIN scan_files f ON f.id=s.file_id JOIN lineage l ON l.id=s.file_id ORDER BY depth DESC LIMIT 1`),
    parent: connection.prepare(`SELECT l.id,l.state,l.target FROM scan_files p JOIN lineage l ON l.id=p.id
      WHERE p.provider='codex' AND p.thread_id=? AND p.parsed=1 AND p.removed=0 AND p.failed=0 AND p.id>?
      ORDER BY p.id LIMIT 1`),
    advance: connection.prepare(`UPDATE lineage_stack SET last_parent=?,target=?,ambiguous=?,blocked=? WHERE depth=?`),
    finish: connection.prepare('UPDATE lineage SET state=2,target=? WHERE id=?'),
    pop: connection.prepare('DELETE FROM lineage_stack WHERE depth=?'),
  };
}

/** ID가 앞선 미해결 원본을 시작점으로 선택하고 그 부모 경로를 끝까지 해소한다. */
function resolvePendingFiles(queries: LineageQueries): void {
  while (true) {
    const next = queries.nextFile.get() as { id: number } | undefined;
    if (!next) return;
    visitFile(queries, next.id);
    resolveParentPath(queries);
  }
}

/** 방문 중인 원본의 부모를 먼저 확정하고 순환·모호한 후보는 현재 경로에 표시한다. */
function resolveParentPath(queries: LineageQueries): void {
  while (true) {
    const frame = queries.top.get() as LineageFrame | undefined;
    if (!frame) return;
    const candidate = queries.parent.get(frame.parent_thread_id, frame.last_parent) as ParentCandidate | undefined;
    if (candidate?.state === 0) {
      visitFile(queries, candidate.id);
      continue;
    }
    if (candidate) {
      advanceParent(queries, frame, candidate);
      continue;
    }
    finishFrame(queries, frame);
  }
}

/** 원본을 방문 중으로 표시한 뒤 부모 해소용 스택에 올린다. */
function visitFile(queries: LineageQueries, fileId: number): void {
  queries.visit.run(fileId);
  queries.push.run(fileId);
}

/** 부모 후보의 최종 세션 차이와 방문 역방향 간선을 기록하고 다음 후보로 진행한다. */
function advanceParent(queries: LineageQueries, frame: LineageFrame, candidate: ParentCandidate): void {
  const ambiguous = Boolean(frame.ambiguous || frame.target !== null && candidate.target !== null && frame.target !== candidate.target);
  const blocked = Boolean(frame.blocked || candidate.state === 1 || candidate.target === null);
  queries.advance.run(candidate.id, frame.target ?? candidate.target, Number(ambiguous), Number(blocked), frame.depth);
}

/** 부모 후보를 모두 읽은 경로의 귀속을 확정하고 해당 스택 프레임을 제거한다. */
function finishFrame(queries: LineageQueries, frame: LineageFrame): void {
  let target = frame.ambiguous ? frame.previous : frame.target;
  if (frame.blocked) target = null;
  queries.finish.run(target, frame.file_id);
  queries.pop.run(frame.depth);
}

/** 달라진 귀속·연결 성분과 누락 부모 경고를 반영한 뒤 계보 TEMP 작업 공간을 지운다. */
function applyResolvedLineage(connection: DatabaseSync): void {
  connection.exec(`INSERT OR IGNORE INTO affected SELECT 'codex',target FROM lineage WHERE target<>previous;
      INSERT OR IGNORE INTO affected SELECT 'codex',previous FROM lineage WHERE target<>previous;
      INSERT OR IGNORE INTO links SELECT 'codex',previous,target FROM lineage WHERE target<>previous;
      UPDATE scan_files SET session_id=(SELECT target FROM lineage WHERE lineage.id=scan_files.id)
        WHERE id IN(SELECT id FROM lineage WHERE target<>previous);
      DELETE FROM flags WHERE flag='missing-parent-agent';
      INSERT OR IGNORE INTO flags SELECT l.id,'*','missing-parent-agent' FROM lineage l JOIN scan_files f ON f.id=l.id
        WHERE f.parent_thread_id IS NOT NULL AND f.parsed=1 AND (l.missing=1 OR l.target IS NULL);
      DROP TABLE lineage_stack;DROP TABLE lineage;
    `);
}
