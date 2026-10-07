import type { CapabilityEvent } from '../types';
import { displayName, object, string } from './common';

type Use = Pick<CapabilityEvent, 'category' | 'name'>;

function argumentsObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return object(value);
  try { return object(JSON.parse(value)); } catch { return {}; }
}

/** Read string literals without executing transcript commands or JavaScript. */
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

/** Static tools.method(...) calls in Codex exec wrappers; comments and strings are skipped. */
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

export function *toolCapabilities(name: string, input: unknown): Generator<Use & {index:number}> {
  const calls=name.split('.').at(-1) === 'exec' && typeof input === 'string'
    ? nestedCalls(input) : [{name,args:argumentsObject(input)}];
  let index=0;
  for (const call of calls) {
    for (const use of directUses(call.name,call.args)) yield {...use,index};
    index++;
  }
}
