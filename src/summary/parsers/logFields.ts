// JSONL fields consumed by the provider adapters and the optional Codex name index.
import type { JsonFields, JsonShape } from '../jsonl/projection';
import type { Provider } from '../types';
import { tokenFields } from './common';

const scalar: JsonShape = {};

function fields(...names: string[]): JsonFields {
  return Object.fromEntries(names.map(name => [name, scalar]));
}

function select(variants: Readonly<Record<string, JsonFields>>): (type: unknown) => JsonFields | undefined {
  return type => typeof type === 'string' && Object.hasOwn(variants, type) ? variants[type] : undefined;
}

const billing = { billing_mode: true, auth_mode: true } as const;
const tokens = fields(...tokenFields);
const codexUsage: JsonShape = { fields: { ...tokens, input_tokens_details: { fields: fields('cached_tokens', 'cache_write_tokens') } } };
const titleText = { text: { deferred: true } } as const;
const titleContent: JsonShape = { items: { objectOnly: true, variant: select({ text: titleText, input_text: titleText }) } };
const deferredScalar: JsonShape = { deferred: true };
export const capabilityArguments: JsonShape = { fields: Object.fromEntries(
  ['agent_type', 'cmd', 'command', 'file_path', 'name', 'path', 'skill', 'subagent_type'].map(name => [name, deferredScalar]),
) };
export const spawnOutput: JsonShape = { deferred: true, fields: fields('agent_id', 'task_name') };

function claudeFields(collectCapabilities: boolean): JsonShape {
  // [파싱 정책] 행 유형마다 식별·제목·사용량 필드를 고르고 도구 분석이 켜졌을 때만 호출 내용을 보관한다.
  const identity = fields('cwd', 'promptId', 'sessionId');
  const tools: JsonShape = { deferred: true, items: { objectOnly: true, variant: select({ tool_use: {
    ...fields('id', 'name'), input: { ...capabilityArguments, deferred: true },
  } }) } };
  const variants = select({
    'ai-title': { ...identity, ...fields('aiTitle') },
    'custom-title': { ...identity, ...fields('customTitle') },
    user: { ...identity, ...fields('isMeta', 'isSidechain', 'timestamp', 'uuid'),
      message: { fields: { content: { ...titleContent, deferred: true } } } },
    assistant: {
      ...identity, ...fields('isApiErrorMessage', 'requestId', 'timestamp'),
      message: { fields: { ...fields('id', 'model', 'stop_reason'), billing_mode: true,
        usage: { fields: tokens, keepNonempty: true }, ...(collectCapabilities ? { content: tools } : {}) } },
    },
    system: { ...identity, ...fields('durationMs', 'preventedContinuation', 'timestamp'), subtype: true },
  });
  // Unknown Claude row types can still update identity or the current request.
  return { fields: billing, variant: type => typeof type === 'string' && type ? variants(type) ?? identity : undefined };
}

function codexFields(collectCapabilities: boolean): JsonShape {
  const lineage: JsonShape = { fields: { subagent: { fields: { thread_spawn: { fields: fields('agent_path', 'parent_thread_id') } } } } };
  const turn = fields('root_turn_id', 'turn_id');
  const callIds = fields('call_id', 'id');
  const args = { ...capabilityArguments, deferred: true };
  const toolCall = { ...callIds, ...fields('name'), arguments: args, input: args };
  const completed = fields('completed_at', 'duration_ms');
  // [파싱 정책] 집계 설정과 별개로 자식 생성 추적에 필요한 호출과 결과 식별자를 유지한다.
  const responseVariant = select({
    function_call_output: { ...callIds, output: spawnOutput },
    function_call: collectCapabilities ? toolCall : { name: scalar, call_id: { deferred: true }, id: { deferred: true } },
    ...(collectCapabilities ? { custom_tool_call: toolCall } : {}),
  });
  // [파싱 정책] 행 유형과 이벤트 유형마다 사용할 payload를 정해 필요한 값의 해석을 늦춘다.
  const variants = select({
    session_meta: { payload: { fields: { ...billing,
      ...fields('agent_path', 'cwd', 'forked_from_id', 'id', 'model', 'name', 'parent_thread_id', 'session_id', 'thread_name', 'title'),
      source: lineage, thread_source: lineage,
    } } },
    turn_context: { payload: { fields: { ...turn, ...billing, model: scalar } } },
    token_usage_record: { payload: { fields: { ...turn, ...billing, ...fields('model', 'response_id', 'session_id', 'thread_id'),
      usage: codexUsage, turn_token_usage: { fields: tokens },
    } } },
    event_msg: { timestamp: { deferred: true }, payload: { fields: turn, variant: select({
      task_started: fields('started_at'),
      task_complete: completed,
      task_completed: completed,
      turn_aborted: fields('completed_at'),
      user_message: { id: scalar, message: titleContent },
      token_count: { ...billing, model: scalar, info: { deferred: true,
        fields: { total_token_usage: codexUsage, last_token_usage: codexUsage } } },
    }) } },
    response_item: { payload: { variant: type => typeof type === 'string' ? responseVariant(type) : collectCapabilities ? toolCall : undefined } },
  });
  // The adapter also checks explicit roots when an old non-string type stringifies to a known type.
  const legacyType = { payload: { fields: { root_turn_id: scalar } } };
  return { variant: type => typeof type === 'string' ? variants(type) : legacyType };
}

const sourceShapes = {
  claude: { withTools: claudeFields(true), withoutTools: claudeFields(false) },
  codex: { withTools: codexFields(true), withoutTools: codexFields(false) },
};

export function sourceFields(provider: Provider, collectCapabilities: boolean): JsonShape {
  return collectCapabilities ? sourceShapes[provider].withTools : sourceShapes[provider].withoutTools;
}
