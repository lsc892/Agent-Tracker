// 정규화 이벤트를 SQL 적재와 원본 의미 서명에 같은 열 순서로 전달한다.
import type { ParseEvent } from '../types';
import type { MemoryAnchor } from './memoryEvents';

export const EVENT_COLUMNS = ['file_id','kind','root_id','response_id','request_id','thread_id','turn_id',
  'input','output','cache_read','cache_write','reasoning','is_main','started','completed_at','last_assistant',
  'duration','duration_quality','completed','status','status_at','flags','byte_offset','schema_kind','model',
  'billing_mode','category','name','event_key','request_title'] as const;

export function eventValues(fileId: number, event: ParseEvent | MemoryAnchor): (string | number | null)[] {
  const usage = event.kind === 'usage' || event.kind === 'check' ? event : undefined;
  const turn = event.kind === 'turn' ? event : undefined;
  const capability = event.kind === 'capability' ? event : undefined;
  return [fileId,event.kind,event.rootId,
    event.kind === 'usage' ? event.responseId : null,event.kind === 'usage' ? event.requestId : null,
    usage?.threadId ?? capability?.threadId ?? null,usage?.turnId ?? null,usage?.tokens.input ?? null,usage?.tokens.output ?? null,
    usage?.tokens.cacheRead ?? null,usage?.tokens.cacheWrite ?? null,usage?.tokens.reasoning ?? null,
    turn ? Number(turn.isMain) : null,turn?.startedAt ?? null,turn?.completedAt ?? null,turn?.lastAssistantAt ?? null,
    turn?.duration ?? null,turn?.durationQuality ?? null,turn?.completed ? 1 : 0,
    turn?.status ?? null,turn?.statusAt ?? null,null,event.offset,event.kind === 'usage' ? event.schema ?? null : null,
    event.kind === 'usage' ? event.model ?? '' : null,event.kind === 'usage' ? event.billingMode ?? 'unknown' : null,
    capability?.category ?? null,capability?.name ?? null,capability?.eventId ?? null,turn?.title ?? null];
}
