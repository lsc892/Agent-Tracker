// 파일별 root 근거를 재사용하고 세션·요청의 의미 서명으로 입력 변경을 판별한다.
import { createHash, type Hash } from 'node:crypto';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { PRICING_VERSION } from '../models/pricing';
import type { MemoryEvents, SignatureRoot } from '../staging/memoryEvents';
import type { ComparedTurn, MetadataDependency, MetadataScope, SourceRoot, TurnKey } from './types';

interface SourceInputs {
  turns: Map<string, SourceRoot[]>;
  dependencies: Map<string, MetadataDependency>;
}

interface SignatureQueries {
  flags: StatementSync;
  main: StatementSync;
  name: StatementSync;
  sources: StatementSync;
  turns: StatementSync;
  update: StatementSync;
}

/** 파일 root 캐시를 단독 소유하고 원본 순서·이름·품질 flag를 의미 서명에 반영한다. */
export class MetadataSignatures {
  private readonly sourceRoots = new Map<number, SignatureRoot[]>();

  constructor(
    private readonly connection: DatabaseSync,
    private readonly collectCapabilities: boolean,
    private readonly memory: MemoryEvents,
  ) {}

  /** 현재 파일 근거를 모은 뒤 세션순으로 서명을 비교하고 의존 키 Map을 반환한다. */
  prepare(sessions: MetadataScope): Map<string, MetadataDependency> {
    const sources = this.collectSources(sessions);
    const queries = this.prepareQueries();
    this.updateTurnSignatures(sources.turns, queries);
    return sources.dependencies;
  }

  /** 정상 파일을 조회 순서대로 순회해 요청별 root와 중복 없는 의존 키를 수집한다. */
  private collectSources(sessions: MetadataScope): SourceInputs {
    const inputs: SourceInputs = { turns: new Map(), dependencies: new Map() };
    const files = this.connection.prepare(`SELECT f.* FROM scan_files f JOIN ${sessions} s
      ON s.provider=f.provider AND s.session_id=f.session_id WHERE f.removed=0 AND f.failed=0`).all();
    for (const file of files) this.collectFileRoots(file, inputs);
    return inputs;
  }

  /** 파일 root 캐시를 필요한 경우 한 번 채우고 각 root의 근거를 요청 키에 연결한다. */
  private collectFileRoots(file: Record<string, unknown>, inputs: SourceInputs): void {
    let roots = this.sourceRoots.get(file.id as number);
    if (!roots) {
      roots = [...this.memory.signatureRoots(file.id as number)];
      this.sourceRoots.set(file.id as number, roots);
    }
    for (const root of roots) this.collectRoot(file, root, inputs);
  }

  /** 한 root의 원본 참조를 추가하고 의존 키를 JSON 튜플 기준으로 중복 제거한다. */
  private collectRoot(file: Record<string, unknown>, root: SignatureRoot, inputs: SourceInputs): void {
    const key = JSON.stringify([file.provider, file.session_id, root.rootId]);
    let rows = inputs.turns.get(key);
    if (!rows) {
      rows = [];
      inputs.turns.set(key, rows);
    }
    rows.push({ file, root });
    for (const dependency of root.dependencies) {
      const value: MetadataDependency = [file.provider as string, file.session_id as string, root.rootId, dependency];
      inputs.dependencies.set(JSON.stringify(value), value);
    }
  }

  /** 원래 준비 순서대로 품질·대표 원본·이름·요청 비교 statement를 만든다. */
  private prepareQueries(): SignatureQueries {
    const connection = this.connection;
    return {
      flags: connection.prepare(`SELECT x.file_id,x.root_id,x.flag FROM scan_files f JOIN flags x ON x.file_id=f.id
        WHERE f.provider=? AND f.session_id=? AND f.removed=0 AND f.failed=0 AND (x.root_id=? OR x.root_id='*')
        ORDER BY x.file_id,x.root_id,x.flag`),
      main: connection.prepare(`SELECT id,project_key,project_name FROM scan_files
        WHERE provider=? AND session_id=? AND is_main=1 AND removed=0 AND failed=0 ORDER BY id LIMIT 1`),
      name: connection.prepare(`SELECT session_name FROM scan_files WHERE provider=? AND session_id=? AND is_main=1
        AND removed=0 AND failed=0 AND session_name IS NOT NULL ORDER BY id DESC LIMIT 1`),
      sources: connection.prepare(`SELECT f.id FROM scan_files f WHERE f.provider=? AND f.session_id=?
        AND f.removed=0 AND f.failed=0 AND EXISTS(SELECT 1 FROM events e WHERE e.file_id=f.id)
        ORDER BY (SELECT min(e.id) FROM events e WHERE e.file_id=f.id),f.id`),
      turns: connection.prepare(`SELECT n.provider,n.session_id,n.root_id,a.signature previous_signature,
          (t.id IS NOT NULL AND (t.last_error IS NOT NULL OR a.prepared_json IS NULL)
            OR EXISTS(SELECT 1 FROM scan_files f JOIN manifest m ON m.id=f.id
              JOIN events e ON e.file_id=f.id AND e.root_id=n.root_id
              WHERE f.provider=n.provider AND f.session_id=n.session_id
                AND f.removed=0 AND f.failed=0 AND m.parser_version<>f.parser_version)) invalid
        FROM metadata_turns n LEFT JOIN turn_metadata a
          ON a.provider=n.provider AND a.session_id=n.session_id AND a.root_id=n.root_id
        LEFT JOIN turn_summary t
          ON t.provider=n.provider AND t.session_id=n.session_id AND t.root_turn_id=n.root_id
        ORDER BY n.provider,n.session_id,n.root_id`),
      update: connection.prepare('UPDATE metadata_turns SET signature=?,dirty=? WHERE provider=? AND session_id=? AND root_id=?'),
    };
  }

  /** 세션이 바뀔 때만 공통 서명을 계산하고 각 요청의 root·flag를 차례로 비교한다. */
  private updateTurnSignatures(turns: Map<string, SourceRoot[]>, queries: SignatureQueries): void {
    let previousSession: string | undefined;
    let sessionSignature = '';
    for (const key of queries.turns.iterate() as unknown as Iterable<ComparedTurn>) {
      const session = JSON.stringify([key.provider, key.session_id]);
      if (session !== previousSession) {
        sessionSignature = this.sessionSignature(key, queries);
        previousSession = session;
      }
      this.updateTurnSignature(key, sessionSignature, turns, queries);
    }
  }

  /** 원본 상대 순서·대표 프로젝트·세션 이름과 수집·단가 버전을 한 세션 서명으로 묶는다. */
  private sessionSignature(key: TurnKey, queries: SignatureQueries): string {
    const sourceOrder = createHash('sha256');
    for (const source of queries.sources.iterate(key.provider, key.session_id)) sourceOrder.update(`${source.id},`);
    return JSON.stringify([
      this.collectCapabilities, PRICING_VERSION,
      queries.main.get(key.provider, key.session_id), queries.name.get(key.provider, key.session_id), sourceOrder.digest('hex'),
    ]);
  }

  /** 원본 근거가 있는 요청만 root 순서와 flag를 해시해 기존 서명·오류 상태와 비교한다. */
  private updateTurnSignature(
    key: ComparedTurn, sessionSignature: string, turns: Map<string, SourceRoot[]>, queries: SignatureQueries,
  ): void {
    const hash = createHash('sha256');
    // 서명 형식은 기존 캐시 전환 판정에 쓰이므로 접두사와 입력 바이트를 유지한다.
    hash.update('greedy-root-v1:');
    hash.update(sessionSignature);
    const roots = turns.get(JSON.stringify([key.provider, key.session_id, key.root_id])) ?? [];
    roots.sort((left, right) => left.root.firstId - right.root.firstId);
    const count = this.hashRoots(hash, roots);
    if (!count) return;
    for (const flag of queries.flags.iterate(key.provider, key.session_id, key.root_id)) hash.update(JSON.stringify(flag));
    const signature = hash.digest('hex');
    queries.update.run(signature, Number(key.previous_signature !== signature || key.invalid), key.provider, key.session_id, key.root_id);
  }

  /** root별 digest와 원본 귀속 필드를 기존 배열 순서로 해시에 추가하고 근거 수를 반환한다. */
  private hashRoots(hash: Hash, roots: SourceRoot[]): number {
    let count = 0;
    for (const { file, root } of roots) {
      hash.update(JSON.stringify([
        file.id, root.digest, file.is_main, file.project_key, file.project_name, file.session_name,
        file.thread_id, file.parent_thread_id, file.forked_from_id, file.parser_version,
      ]));
      count++;
    }
    return count;
  }

  /** 반영이 끝난 파일의 root 캐시만 입력 순서대로 해제한다. */
  release(fileIds: Iterable<number>): void {
    for (const id of fileIds) this.sourceRoots.delete(id);
  }

  /** 갱신 종료 시 보유한 모든 파일 root 캐시를 해제한다. */
  clear(): void {
    this.sourceRoots.clear();
  }
}
