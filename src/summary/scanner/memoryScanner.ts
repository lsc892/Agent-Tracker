// 파일별 승인된 DTO를 재사용하고 최종 메모리 집계만 영속 저장한다.
import {opendir,lstat,readdir} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {setImmediate as yieldToWorker} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {SummaryDatabase} from '../db';
import type {FileMetadata,ManifestRow,Provider} from '../db/types';
import {readJsonl,SummaryError} from '../jsonl';
import {ClaudeParserAdapter,CodexCurrentParserAdapter} from '../parsers';
import {displayName,string} from '../parsers/common';
import {aggregateMemory,type MemoryAggregateFile} from '../aggregation/memoryAggregate';
import {acquireRefreshLock} from './lock';
import {includesSourceSnapshot,sourceIdentity} from './sourceFingerprint';
import type {ParseEvent,ParsedIdentity,SourceRoot,SummaryOptions,SummaryProgress,RefreshResult} from '../types';

export const PARSER_VERSION=14;
interface SourceSnapshot {
  fingerprint:string; identity:ParsedIdentity; events:readonly ParseEvent[];
  partialLine:boolean; sourceIdentity:string; contentHash:string;
}
interface FileState extends FileMetadata {
  id:number;previous?:ManifestRow;changed:boolean;removed:boolean;selected:boolean;
  snapshot?:SourceSnapshot;session:string|null;error?:SummaryError;settled?:boolean;attempted?:boolean;sequence?:number;deferred?:boolean;
}
interface SourceState {configuration:string;version:number;files:Map<number,SourceSnapshot>}
const states=new WeakMap<DatabaseSync,SourceState>();
const fingerprint=(file:FileMetadata):string=>JSON.stringify([file.provider,file.path,file.source_root,
  file.size_bytes,file.mtime_ms,file.dev,file.inode,file.parser_version]);
const sqlText=(value:string):string=>/[\ud800-\udfff]/.test(value)?Buffer.from(value).toString('utf8'):value;
const key=(provider:Provider,session:string):string=>JSON.stringify([provider,sqlText(session)]);
const normalizedIdentity=(identity:ParsedIdentity):ParsedIdentity=>{
  const result={...identity};
  for(const [name,value]of Object.entries(result))if(typeof value==='string')Reflect.set(result,name,sqlText(value));
  return result;
};

async function* walk(directory:string,check:()=>void,compressed:boolean):AsyncGenerator<string>{
  check();const stat=await lstat(directory);
  if(!stat.isDirectory()||stat.isSymbolicLink())throw new SummaryError('source-root-not-directory');
  const handle=await opendir(directory,{bufferSize:32});
  for await(const entry of handle){check();if(entry.isSymbolicLink())continue;const path=join(directory,entry.name);
    if(entry.isDirectory())yield* walk(path,check,compressed);
    else if(entry.isFile()&&(entry.name.toLowerCase().endsWith('.jsonl')
      ||compressed&&entry.name.toLowerCase().endsWith('.jsonl.zst')))yield path;}
}

/** manifest 선별 → 파일 DTO 교체·재사용 → 메모리 계보·집계 → 성분별 최종 transaction. */
export async function refreshSummary(database:SummaryDatabase,options:SummaryOptions,signal?:AbortSignal,
  progress?:(value:SummaryProgress)=>void):Promise<RefreshResult>{
  const result:RefreshResult={scanId:randomUUID(),discovered:0,parsed:0,reused:0,failed:0,
    bodyBytes:0,interrupted:false,completedAt:''};
  const cancellation=options.cancellation?new Int32Array(options.cancellation):undefined;
  const cancelled=():boolean=>Boolean(signal?.aborted||cancellation&&Atomics.load(cancellation,0));
  const check=():void=>{if(cancelled())throw new SummaryError('interrupted');};
  let phase:SummaryProgress['phase']='scanning',lastProgress=0,release:(()=>void)|undefined;
  const report=(force=false):void=>{if(force||Date.now()-lastProgress>100){
    progress?.({phase,discovered:result.discovered,parsed:result.parsed,failed:result.failed,bodyBytes:result.bodyBytes});lastProgress=Date.now();}};
  const files=new Map<number,FileState>(),affected=new Set<string>(),links=new Map<string,Set<string>>();
  let sequence=0;
  const missingParents=new Set<number>(),reconnections:{old_id:number;new_id:number}[]=[];
  const collect=options.collectCapabilities!==false,retain=options.retainDeletedSourceUsage!==false;
  const roots=options.roots.map(root=>({...root,path:resolve(root.path)}));
  const version=():number=>database.connection.prepare('PRAGMA main.data_version').get()!.data_version as number;
  const configuration=JSON.stringify([roots,collect]);
  let cache=states.get(database.connection);
  if(!cache||cache.configuration!==configuration||cache.version!==version()){
    cache={configuration,version:version(),files:new Map()};states.set(database.connection,cache);}
  const accepted=cache;
  const affect=(provider:Provider,session:string|null|undefined):void=>{if(session)affected.add(key(provider,session));};
  const connect=(provider:Provider,a:string|null|undefined,b:string|null|undefined):void=>{
    if(!a||!b||a===b)return;const left=key(provider,a),right=key(provider,b);
    for(const [from,to]of [[left,right],[right,left]]){let set=links.get(from);if(!set)links.set(from,set=new Set());set.add(to);}
    affected.add(left);affected.add(right);};
  const fail=(file:FileState,error:unknown):void=>{if(!file.error)result.failed++;
    file.error=error instanceof SummaryError?error:new SummaryError('source-read-error');
    affect(file.provider,file.previous?.session_id);affect(file.provider,file.session);};
  try{
    check();release=await acquireRefreshLock(options.dbPath,signal,cancelled);
    if(accepted.version!==version())accepted.files.clear();report(true);
    const manifest=database.connection.prepare('SELECT * FROM manifest ORDER BY id').all() as unknown as ManifestRow[];
    const paths=new Map(manifest.map(file=>[key(file.provider,file.path),file]));
    let nextId=manifest.reduce((max,file)=>Math.max(max,file.id),0)+1;const observed=new Set<number>();
    for(const root of roots){try{
      for await(const path of walk(root.path,check,root.provider==='codex')){
        const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink())continue;
        let previous=paths.get(key(root.provider,resolve(path)));
        if(!previous&&process.platform!=='win32'){
          const candidates=manifest.filter(file=>file.provider===root.provider&&file.dev===String(stat.dev)
            &&file.inode===String(stat.ino)&&!observed.has(file.id));
          if(candidates.length===1){try{await lstat(candidates[0].path);}catch(error){
            if((error as NodeJS.ErrnoException).code==='ENOENT')previous=candidates[0];}}}
        const metadata:FileMetadata={provider:root.provider,source_root:root.path,path:resolve(path),session_id:previous?.session_id??null,
          size_bytes:stat.size,mtime_ms:stat.mtimeMs,dev:String(stat.dev),inode:String(stat.ino),parser_version:PARSER_VERSION,
          capabilities_collected:collect?1:0,source_identity:previous?.source_identity,content_hash:previous?.content_hash};
        const changed=!previous||previous.source_missing===1||previous.processing_status!=='done'
          ||fingerprint(previous)!==fingerprint(metadata)||collect&&previous.capabilities_collected!==1
          ||previous.session_id!==null&&previous.size_bytes>0&&(!previous.source_identity||!previous.content_hash);
        const file:FileState={...metadata,id:previous?.id??nextId++,previous,changed,removed:false,selected:true,session:metadata.session_id};
        files.set(file.id,file);observed.add(file.id);result.discovered++;
        if(changed)affect(file.provider,file.session);else result.reused++;report();}
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'
      ||manifest.some(file=>file.provider===root.provider&&file.source_root===root.path))throw error;}}
    for(const previous of manifest)if(!observed.has(previous.id)){
      const selected=roots.some(root=>root.provider===previous.provider&&root.path===previous.source_root);
      const file:FileState={...previous,id:previous.id,previous,changed:selected&&(!previous.source_missing||!retain),
        removed:selected,selected,session:previous.session_id};files.set(file.id,file);if(file.changed)affect(file.provider,file.session);}
    for(const id of accepted.files.keys())if(!files.has(id))accepted.files.delete(id);
    check();const names=await readNames(roots,cancelled);phase='parsing';report(true);
    for(const file of [...files.values()].sort((a,b)=>a.id-b.id))if(file.changed&&!file.removed)await parse(file);
    await expand();await reconnect();check();phase='committing';report(true);check();
    const inputs:MemoryAggregateFile[]=[...files.values()].filter(file=>!file.removed&&!file.error&&file.snapshot&&file.session)
      .sort((a,b)=>a.sequence!-b.sequence!)
      .map(file=>({id:file.id,provider:file.provider,session_id:file.session!,identity:{...file.snapshot!.identity,
        sessionName:names.get(key(file.provider,file.session!))??file.snapshot!.identity.sessionName},
        events:file.snapshot!.events,flags:sourceFlags(file)}));
    // Fork prefix verification can reference a parent in a different logical session.
    // Aggregate the loaded source set once, then persist each independent component.
    const aggregated=aggregateMemory(inputs,collect);
    for(const seed of [...affected].sort()){
      if(!affected.has(seed))continue;const component=new Set([seed]),pending=[seed];
      for(let index=0;index<pending.length;index++)for(const linked of links.get(pending[index])??[])
        if(!component.has(linked)){component.add(linked);pending.push(linked);}
      const members=[...files.values()].filter(file=>component.has(key(file.provider,file.session??''))
        ||component.has(key(file.provider,file.previous?.session_id??'')));
      await yieldToWorker();check();
      if(members.some(file=>file.deferred)){
        database.transaction(()=>{for(const file of members){file.settled=true;if(file.deferred)
          database.connection.prepare(`UPDATE manifest SET processing_status='done',
            processing_position='partial-line: waiting for newline',recorded_at=?,last_error=NULL WHERE id=?`)
            .run(new Date().toISOString(),file.id);}});
      }else if(members.some(file=>file.error)){
        for(const file of members)if(!file.error)file.error=new SummaryError(members.find(item=>item.error)!.error!.code);
        preserve(members);
      }else{
        const missing=members.some(file=>file.removed);
        const orphans=aggregated.orphans.filter(orphan=>component.has(key(orphan.provider,orphan.session_id))&&(!retain||!missing));
        if(orphans.length){const file=files.get(orphans[0].fileId)!;
          fail(file,new SummaryError('missing-root-turn',orphans[0].offset));
          for(const sibling of members)if(!sibling.error)sibling.error=file.error;preserve(members);
        }else{try{
          const summaries=aggregated.summaries.filter(row=>component.has(key(row.provider,row.session_id))&&(!retain||!missing||row.hasMain));
          const sessions=[...component].map(value=>{const [provider,session_id]=JSON.parse(value) as [Provider,string];return{provider,session_id};});
          const sources=members.filter(file=>!file.removed).map(file=>[file.id,file.content_hash,file.session,file.snapshot?.identity,sourceFlags(file)]);
          database.replaceMemory({sessions,summaries,files:members.filter(file=>!file.removed).map(finalFile),
            removedFileIds:members.filter(file=>file.removed).map(file=>file.id),
            reconnectedFiles:reconnections.filter(link=>members.some(file=>file.id===link.old_id)),
            preserveCapabilities:!collect,retainDeletedSourceUsage:retain,scanId:result.scanId,
            metadata:summaries.map(row=>({provider:row.provider,session_id:row.session_id,root_id:row.root_turn_id,
              signature:JSON.stringify(['memory-files-v1',collect,sources,row.root_turn_id])}))});
          for(const file of members){file.settled=true;if(file.removed)accepted.files.delete(file.id);
            else if(file.snapshot)accepted.files.set(file.id,file.snapshot);else accepted.files.delete(file.id);}
        }catch(error){for(const file of members)fail(file,error instanceof SummaryError?error:new SummaryError('session-commit-error'));preserve(members);}}
      }
      for(const value of component)affected.delete(value);report();
    }
    const unsettled=[...files.values()].filter(file=>file.selected&&!file.settled&&!file.error&&!file.removed&&file.session===null);
    if(unsettled.length)database.replaceMemory({sessions:[],summaries:[],files:unsettled.map(finalFile),scanId:result.scanId});
    const removedEmpty=[...files.values()].filter(file=>file.removed&&file.previous?.session_id===null);
    if(removedEmpty.length)database.replaceMemory({sessions:[],summaries:[],files:[],removedFileIds:removedEmpty.map(file=>file.id),
      retainDeletedSourceUsage:retain,scanId:result.scanId});
    database.transaction(()=>{const update=database.connection.prepare('UPDATE sessions SET session_name=? WHERE provider=? AND session_id=? AND session_name IS NOT ?');
      for(const [value,name]of names){const [provider,session]=JSON.parse(value) as [Provider,string];update.run(name,provider,session,name);}
      const seen=database.connection.prepare('UPDATE manifest SET last_seen_scan_id=? WHERE id=?');
      for(const file of files.values())if(file.selected&&file.previous)seen.run(result.scanId,file.id);});
    for(const file of files.values())if(file.error)recordFailure(file);
    database.optimize();accepted.version=version();
  }catch(error){result.interrupted=true;result.error=cancelled()?'interrupted':error instanceof SummaryError?error.code:'source-discovery-error';
    if(!cancelled())result.failed++;
    for(const file of files.values())if(!file.settled&&(file.changed||file.snapshot)&&!file.removed){file.error=new SummaryError(result.error);recordFailure(file);}
  }finally{release?.();result.completedAt=new Date().toISOString();phase='complete';report(true);}
  return result;

  function finalFile(file:FileState):FileMetadata&{id:number}{return{...file,session_id:file.session,
    source_identity:file.snapshot?.sourceIdentity??file.source_identity,content_hash:file.snapshot?.contentHash??file.content_hash};}
  function sourceFlags(file:FileState):{rootId:string;flag:string}[]{const flags:{rootId:string;flag:string}[]=[];
    if(file.snapshot?.partialLine)flags.push({rootId:'*',flag:'partial-line'});
    if(file.snapshot?.identity.standaloneSubagent)flags.push({rootId:'*',flag:'standalone-subagent'});
    if(missingParents.has(file.id))flags.push({rootId:'*',flag:'missing-parent-agent'});return flags;}
  function recordFailure(file:FileState):void{let previous=database.findManifest(file.provider,file.path);
    if(!previous){previous=database.observeFile(file,result.scanId);file.id=previous.id;}
    database.setManifestDiagnostic(previous.id,file.error!.code==='interrupted'?'interrupted':'error',
      `parse: byte=${file.error!.offset}`,file.error!.code,file.error!.offset);}
  async function parse(file:FileState):Promise<void>{
    check();if(file.attempted||file.snapshot||file.error||file.removed)return;file.attempted=true;file.sequence=++sequence;
    if(!file.changed){const cached=accepted.files.get(file.id);
      if(cached&&cached.fingerprint===fingerprint(file)&&cached.contentHash===file.content_hash&&cached.sourceIdentity===file.source_identity){
        file.snapshot=cached;file.session=cached.identity.sessionId;affect(file.provider,file.session);return;}
      if(file.selected)result.reused=Math.max(0,result.reused-1);}
    if(!file.selected){try{const stat=await lstat(file.path);file.size_bytes=stat.size;file.mtime_ms=stat.mtimeMs;
      file.dev=String(stat.dev);file.inode=String(stat.ino);}catch(error){
        const replacement=[...files.values()].some(candidate=>candidate.snapshot&&!candidate.error&&!candidate.removed
          &&candidate.provider===file.provider&&candidate.source_identity===file.source_identity);
        if((error as NodeJS.ErrnoException).code==='ENOENT'&&(replacement||retain&&file.previous?.source_missing)){
          file.removed=true;file.changed=true;affect(file.provider,file.session);return;}
        fail(file,new SummaryError('source-unavailable-outside-scan'));return;}}
    const events:ParseEvent[]=[],context={provider:file.provider,path:file.path,sourceRoot:file.source_root,fileId:file.id,collectCapabilities:collect};
    const sink={identity:()=>{},event:(event:ParseEvent)=>events.push(event)};
    const parser=file.provider==='claude'?new ClaudeParserAdapter(context,sink):new CodexCurrentParserAdapter(context,sink);
    try{const before=await lstat(file.path);
      if(!before.isFile()||before.isSymbolicLink()||String(before.dev)!==file.dev||String(before.ino)!==file.inode||before.size<file.size_bytes)
        throw new SummaryError('file-replaced-during-read');
      const digest=createHash('sha256');const read=await readJsonl(file.path,file.size_bytes,(row,offset)=>parser.row(row,offset),{
        signal,isCancelled:cancelled,maxLineBytes:options.maxLineBytes,onBytes:bytes=>{result.bodyBytes+=bytes;report();},onChunk:chunk=>{digest.update(chunk);}});
      const after=await lstat(file.path);
      if(String(after.dev)!==file.dev||String(after.ino)!==file.inode||after.size<file.size_bytes
        ||after.size===file.size_bytes&&after.mtimeMs!==file.mtime_ms)throw new SummaryError('file-rewritten-during-read');
      if(!read.rows){result.parsed++;if(read.partialLine&&file.previous?.session_id){file.deferred=true;return;}
        file.content_hash=null;file.source_identity=null;
        file.session=file.previous?.session_id??null;return;}
      parser.finish();const rawIdentity=parser.getIdentity()!,identity=normalizedIdentity(rawIdentity);file.session=identity.sessionId;
      if(identity.standaloneSubagent)for(const event of events)if(event.kind==='turn')event.isMain=true;
      file.snapshot={fingerprint:fingerprint(file),identity:{...identity},events,partialLine:read.partialLine,
        sourceIdentity:sourceIdentity(rawIdentity),contentHash:digest.digest('hex')};
      file.source_identity=file.snapshot.sourceIdentity;file.content_hash=file.snapshot.contentHash;
      affect(file.provider,file.session);connect(file.provider,file.previous?.session_id,file.session);result.parsed++;
    }catch(error){const rawIdentity=parser.getIdentity();if(rawIdentity){const identity=normalizedIdentity(rawIdentity);
      file.session=identity.sessionId;connect(file.provider,file.previous?.session_id,file.session);}
      fail(file,error);if(cancelled())throw error;}
  }
  function lineage():void{
    missingParents.clear();const candidates=[...files.values()].filter(file=>!file.removed&&!file.error&&file.snapshot&&file.provider==='codex');
    const byThread=new Map<string,FileState[]>();for(const file of candidates){const thread=file.snapshot!.identity.threadId;
      let group=byThread.get(thread);if(!group)byThread.set(thread,group=[]);group.push(file);}
    const memo=new Map<number,string|null>(),visiting=new Set<number>();
    const visit=(file:FileState):string|null=>{if(memo.has(file.id))return memo.get(file.id)!;if(visiting.has(file.id))return null;
      visiting.add(file.id);const identity=file.snapshot!.identity,parent=identity.parentThreadId;let target:string|null=identity.sessionId;
      if(parent){const parents=byThread.get(parent)??[];if(!parents.length)missingParents.add(file.id);
        else{const targets=parents.map(visit);target=targets.includes(null)?null:new Set(targets).size===1?targets[0]:identity.sessionId;}}
      visiting.delete(file.id);memo.set(file.id,target);return target;};
    for(const file of candidates){const target=visit(file);if(target===null)missingParents.add(file.id);
      const session=target??file.snapshot!.identity.sessionId;if(file.session!==session){connect(file.provider,file.session,session);file.session=session;}}
  }
  async function expand():Promise<void>{while(true){lineage();let expanded=false;
    const references=new Set([...files.values()].filter(file=>file.provider==='codex'&&file.snapshot&&!file.error&&!file.removed)
      .flatMap(file=>[file.snapshot!.identity.parentThreadId,file.snapshot!.identity.forkedFromId].filter((id):id is string=>Boolean(id))));
    const known=new Set([...files.values()].filter(file=>file.snapshot&&!file.error&&!file.removed).map(file=>file.snapshot!.identity.threadId));
    const pending=[...files.values()].sort((a,b)=>a.id-b.id).filter(file=>!file.removed&&!file.error&&!file.snapshot&&!file.attempted);
    const parents=pending.filter(file=>file.provider==='codex'&&[...references].some(id=>!known.has(id)&&file.path.includes(id)));
    if(parents.length){for(const file of parents)await parse(file);expanded=true;}
    else{const next=pending.find(file=>affected.has(key(file.provider,file.session??'')));
      if(next){await parse(next);expanded=true;}}
    if(!expanded)break;}lineage();}
  async function reconnect():Promise<void>{for(const file of files.values())if(file.snapshot&&!file.error&&!file.removed){
    const active=[...files.values()].filter(item=>!item.removed&&!item.error&&item.provider===file.provider&&item.source_identity===file.source_identity);
    if(active.length!==1)continue;
    for(const old of files.values())if(old.removed&&old.provider===file.provider&&old.source_identity===file.source_identity
      &&old.session===file.session&&old.content_hash&&old.size_bytes>0){
      try{if(await includesSourceSnapshot(file,old,{check,onBytes:bytes=>{result.bodyBytes+=bytes;report();}}))
        reconnections.push({old_id:old.id,new_id:file.id});}
      catch(error){fail(file,error);if(cancelled())throw error;break;}}}
  }
  function preserve(members:FileState[]):void{const removed=members.filter(file=>file.removed);if(removed.length&&retain)
    database.replaceMemory({sessions:removed.filter(file=>file.session).map(file=>({provider:file.provider,session_id:file.session!})),
      summaries:[],files:[],removedFileIds:removed.map(file=>file.id),retainDeletedSourceUsage:true,scanId:result.scanId});}
}

/** 제공자 제목의 우선순위를 메모리에 병합하며 통계 DB는 여기서 쓰지 않는다. */
async function readNames(roots:SourceRoot[],cancelled:()=>boolean):Promise<Map<string,string>>{
  const names=new Map<string,string>(),stateNames=new Set<string>();
  const homes=new Set(roots.filter(root=>root.provider==='codex').map(root=>resolve(root.dataHome??dirname(root.path))));
  for(const home of homes){if(cancelled())break;
    try{const path=join(home,'session_index.jsonl'),stat=await lstat(path);if(stat.isFile()&&!stat.isSymbolicLink())
      await readJsonl(path,stat.size,row=>{const id=string(row.id),name=displayName(row.thread_name);
        if(id&&name&&!stateNames.has(key('codex',id)))names.set(key('codex',id),name);},{isCancelled:cancelled});
    }catch{/* Optional metadata does not invalidate transcript facts. */}
    let source:DatabaseSync|undefined;
    try{const paths=(await readdir(home)).filter(path=>/^state_\d+\.sqlite$/.test(path)).sort((a,b)=>Number(b.match(/\d+/)![0])-Number(a.match(/\d+/)![0]));
      if(!paths.length)continue;const path=join(home,paths[0]),stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink())continue;
      source=new DatabaseSync(path,{readOnly:true});source.exec('PRAGMA busy_timeout=250;PRAGMA query_only=ON;PRAGMA cache_size=-512;PRAGMA mmap_size=0');
      const columns=source.prepare('PRAGMA table_info(threads)').all().map(row=>row.name);if(!columns.includes('id')||!columns.includes('title'))continue;
      const title=columns.includes('name')?"coalesce(nullif(trim(name),''),title)":'title';
      for(const row of source.prepare(`SELECT id,${title} AS title FROM threads ORDER BY id`).iterate()){
        if(cancelled())break;const name=displayName(row.title);if(name){const id=key('codex',String(row.id));names.set(id,name);stateNames.add(id);}}
    }catch{/* Keep index/log fallback when the optional provider DB is unavailable. */}finally{source?.close();}
  }return names;
}
