import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeParserAdapter, CodexCurrentParserAdapter, claudeTokens,codexTokens } from '../src/summary/parsers';
import type { ParseEvent, ParsedIdentity, UsageEvent } from '../src/summary/types';

function codex(rows: Record<string,unknown>[]): ParseEvent[] {
  const events: ParseEvent[] = [];
  const parser = new CodexCurrentParserAdapter({provider:'codex',path:'/sessions/test.jsonl',sourceRoot:'/sessions',fileId:1},{identity:()=>undefined,event:event=>events.push(event)});
  parser.row({type:'session_meta',payload:{id:'thread-one',cwd:'/project'}},0);
  for (const row of rows) parser.row(row,1);
  parser.finish();return events;
}
test('provider cache and reasoning normalization does not double-count components',() => {
  assert.equal(claudeTokens({input_tokens:100,cache_creation_input_tokens:300,cache_read_input_tokens:600,output_tokens:50}).input,1000);
  const tokens = codexTokens({input_tokens:1000,cached_input_tokens:600,output_tokens:100,reasoning_output_tokens:40});
  assert.equal(tokens.input + tokens.output,1100);
});
test('Claude tool results retain the current external prompt without inventing another root',() => {
  const events: ParseEvent[] = [];let identity: ParsedIdentity | undefined;
  const parser = new ClaudeParserAdapter({provider:'claude',path:'/projects/session.jsonl',sourceRoot:'/projects',fileId:1},{identity:value=>{identity=value;},event:event=>events.push(event)});
  parser.row({type:'user',sessionId:'s',promptId:'p',message:{content:'prompt'}},0);
  parser.row({type:'user',promptId:'p',message:{content:[{type:'tool_result',content:'synthetic'}]}},1);
  parser.row({type:'assistant',message:{id:'m',usage:{input_tokens:10,output_tokens:2}}},2);parser.finish();
  assert.equal(events.filter(event=>event.kind==='turn' && event.startedAt !== undefined).length,1);
  assert.equal(events.find(event=>event.kind==='usage')!.rootId,'p');assert.equal(identity!.sessionId,'s');
});
test('current Codex uses response usage and treats cumulative snapshots as validation only',() => {
  const events = codex([{type:'event_msg',payload:{type:'task_started',turn_id:'t',root_turn_id:'t'},timestamp:'2026-10-01T00:00:00Z'},
    {type:'token_usage_record',payload:{session_id:'thread-one',thread_id:'thread-one',turn_id:'t',root_turn_id:'t',response_id:'r',usage:{input_tokens:100,output_tokens:10},turn_token_usage:{input_tokens:100,output_tokens:10},thread_token_usage:{input_tokens:900,output_tokens:90}}},
    {type:'event_msg',payload:{type:'task_complete',turn_id:'t',duration_ms:400},timestamp:'2026-10-01T00:00:01Z'}]);
  assert.equal(events.filter(event=>event.kind==='usage').length,1);assert.equal((events.find(event=>event.kind==='usage') as UsageEvent).tokens.input,100);
  assert.ok(events.some(event=>event.kind==='turn' && event.duration===400));
});
test('legacy high-water clamps regression and suppresses repeated snapshots',() => {
  const count = (input:number) => ({type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:input,output_tokens:0}}}});
  const events = codex([{type:'turn_context',payload:{turn_id:'t'}},count(100),count(100),count(60),count(120)]);
  const usage = events.filter((event): event is UsageEvent => event.kind==='usage');
  assert.deepEqual(usage.map(event=>event.tokens.input),[100,0,20]);assert.ok(usage[1].flags!.includes('counter-regression'));
});

test('legacy external user messages form distinct requests when lifecycle turn ids are unavailable', () => {
  const events = codex([
    {type:'event_msg',timestamp:'2026-10-01T00:00:00Z',payload:{type:'user_message'}},
    {type:'event_msg',payload:{type:'token_count',info:{last_token_usage:{input_tokens:10,output_tokens:2}}}},
    {type:'event_msg',timestamp:'2026-10-01T00:01:00Z',payload:{type:'user_message'}},
    {type:'event_msg',payload:{type:'token_count',info:{last_token_usage:{input_tokens:20,output_tokens:3}}}},
  ]);
  const usage = events.filter((event): event is UsageEvent => event.kind === 'usage');
  assert.equal(usage.length,2);assert.notEqual(usage[0].rootId,usage[1].rootId);
});

test('invalid token schemas do not silently become zero usage', () => {
  assert.throws(() => codexTokens({input_tokens:'100',output_tokens:20}), /unsupported-token-schema/);
  assert.throws(() => claudeTokens({unknown_token_field:30}), /unsupported-token-schema/);
});

test('rootless Codex subagents retain their local turns and become independent sessions', () => {
  const events: ParseEvent[] = [];let identity: ParsedIdentity | undefined;
  const parser = new CodexCurrentParserAdapter({provider:'codex',path:'/sessions/child.jsonl',sourceRoot:'/sessions',fileId:1},
    {identity:value=>{identity=value;},event:event=>events.push(event)});
  parser.row({type:'session_meta',payload:{id:'child',session_id:'parent',parent_thread_id:'parent'}},0);
  for (const [turn,input] of [['child-turn-one',10],['child-turn-two',20]] as const) {
    parser.row({type:'event_msg',payload:{type:'task_started',turn_id:turn}},1);
    parser.row({type:'event_msg',payload:{type:'token_count',info:{last_token_usage:{input_tokens:input,output_tokens:2}}}},2);
  }
  parser.finish();
  assert.deepEqual(events.filter(event=>event.kind==='usage').map(event=>event.rootId),['child-turn-one','child-turn-two']);
  assert.equal(identity!.sessionId,'child');assert.equal(identity!.isMain,true);assert.equal(identity!.parentThreadId,null);
  assert.equal(identity!.forkedFromId,'parent');assert.equal(identity!.standaloneSubagent,true);
});

test('a later explicit root keeps a Codex subagent attached despite rootless inherited history', () => {
  let identity: ParsedIdentity | undefined;
  const parser = new CodexCurrentParserAdapter({provider:'codex',path:'/sessions/child.jsonl',sourceRoot:'/sessions',fileId:1},
    {identity:value=>{identity=value;},event:()=>undefined});
  parser.row({type:'session_meta',payload:{id:'child',parent_thread_id:'parent'}},0);
  parser.row({type:'turn_context',payload:{turn_id:'inherited'}},1);
  parser.row({type:'event_msg',payload:{type:'token_count',info:{last_token_usage:{input_tokens:10,output_tokens:2}}}},2);
  parser.row({type:'event_msg',payload:{type:'task_started',turn_id:'child-turn',root_turn_id:'parent-turn'}},3);
  parser.finish();
  assert.equal(identity!.sessionId,'parent');assert.equal(identity!.isMain,false);assert.equal(identity!.parentThreadId,'parent');
  assert.equal(identity!.standaloneSubagent,undefined);
});
