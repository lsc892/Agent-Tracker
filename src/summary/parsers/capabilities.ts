import type { CapabilityEvent } from '../types';
import { displayName, object, string } from './common';

type Use = Pick<CapabilityEvent, 'category' | 'name'>;

function argumentsObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return object(value);
  try { return object(JSON.parse(value)); } catch { return {}; }
}

/**
 * 책임: 도구 호출 분석에 필요한 문자열 리터럴을 실행 없이 해석한다.
 * 알고리즘: 바깥 따옴표를 제거하고 유니코드·16진수·기본 escape만 정적으로 복원한다.
 */
function literal(value: string): string {
  return value.slice(1,-1).replace(/\\(u[0-9a-f]{4}|x[0-9a-f]{2}|[\s\S])/gi,(_,escape: string) => {
    if (escape.startsWith('u') || escape.startsWith('x')) return String.fromCharCode(parseInt(escape.slice(1),16));
    return ({n:'\n',r:'\r',t:'\t'} as Record<string,string>)[escape] ?? escape;
  });
}

function stringEnd(code: string, start: number): number {
  const quote = code[start];
  for (let i=start+1;i<code.length;i++) {
    if (code[i] === '\\') i++;
    else if (code[i] === quote) return i+1;
  }
  return code.length;
}

/**
 * 책임: exec 래퍼에 포함된 정적인 tools 호출을 식별한다.
 * 알고리즘: 주석·문자열을 건너뛰며 tools.method와 괄호 깊이를 찾고 지원하는 인자 필드의 고정 문자열만 추출한다.
 */
function *nestedCalls(code: string): Generator<{name:string;args:Record<string,unknown>}> {
  for (let i=0;i<code.length;) {
    if ('\'"`'.includes(code[i])) { i=stringEnd(code,i); continue; }
    if (code.startsWith('//',i)) { const end=code.indexOf('\n',i);i=end<0 ? code.length : end+1;continue; }
    if (code.startsWith('/*',i)) { const end=code.indexOf('*/',i+2);i=end<0 ? code.length : end+2;continue; }
    const match = code.startsWith('tools.',i) ? /^tools\.([\w]+)\s*\(/.exec(code.slice(i)) : null;
    if (!match || i>0 && /[\w.]/.test(code[i-1])) { i++;continue; }
    const start=i+match[0].length;
    let depth=1,end=start;
    for (;end<code.length && depth;end++) {
      if ('\'"`'.includes(code[end])) { end=stringEnd(code,end)-1;continue; }
      if (code[end] === '(') depth++;
      if (code[end] === ')') depth--;
    }
    const raw=code.slice(start,end-1);
    const args=argumentsObject(raw);
    // Object literals often have unquoted keys. Extract only supported scalar fields.
    for (const key of ['cmd','command','file_path','path','skill','subagent_type','agent_type']) {
      const field=new RegExp(`(?:^|[,{]\\s*)["']?${key}["']?\\s*:\\s*`).exec(raw);
      if (!field) continue;
      const position=field.index+field[0].length;
      if (!'\'"`'.includes(raw[position] ?? ' ')) continue;
      const end=stringEnd(raw,position);
      const value=raw.slice(position,end);
      if (raw[position] === '`' && value.includes('${') || !/^\s*(?:[,}]|$)/.test(raw.slice(end))) continue;
      args[key]=literal(value);
    }
    yield {name:match[1],args};
    i=end;
  }
}

/**
 * 책임: SKILL.md 읽기 경로에서 스킬과 플러그인 이름을 식별한다.
 * 알고리즘: 따옴표 유무에 맞춰 경로를 추출하고 구분자를 통일한 뒤 상위 폴더와 플러그인 cache 경로로 분류한다.
 */
function skillPaths(value: string): Use[] {
  const uses: Use[]=[];
  // Quoted paths may contain spaces; unquoted paths end at shell separators.
  const paths=[...value.matchAll(/["']([^"'\r\n]*[\\/]SKILL\.md)["']|([^\s"'`;|]*[\\/]SKILL\.md)/gi)];
  for (const match of paths) {
    const path=(match[1] ?? match[2]).replace(/\\/g,'/');
    const name=displayName(path.split('/').at(-2));
    if (!name) continue;
    const plugin=/\/plugins\/cache\/[^/]+\/([^/]+)\//i.exec(path)?.[1];
    uses.push({category:'skill',name:plugin ? `${plugin}:${name}` : name});
    if (plugin) uses.push({category:'plugin',name:displayName(plugin)!});
  }
  return uses;
}

function readsFile(command: string): boolean {
  for (let i=0;i<command.length;) {
    if ('\'"`'.includes(command[i])) { i=stringEnd(command,i);continue; }
    if ((i===0 || /[\s;|(&]/.test(command[i-1])) && /^(?:Get-Content|cat|type|head|tail|sed|read_file)\b/i.test(command.slice(i))) return true;
    i++;
  }
  return false;
}

/**
 * 책임: 실제 도구 호출을 Skill·subagent·plugin 사용으로 분류한다.
 * 알고리즘: 호출명과 명시 인자를 기준으로 분류하고 파일 읽기 명령의 SKILL 경로를 추출한 뒤 같은 분류·이름을 중복 제거한다.
 */
function directUses(name: string, args: Record<string,unknown>): Use[] {
  name=name.split('.').at(-1)!;
  const uses: Use[]=[];
  const lower=name.toLowerCase();
  if (lower === 'skill') {
    const skill=displayName(args.skill ?? args.name);
    if (skill) {
      uses.push({category:'skill',name:skill});
      if (skill.includes(':')) uses.push({category:'plugin',name:skill.split(':')[0]});
    }
  }
  if (['spawn_agent','task','agent'].includes(lower)) {
    uses.push({category:'subagent',name:displayName(args.subagent_type ?? args.agent_type) ?? 'default'});
  }
  const plugin=/^mcp__(.+?)__/.exec(name)?.[1];
  if (plugin) uses.push({category:'plugin',name:displayName(plugin)!});
  if (['read','read_file'].includes(lower)) uses.push(...skillPaths(string(args.file_path ?? args.path) ?? ''));
  if (['exec_command','bash','powershell','shell_command','shell'].includes(lower)) {
    const command=string(args.cmd ?? args.command) ?? '';
    if (readsFile(command)) uses.push(...skillPaths(command));
  }
  return uses.flatMap(use=>{ const name=displayName(use.name);return name ? [{...use,name}] : []; })
    .filter((use,index,all)=>all.findIndex(other=>other.category===use.category && other.name===use.name)===index);
}

/**
 * 책임: 직접 호출과 exec 내부 호출에 같은 사용 횟수 추출 규칙을 적용한다.
 * 알고리즘: exec 문자열은 정적으로 분해하고 나머지는 단일 호출로 취급해 분류 결과에 원래 호출 순번을 붙여 yield한다.
 */
export function *toolCapabilities(name: string, input: unknown): Generator<Use & {index:number}> {
  const calls=name.split('.').at(-1) === 'exec' && typeof input === 'string'
    ? nestedCalls(input) : [{name,args:argumentsObject(input)}];
  let index=0;
  for (const call of calls) {
    for (const use of directUses(call.name,call.args)) yield {...use,index};
    index++;
  }
}
