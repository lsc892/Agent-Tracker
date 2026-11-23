// 응답 그룹별 최종 반영값을 저장하고 증분 합산에 필요한 값을 읽는다.
import type { TokenVector } from '../types';
import type { SqliteSession } from './connection';
import type { Provider, SessionRef } from './types';

export interface AppliedResponse {
  provider: Provider;
  sessionId: string;
  responseKey: string;
  rootId: string;
  tokens: Pick<TokenVector, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>;
}

export interface AppliedRequestTotals {
  provider: Provider;
  sessionId: string;
  rootId: string;
  tokens: { input: number; output: number; cacheRead: number | null; cacheWrite: number | null };
}

const UPSERT_RESPONSE = `INSERT INTO applied_response(
  turn_id,response_key,input_tokens,output_tokens,cache_read,cache_write
) SELECT id,?,?,?,?,? FROM turn_summary WHERE provider=? AND session_id=? AND root_turn_id=?
ON CONFLICT(turn_id,response_key) DO UPDATE SET
  (input_tokens,output_tokens,cache_read,cache_write)=
  (excluded.input_tokens,excluded.output_tokens,excluded.cache_read,excluded.cache_write)
WHERE (input_tokens,output_tokens,cache_read,cache_write) IS NOT
  (excluded.input_tokens,excluded.output_tokens,excluded.cache_read,excluded.cache_write)`;

const SELECT_TURNS = `FROM json_each(?) requested CROSS JOIN turn_summary turn
  ON turn.provider=json_extract(requested.value,'$[0]') AND turn.session_id=json_extract(requested.value,'$[1]')`;
const SELECT_RESPONSES = `${SELECT_TURNS} CROSS JOIN applied_response response ON response.turn_id=turn.id`;

interface ResponseRow {
  provider: Provider;
  session_id: string;
  response_key: string;
  root_turn_id: string;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
}

const sessionPairs = (sessions: readonly SessionRef[]): string =>
  JSON.stringify(sessions.map(session => [session.provider, session.session_id]));
const responseAddress = ({ provider, sessionId, responseKey }: Pick<AppliedResponse, 'provider' | 'sessionId' | 'responseKey'>): string =>
  JSON.stringify([provider, sessionId, responseKey]);
const responseLocation = ({ provider, sessionId, responseKey, rootId }: Omit<AppliedResponse, 'tokens'>): string =>
  JSON.stringify([provider, sessionId, responseKey, rootId]);
const responseFromRow = (row: ResponseRow): AppliedResponse => ({
  provider: row.provider, sessionId: row.session_id, responseKey: row.response_key, rootId: row.root_turn_id,
  tokens: { input: row.input_tokens, output: row.output_tokens, cacheRead: row.cache_read, cacheWrite: row.cache_write },
});

/** 최종 합계와 같은 트랜잭션에서 반영 응답을 갱신한다. */
export class AppliedResponseStore {
  constructor(private readonly database: SqliteSession) {}

  *loadSessions(sessions: readonly SessionRef[]): IterableIterator<AppliedResponse> {
    if (!sessions.length) return;
    const select = this.database.statement(`SELECT turn.provider,turn.session_id,turn.root_turn_id,response.response_key,
      response.input_tokens,response.output_tokens,response.cache_read,response.cache_write ${SELECT_RESPONSES}`);
    const rows = select.iterate(sessionPairs(sessions)) as unknown as Iterable<ResponseRow>;
    for (const row of rows) yield responseFromRow(row);
  }

  *loadTotals(sessions: readonly SessionRef[]): IterableIterator<AppliedRequestTotals> {
    if (!sessions.length) return;
    const rows = this.database.statement(`SELECT turn.provider,turn.session_id,turn.root_turn_id,
      turn.input_tokens,turn.output_tokens,turn.cache_read_input_tokens,turn.cache_write_input_tokens ${SELECT_TURNS}`)
      .iterate(sessionPairs(sessions));
    for (const row of rows)
      yield { provider: row.provider as Provider, sessionId: row.session_id as string, rootId: row.root_turn_id as string,
        tokens: { input: row.input_tokens as number, output: row.output_tokens as number,
          cacheRead: row.cache_read_input_tokens as number | null, cacheWrite: row.cache_write_input_tokens as number | null } };
  }

  replace(
    responses: readonly AppliedResponse[], sessions: readonly SessionRef[],
    preserve: (row: Pick<AppliedResponse, 'provider' | 'sessionId' | 'rootId'>) => boolean,
  ): void {
    const preserved = new Set<string>();
    if (sessions.length) {
      const select = this.database.statement(`SELECT turn.id,turn.provider,turn.session_id,turn.root_turn_id,response.response_key
        ${SELECT_RESPONSES}`);
      const previous = select.all(sessionPairs(sessions));
      if (previous.length) {
        const live = new Set(responses.map(responseLocation));
        const remove = this.database.statement('DELETE FROM applied_response WHERE turn_id=? AND response_key=?');
        for (const row of previous) {
          const address = { provider: row.provider as Provider, sessionId: row.session_id as string,
            responseKey: row.response_key as string, rootId: row.root_turn_id as string };
          if (preserve(address)) preserved.add(responseAddress(address));
          else if (!live.has(responseLocation(address))) remove.run(row.id as number, address.responseKey);
        }
      }
    }
    const save = this.database.statement(UPSERT_RESPONSE);
    for (const response of responses) {
      if (preserve(response) || preserved.size && preserved.has(responseAddress(response))) continue;
      const { provider, sessionId, responseKey, rootId, tokens } = response;
      save.run(responseKey, tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite, provider, sessionId, rootId);
    }
  }
}
