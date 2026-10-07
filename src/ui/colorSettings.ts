import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { readConfiguration } from '../configuration';
import { parseColorSettingsMessage, type StatusColorMode, type ColorTarget } from './colors';
import { colorSettingsHtml } from './html';

/** A settings-only color picker; it never starts quota reads or transcript scans. */
export class ColorSettings implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private ready = false;
  private saving = false;

  constructor(private readonly extensionUri: vscode.Uri) {}

  open(): void {
    if (this.panel) { this.panel.reveal(vscode.ViewColumn.Active);this.update();return; }
    const media=vscode.Uri.joinPath(this.extensionUri,'media');
    const panel=vscode.window.createWebviewPanel('agentTracker.colorSettings','Agent Tracker 색상',vscode.ViewColumn.Active,{
      enableScripts:true,retainContextWhenHidden:true,localResourceRoots:[media],
    });
    this.panel=panel;
    panel.webview.html=colorSettingsHtml(
      panel.webview.asWebviewUri(vscode.Uri.joinPath(media,'color-settings.js')).toString(),
      panel.webview.asWebviewUri(vscode.Uri.joinPath(media,'dashboard.css')).toString(),
      panel.webview.cspSource,randomBytes(18).toString('base64'));
    panel.onDidDispose(()=>{ if (this.panel===panel) {this.panel=undefined;this.ready=false;} });
    panel.webview.onDidReceiveMessage((raw:unknown)=>{
      if (this.panel!==panel) return;
      const message=parseColorSettingsMessage(raw);
      if (!message) return;
      if (message.type==='ready') {this.ready=true;this.update();}
      else if (this.ready && !this.saving) void this.save(message).catch(()=>this.post({type:'error',message:'색상 설정을 저장하지 못했습니다. 다시 적용해 주세요.'}));
    });
  }

  update(): void {
    if (!this.ready || !this.panel || this.saving) return;
    const config=vscode.workspace.getConfiguration('agentTracker');
    const settings=readConfiguration(config);
    const scopes=['display.colorMode','display.customColor'].map(key=>config.inspect(key));
    const hasWorkspace=Boolean(vscode.workspace.workspaceFolders?.length);
    const target:ColorTarget=scopes.some(scope=>scope?.workspaceValue!==undefined) ? 'workspace' : 'user';
    this.post({type:'state',mode:settings.colorMode,color:settings.customColor ?? '#ffffff',hasWorkspace,target});
  }

  private async save(value:{mode:StatusColorMode;color:string;target:ColorTarget}):Promise<void> {
    if (value.target!=='user' && !vscode.workspace.workspaceFolders?.length) {
      this.post({type:'error',message:'작업공간에 저장하려면 폴더나 작업공간을 먼저 열어 주세요.'});return;
    }
    this.saving=true;
    const panel=this.panel;
    try {
      const target=value.target==='user' ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace;
      const config=vscode.workspace.getConfiguration('agentTracker');
      await config.update('display.customColor',value.color,target);
      await config.update('display.colorMode',value.mode,target);
      this.saving=false;
      if (this.panel===panel) {this.update();this.post({type:'saved'});}
    } finally {this.saving=false;}
  }

  private post(message:unknown):void {if (this.ready && this.panel) void this.panel.webview.postMessage(message);}
  dispose():void {this.panel?.dispose();}
}
