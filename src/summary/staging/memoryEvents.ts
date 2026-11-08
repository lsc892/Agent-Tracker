// 승자 DTO와 원본 검증 근거를 유지하고 계보·복사 접두사·응답 중복을 SQL 적재 전에 정리한다.
import { createHash, type Hash } from 'node:crypto';
import type { ParseEvent, Provider, UsageEvent } from '../types';

export interface MemoryAnchor { kind: 'anchor'; rootId: string; offset: number }
export interface MemoryEvent { id: number; fileId: number; event: ParseEvent | MemoryAnchor }
export interface RawMemoryEvent extends MemoryEvent { event: ParseEvent }
export interface MemoryFile {
  id: number; provider: Provider; session_id: string | null; parsed: number; removed: number; failed: number;
  thread_id: string | null; parent_thread_id: string | null; forked_from_id: string | null;
}

const rootKey = (row: MemoryEvent): string => JSON.stringify([row.fileId,row.event.rootId]);
const capabilityKey = (event: Extract<ParseEvent, {kind:'capability'}>): string =>
  JSON.stringify([event.rootId,event.eventId,event.category,event.name]);
const legacySignature = (event: UsageEvent): string => JSON.stringify([event.rootId,event.turnId,event.responseId,
  event.tokens.input,event.tokens.output,event.tokens.cacheRead,event.tokens.cacheWrite,event.tokens.reasoning]);
const localKey = (fileId: number, event: UsageEvent): string => JSON.stringify([fileId,event.rootId,event.responseId,
  event.requestId,event.threadId,event.turnId,event.schema ?? null]);
const score = (event: UsageEvent): number | bigint => Number.isSafeInteger(event.tokens.input+event.tokens.output)
  ? event.tokens.input+event.tokens.output : BigInt(event.tokens.input)+BigInt(event.tokens.output);
interface RootBasis { rootId:string; firstId:number; offset:number; hash:Hash; dependencies:Set<string> }
interface LegacyEvidence { id:number; rootId:string; offset:number; key:string; signature:string; eligible:boolean }
export interface SignatureRoot { rootId:string; firstId:number; offset:number; digest:string; dependencies:ReadonlySet<string> }
const normalize = (event:ParseEvent):ParseEvent => {
  const normalized={...event};
  if (normalized.kind==='usage' || normalized.kind==='check') normalized.tokens={...normalized.tokens};
  const text=(value:string):string=>/[\ud800-\udfff]/.test(value)?Buffer.from(value).toString('utf8'):value;
  for (const [key,value] of Object.entries(normalized)) if (typeof value==='string') Reflect.set(normalized,key,text(value));
  if ('flags' in normalized && normalized.flags) normalized.flags=normalized.flags.map(text);
  return normalized;
};

/** 입력 중 임시 그룹의 최대 DTO만 남기고 확정된 파일 정체성으로 승자들을 합친다. */
export class MemoryEvents {
  private ordinal = 0;
  private readonly records = new Map<number, RawMemoryEvent>();
  private readonly mainFiles = new Set<number>();
  private readonly usage = new Map<string, RawMemoryEvent & {event:UsageEvent}>();
  private readonly anchors = new Map<string, MemoryEvent & {event:MemoryAnchor}>();
  private readonly basis = new Map<number, Map<string, RootBasis>>();
  private readonly legacy = new Map<number, LegacyEvidence[]>();
  private readonly recovery = new Map<number, Set<string>>();
  private visibleRoots: Map<number, Set<string>> | undefined;
  private batch: {fileId:number;event:ParseEvent}[] | undefined;
  private recovered = false;
  private seen = 0;
  private replacements = 0;
  private discarded = 0;

  get size(): number { return this.records.size; }
  get usageStats(): {seen:number;replacements:number;discarded:number;retained:number;evidenceRoots:number;legacyEvidence:number;dependencies:number} {
    let evidenceRoots=0,legacyEvidence=0,dependencies=0;
    for (const roots of this.basis.values()) for (const root of roots.values()) {evidenceRoots++;dependencies+=root.dependencies.size;}
    for (const rows of this.legacy.values()) legacyEvidence+=rows.length;
    return {seen:this.seen,replacements:this.replacements,discarded:this.discarded,retained:this.usage.size,evidenceRoots,legacyEvidence,dependencies};
  }

  add(fileId: number, event: ParseEvent): void {
    // SQLite TEXT bindings replace lone UTF-16 surrogates with UTF-8 replacement characters.
    const normalized = normalize(event);
    if (normalized.kind === 'turn' && this.mainFiles.has(fileId)) normalized.isMain=true;
    if (this.batch) this.batch.push({fileId,event:normalized});
    else this.accept(fileId,normalized);
  }

  private accept(fileId:number,event:ParseEvent):void {
    const id=++this.ordinal;
    let roots=this.basis.get(fileId);if (!roots) this.basis.set(fileId,roots=new Map());
    let root=roots.get(event.rootId);
    if (!root) roots.set(event.rootId,root={rootId:event.rootId,firstId:id,offset:event.offset,hash:createHash('sha256'),dependencies:new Set()});
    root.hash.update(JSON.stringify(event));root.offset=Math.min(root.offset,event.offset);
    if (event.kind==='check' || event.kind==='usage' && event.schema!=='legacy') {
      root.dependencies.add(JSON.stringify(['turn',event.threadId,event.turnId]));
      if (event.kind==='usage') root.dependencies.add(JSON.stringify(['response',event.responseId]));
    }
    if (event.kind!=='usage') {this.records.set(id,{id,fileId,event});return;}
    this.seen++;
    if (event.schema==='legacy') {
      let rows=this.legacy.get(fileId);if (!rows) this.legacy.set(fileId,rows=[]);
      rows.push({id,rootId:event.rootId,offset:event.offset,key:localKey(fileId,event),signature:legacySignature(event),eligible:true});
    }
    this.keep({id,fileId,event});
  }

  private keep(row:RawMemoryEvent & {event:UsageEvent}):void {
    const key=localKey(row.fileId,row.event),previous=this.usage.get(key);
    const value=score(row.event),before=previous && score(previous.event);
    if (!previous || value>before! || value===before && row.id>previous.id) {
      if (previous) {this.records.delete(previous.id);this.anchor(previous);this.replacements++;}
      this.usage.set(key,row);this.records.set(row.id,row);
    } else {this.anchor(row);this.discarded++;}
  }

  private anchor(row:MemoryEvent):void {
    // Legacy anchors are rebuilt from validity evidence after its copied prefix is known.
    if (row.event.kind==='usage' && row.event.schema==='legacy') return;
    const key=rootKey(row),previous=this.anchors.get(key);
    if (previous) {previous.id=Math.min(previous.id,row.id);previous.event.offset=Math.min(previous.event.offset,row.event.offset);}
    else this.anchors.set(key,{id:row.id,fileId:row.fileId,event:{kind:'anchor',rootId:row.event.rootId,offset:row.event.offset}});
  }

  beginBatch():void { if (this.batch) throw new Error('Nested event batch');this.batch=[]; }
  commitBatch():void { const rows=this.batch;if (!rows) throw new Error('No event batch');this.batch=undefined;
    for (const row of rows) this.accept(row.fileId,row.event); }
  rollbackBatch():void { this.batch=undefined; }

  mainFile(fileId: number): void {
    this.mainFiles.add(fileId);
    for (const row of this.records.values()) {
      if (row.fileId === fileId && row.event.kind === 'turn') row.event.isMain = true;
    }
  }

  release(fileIds: Iterable<number>): void {
    const released = new Set(fileIds);
    for (const [id,row] of this.records) if (released.has(row.fileId)) this.records.delete(id);
    for (const [key,row] of this.usage) if (released.has(row.fileId)) this.usage.delete(key);
    for (const [key,row] of this.anchors) if (released.has(row.fileId)) this.anchors.delete(key);
    for (const id of released) {this.mainFiles.delete(id);this.basis.delete(id);this.legacy.delete(id);this.recovery.delete(id);this.visibleRoots?.delete(id);}
  }

  excludeLegacy(): void {
    const current = new Set<number>();
    for (const row of this.records.values()) {
      if (row.event.kind === 'usage' && row.event.schema === 'current') current.add(row.fileId);
    }
    for (const row of this.records.values()) {
      if (row.event.kind === 'usage' && row.event.schema === 'legacy' && current.has(row.fileId)) this.records.delete(row.id);
    }
    for (const [key,row] of this.usage) if (row.event.schema==='legacy' && current.has(row.fileId)) this.usage.delete(key);
    for (const id of current) this.legacy.delete(id);
  }

  /** 기존 legacy 연속 접두사와 그 범위의 복사 도구·빈 요청 이벤트를 제거한다. */
  excludePrefixes(files: readonly MemoryFile[]): number[] {
    const active = files.filter(file => file.provider === 'codex' && file.parsed === 1 && !file.removed && !file.failed)
      .sort((a,b) => a.id-b.id);
    const byFile = new Map<number, RawMemoryEvent[]>();
    const capabilities = new Map<number, Map<string, number>>();
    for (const row of this.records.values()) {
      let rows = byFile.get(row.fileId);
      if (!rows) byFile.set(row.fileId,rows=[]);
      rows.push(row);
      if (row.event.kind === 'capability') {
        let keys = capabilities.get(row.fileId);
        if (!keys) capabilities.set(row.fileId,keys=new Map());
        const key = capabilityKey(row.event);
        if (!keys.has(key)) keys.set(key,row.id);
      }
    }
    const inherited = new Set<number>(), checked: number[] = [];
    const cutoffs: {child:LegacyEvidence;parent:LegacyEvidence;fileId:number;parentId:number}[] = [];
    for (const file of active) {
      const reference = file.forked_from_id ?? file.parent_thread_id;
      if (reference === null) continue;
      const parent = active.find(candidate => candidate.id !== file.id && candidate.thread_id === reference);
      if (!parent) continue;
      checked.push(file.id);
      const parentRows = this.legacy.get(parent.id) ?? [], childRows = this.legacy.get(file.id) ?? [];
      let last: {child:LegacyEvidence;parent:LegacyEvidence;fileId:number;parentId:number} | undefined;
      for (let index=0; index<Math.min(parentRows.length,childRows.length); index++) {
        const child = childRows[index], ancestor = parentRows[index];
        if (child.signature!==ancestor.signature) break;
        inherited.add(child.id);child.eligible=false;last={child,parent:ancestor,fileId:file.id,parentId:parent.id};
      }
      if (last) cutoffs.push(last);
    }
    for (const {child,parent,fileId,parentId} of cutoffs) {
      for (const row of byFile.get(fileId) ?? []) {
        if (row.id > child.id || row.event.kind !== 'capability') continue;
        const match = capabilities.get(parentId)?.get(capabilityKey(row.event));
        if (match !== undefined && match <= parent.id) this.records.delete(row.id);
      }
    }
    const remaining = new Set<string>(), inheritedRoots = new Set<string>();
    for (const [fileId,rows] of this.legacy) for (const row of rows) {
      (inherited.has(row.id) ? inheritedRoots : remaining).add(JSON.stringify([fileId,row.rootId]));
    }
    for (const row of this.records.values()) if (row.event.kind==='usage' && row.event.schema!=='legacy') remaining.add(rootKey(row));
    for (const key of remaining) inheritedRoots.delete(key);
    for (const row of this.records.values()) {
      if (inherited.has(row.id) || row.event.kind !== 'capability' && inheritedRoots.has(rootKey(row))) this.records.delete(row.id);
    }
    for (const [key,row] of this.usage) if (!this.records.has(row.id)) this.usage.delete(key);
    for (const key of inheritedRoots) this.anchors.delete(key);
    // A copied prefix can remove a local maximum while a lower, later source event remains valid.
    // Retain no fallback DTO: reread only that exceptional file using the original evidence ordinal.
    this.recovery.clear();
    for (const [fileId,rows] of this.legacy) for (const row of rows) {
      if (inherited.has(row.id)) continue;
      if (!this.usage.has(row.key)) {
        let keys=this.recovery.get(fileId);if (!keys) this.recovery.set(fileId,keys=new Set());keys.add(row.key);
      }
      else if (this.usage.get(row.key)?.id!==row.id) this.anchor({id:row.id,fileId,event:{kind:'anchor',rootId:row.rootId,offset:row.offset}});
    }
    return checked;
  }

  recoveryFiles():number[] { return [...this.recovery.keys()]; }
  recoverLegacy(fileId:number,event:UsageEvent,index:number):void {
    const evidence=this.legacy.get(fileId)?.[index];if (!evidence) throw new Error('Missing legacy recovery evidence');
    const normalized=normalize(event) as UsageEvent;
    if (evidence.signature!==legacySignature(normalized) || evidence.offset!==normalized.offset) throw new Error('Legacy source changed during recovery');
    if (!this.recovery.get(fileId)?.has(evidence.key)) return;
    if (!evidence.eligible) return;
    this.keep({id:evidence.id,fileId,event:normalized});this.recovered=true;
  }
  finishRecovery(fileId:number):void {
    for (const key of this.recovery.get(fileId) ?? []) if (!this.usage.has(key)) throw new Error('Legacy winner recovery failed');
    for (const row of this.legacy.get(fileId) ?? []) if (row.eligible && this.recovery.get(fileId)?.has(row.key)
      && this.usage.get(row.key)?.id!==row.id) this.anchor({id:row.id,fileId,event:{kind:'anchor',rootId:row.rootId,offset:row.offset}});
    this.recovery.delete(fileId);
  }

  *signatureRoots(fileId:number):Iterable<SignatureRoot> {
    const legacyDependencies=new Map<string,Set<string>>();
    for (const row of this.legacy.get(fileId) ?? []) if (row.eligible) {
      const [,rootId,response,,thread,turn]=JSON.parse(row.key) as [number,string,string,string|null,string,string];
      let dependencies=legacyDependencies.get(rootId);if (!dependencies) legacyDependencies.set(rootId,dependencies=new Set());
      dependencies.add(JSON.stringify(['response',response]));dependencies.add(JSON.stringify(['turn',thread,turn]));
    }
    for (const root of this.basis.get(fileId)?.values() ?? []) {
      if (this.visibleRoots && !this.visibleRoots.get(fileId)?.has(root.rootId)) continue;
      const dependencies=new Set([...root.dependencies,...legacyDependencies.get(root.rootId) ?? []]);
      yield {rootId:root.rootId,firstId:root.firstId,offset:root.offset,digest:root.hash.copy().digest('hex'),dependencies};
    }
  }

  rows(): Iterable<RawMemoryEvent> { return this.records.values(); }

  /** 남은 DTO의 응답·도구 중복을 제거하고 버린 행의 root·최초 위치를 남긴다. */
  deduplicate(files: readonly MemoryFile[]): {rows:MemoryEvent[];canonical:Map<number,string|null>} {
    const active = new Map(files.filter(file => !file.removed && !file.failed && file.session_id !== null).map(file => [file.id,file]));
    for (const fileId of this.recovery.keys()) if (active.has(fileId)) throw new Error('Legacy recovery must finish before event loading');
    const requests = new Map<string, string | null>();
    const ordered=this.recovered?[...this.records.values()].sort((a,b)=>a.id-b.id):this.records.values();
    for (const row of ordered) {
      const file = active.get(row.fileId), event = row.event;
      if (!file || file.provider !== 'claude' || event.kind !== 'usage' || event.requestId === null) continue;
      const key = JSON.stringify([file.session_id,event.responseId]);
      if (!requests.has(key)) requests.set(key,event.requestId);
      else if (requests.get(key) !== event.requestId) requests.set(key,null);
    }
    const winners = new Map<string, {row:RawMemoryEvent;score:number|bigint;request:string|null}>();
    for (const row of this.records.values()) {
      const file = active.get(row.fileId), event = row.event;
      if (!file || event.kind !== 'usage') continue;
      const request = file.provider === 'claude' && event.requestId === null
        ? requests.get(JSON.stringify([file.session_id,event.responseId])) ?? null : event.requestId;
      const key = JSON.stringify([file.provider,file.session_id,event.responseId,
        file.provider === 'claude' ? request ?? 'no-req' : event.threadId,file.provider === 'claude' ? '' : event.turnId]);
      const sum = event.tokens.input + event.tokens.output;
      const score = Number.isSafeInteger(sum) ? sum : BigInt(event.tokens.input)+BigInt(event.tokens.output);
      const previous = winners.get(key);
      if (!previous || score > previous.score || score === previous.score && row.id > previous.row.id) winners.set(key,{row,score,request});
    }
    const canonical = new Map([...winners.values()].map(winner => [winner.row.id,winner.request]));
    const rows: MemoryEvent[] = [], anchors = new Map(this.anchors);
    const capabilities=new Set<string>();
    for (const row of this.records.values()) {
      const file=active.get(row.fileId);
      if (!file) continue;
      let retained=row.event.kind !== 'usage' || canonical.has(row.id);
      if (row.event.kind === 'capability') {
        const event=row.event;
        const key=JSON.stringify([file.provider,file.session_id,event.rootId,event.threadId,event.eventId,event.category,event.name]);
        retained=!capabilities.has(key);capabilities.add(key);
      }
      if (retained) { rows.push(row); continue; }
      const key = rootKey(row), previous = anchors.get(key);
      if (previous) {previous.id=Math.min(previous.id,row.id);previous.event.offset = Math.min(previous.event.offset,row.event.offset);}
      else {
        const anchor = {id:row.id,fileId:row.fileId,event:{kind:'anchor' as const,rootId:row.event.rootId,offset:row.event.offset}};
        anchors.set(key,anchor);
      }
    }
    for (const anchor of anchors.values()) if (active.has(anchor.fileId)) rows.push(anchor);
    rows.sort((a,b)=>a.id-b.id);
    this.visibleRoots=new Map();
    for (const row of rows) {let roots=this.visibleRoots.get(row.fileId);if (!roots) this.visibleRoots.set(row.fileId,roots=new Set());roots.add(row.event.rootId);}
    return {rows,canonical};
  }

  clear(): void { this.records.clear();this.mainFiles.clear();this.usage.clear();this.anchors.clear();this.basis.clear();this.legacy.clear();
    this.recovery.clear();this.visibleRoots=undefined;this.batch=undefined;this.ordinal=0;this.recovered=false;
    this.seen=0;this.replacements=0;this.discarded=0; }
}
