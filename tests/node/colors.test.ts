import { createTranslator } from '../../src/localization';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { colorMode, normalizeHexColor, statusForeground, parseColorSettingsMessage } from '../../src/ui/colors';
import { readConfiguration } from '../../src/configuration';
import { colorSettingsHtml } from '../../src/ui/html';

test('status colors inherit theme defaults, accept short and alpha HEX codes and reject invalid settings',()=>{
  assert.equal(normalizeHexColor(' #AbC '),'#aabbcc');assert.equal(normalizeHexColor('#abcd'),'#aabbccdd');
  assert.equal(normalizeHexColor('#AaBbCcDd'),'#aabbccdd');
  for (const value of ['#12','#12345','#1234567','red','var(--x)','";color:red',null,12]) assert.equal(normalizeHexColor(value),undefined);
  assert.equal(statusForeground('automatic','#fff'),'inherit');
  assert.equal(statusForeground('white',undefined),'#ffffff');assert.equal(statusForeground('black','#fff'),'#000000');
  assert.equal(statusForeground('custom','#1234'),'#11223344');assert.equal(statusForeground('custom','bad'),'inherit');
  assert.equal(colorMode('invalid'),'automatic');
  const settings=readConfiguration({get:<T>(key:string,fallback:T)=>({'display.colorMode':'custom','display.customColor':'#abc'} as Record<string,unknown>)[key] as T ?? fallback});
  assert.equal(settings.colorMode,'custom');assert.equal(settings.customColor,'#aabbcc');
});

test('color picker messages only accept supported modes, HEX colors and setting scopes',()=>{
  assert.deepEqual(parseColorSettingsMessage({type:'save',mode:'custom',color:'#abc',target:'user'}),{type:'save',mode:'custom',color:'#aabbcc',target:'user'});
  assert.equal(parseColorSettingsMessage({type:'save',mode:'custom',color:'red',target:'user'}),null);
  assert.equal(parseColorSettingsMessage({type:'save',mode:'custom',color:'#fff',target:'folder'}),null);
  assert.equal(parseColorSettingsMessage({type:'save',mode:'invalid',color:'#fff',target:'workspace'}),null);
  assert.equal(parseColorSettingsMessage({type:'save',mode:['custom'],color:'#fff',target:'user'}),null);
  assert.equal(parseColorSettingsMessage({type:'executeCommand',command:'evil'}),null);
  const html=colorSettingsHtml('local/script','local/style','local:','nonce');
  assert.match(html,/type="color"/);assert.match(html,/default-src 'none'/);assert.doesNotMatch(html,/unsafe-inline|onclick=/);
});

class Element {
  value='';textContent='';disabled=false;
  options=[{value:'user',disabled:false},{value:'workspace',disabled:false}];
  listeners=new Map<string,(event?:unknown)=>void>();
  properties=new Map<string,string>();
  style={setProperty:(key:string,value:string)=>this.properties.set(key,value),removeProperty:(key:string)=>this.properties.delete(key)};
  classList={toggle:()=>{}};
  addEventListener(event:string,callback:(event?:unknown)=>void):void {this.listeners.set(event,callback);}
}

test('color swatch, short HEX and opacity stay synchronized, with validation and save failure recovery',()=>{
  const elements=new Map<string,Element>();
  const get=(id:string):Element=>{if(!elements.has(id)) elements.set(id,new Element());return elements.get(id)!;};
  const messages:Record<string,unknown>[]=[];let receive:((event:{data:unknown})=>void)|undefined;
  new Script(readFileSync(join(__dirname,'../../../media/color-settings.js'),'utf8')).runInNewContext({ agentTrackerI18n: createTranslator('ko'),
    acquireVsCodeApi:()=>({postMessage:(message:Record<string,unknown>)=>messages.push(message)}),
    document:{getElementById:get},window:{addEventListener:(_type:string,listener:typeof receive)=>{receive=listener;}},
  });
  receive!({data:{type:'state',mode:'automatic',color:'#aabbccdd',hasWorkspace:false,target:'user'}});
  assert.equal(get('color-preview').properties.size,0);assert.equal(get('color-picker').value,'#aabbcc');
  assert.equal(get('color-opacity').value,'221');assert.equal(get('color-target').options[1].disabled,true);
  get('color-hex').value='#1234';get('color-hex').listeners.get('input')!();
  assert.equal(get('color-mode').value,'custom');assert.equal(get('color-picker').value,'#112233');
  assert.equal(get('color-preview').properties.get('--tracker-status-color'),'#11223344');
  get('color-picker').value='#abcdef';get('color-opacity').value='255';get('color-picker').listeners.get('input')!();
  assert.equal(get('color-hex').value,'#abcdef');assert.equal(get('color-opacity-value').textContent,'100%');
  get('color-opacity').value='128';get('color-opacity').listeners.get('input')!();
  assert.equal(get('color-hex').value,'#abcdef80');
  get('color-hex').value='#wrong';get('color-hex').listeners.get('input')!();
  assert.equal(get('color-apply').disabled,true);
  get('color-mode').value='automatic';get('color-mode').listeners.get('change')!();
  assert.equal(get('color-apply').disabled,false,'automatic remains available after an invalid custom draft');
  get('color-settings').listeners.get('submit')!({preventDefault:()=>{}});
  assert.equal(messages.at(-1)?.color,'#abcdef80');assert.equal(messages.at(-1)?.mode,'automatic');
  assert.equal(get('color-apply').disabled,true);
  receive!({data:{type:'error',message:'failed'}});assert.equal(get('color-apply').disabled,false);assert.equal(get('color-status').textContent,'failed');
});

test('color settings save only display settings, respect workspace scope and release/reuse their panel',async()=>{
  const Module=require('node:module') as {_load(request:string,parent:unknown,isMain:boolean):unknown};
  const original=Module._load;const values=new Map<string,unknown>();
  const updates:{key:string;value:unknown;target:number}[]=[];
  const messages:Record<string,unknown>[]=[];
  let receive:((message:unknown)=>void)|undefined,disposed:(()=>void)|undefined,reveals=0,workspace=false;
  const uri=(path:string)=>({toString:()=>path});
  const panel={webview:{html:'',cspSource:'local:',asWebviewUri:(value:unknown)=>value,
    postMessage:async(message:Record<string,unknown>)=>{messages.push(message);},onDidReceiveMessage:(listener:typeof receive)=>{receive=listener;}},
    reveal:()=>{reveals++;},onDidDispose:(listener:()=>void)=>{disposed=listener;},dispose:()=>{disposed?.();}};
  Module._load=function(request,parent,isMain) {
    if (request==='vscode') return {Uri:{joinPath:(_base:unknown,...parts:string[])=>uri(parts.join('/'))},ViewColumn:{Active:1},ConfigurationTarget:{Global:1,Workspace:2},
      window:{createWebviewPanel:()=>panel},workspace:{get workspaceFolders(){return workspace ? [{}] : undefined;},getConfiguration:()=>({
        get:(key:string,fallback:unknown)=>values.get(key) ?? fallback,inspect:()=>workspace ? {workspaceValue:'custom'} : {},
        update:async(key:string,value:unknown,target:number)=>{updates.push({key,value,target});values.set(key,value);},
      })}};
    return original.call(this,request,parent,isMain);
  };
  try {
    const {ColorSettings}=require('../../src/ui/colorSettings') as typeof import('../../src/ui/colorSettings');
    const view=new ColorSettings(uri('extension') as import('vscode').Uri);view.open();receive!({type:'ready'});
    assert.equal(messages.at(-1)?.mode,'automatic');view.open();assert.equal(reveals,1);
    receive!({type:'save',mode:'custom',color:'#abc8',target:'workspace'});await new Promise(resolve=>setImmediate(resolve));
    assert.equal(updates.length,0);assert.equal(messages.at(-1)?.type,'error');
    workspace=true;view.update();assert.equal(messages.at(-1)?.target,'workspace');
    receive!({type:'save',mode:'custom',color:'#abc8',target:'workspace'});await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(updates,[{key:'display.customColor',value:'#aabbcc88',target:2},{key:'display.colorMode',value:'custom',target:2}]);
    assert.equal(messages.at(-1)?.type,'saved');view.dispose();
    receive!({type:'save',mode:'black',color:'#fff',target:'user'});assert.equal(updates.length,2,'disposed webview cannot mutate settings');
  } finally {Module._load=original;}
});
