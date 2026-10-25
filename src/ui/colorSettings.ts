// 상태바 색상 설정 화면과 검증된 설정 저장을 연결한다.
import { localizationBundle, t } from '../localization';
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { readConfiguration } from '../configuration';
import { settingDefinitions, settingKeys } from '../configuration/schema';
import { parseColorSettingsMessage, type StatusColorMode, type ColorTarget } from './colors';
import { colorSettingsHtml } from './html';

/** 색상 설정 패널의 수명과 사용자·워크스페이스 범위의 설정 저장을 관리한다. */
export class ColorSettings implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private ready = false;
  private saving = false;

  constructor(private readonly extensionUri: vscode.Uri) {}

  /**
   * 책임: 색상 설정 패널의 생성·재사용과 메시지 연결을 관리한다.
   * 알고리즘: 기존 패널은 전면화하고 새 패널은 로컬 자원·nonce HTML로 구성하며 현재 패널에서 온 검증된 ready·save 메시지만 처리한다.
   */
  open(): void {
    if (this.panel) { this.panel.reveal(vscode.ViewColumn.Active);this.update();return; }
    const media=vscode.Uri.joinPath(this.extensionUri,'media');
    const panel=vscode.window.createWebviewPanel('agentTracker.colorSettings',t('color.title'),vscode.ViewColumn.Active,{
      enableScripts:true,retainContextWhenHidden:true,localResourceRoots:[media],
    });
    this.panel=panel;
    panel.webview.html=colorSettingsHtml(
      panel.webview.asWebviewUri(vscode.Uri.joinPath(media,'color-settings.js')).toString(),
      panel.webview.asWebviewUri(vscode.Uri.joinPath(media,'dashboard.css')).toString(),
      panel.webview.cspSource,randomBytes(18).toString('base64'));
    panel.onDidDispose(()=>{
      if (this.panel!==panel) return;
      this.panel=undefined;
      this.ready=false;
    });
    panel.webview.onDidReceiveMessage((raw:unknown)=>{
      if (this.panel!==panel) return;
      const message=parseColorSettingsMessage(raw);
      if (!message) return;
      if (message.type==='ready') {
        this.ready=true;
        this.update();
        return;
      }
      if (!this.ready || this.saving) return;
      void this.save(message).catch(()=>this.post({type:'error',message:t('color.saveFailed')}));
    });
  }

  update(): void {
    if (this.panel) this.panel.title = t('color.title');
    if (!this.ready || !this.panel || this.saving) return;
    const config=vscode.workspace.getConfiguration('agentTracker');
    const settings=readConfiguration(config);
    const scopes=[settingKeys.display.colorMode,settingKeys.display.customColor].map(key=>config.inspect(key));
    const hasWorkspace=Boolean(vscode.workspace.workspaceFolders?.length);
    const target:ColorTarget=scopes.some(scope=>scope?.workspaceValue!==undefined) ? 'workspace' : 'user';
    this.post({type:'state',localization:localizationBundle(),mode:settings.display.colorMode,color:settings.display.customColor ?? settingDefinitions.display.customColor.default,hasWorkspace,target});
  }

  /**
   * 책임: 선택한 색상과 모드를 올바른 설정 범위에 저장한다.
   * 알고리즘: 작업공간 존재 여부를 확인하고 saving으로 중복 처리를 막은 뒤 색상·모드 순으로 저장하며, 같은 패널에만 결과를 알린다.
   */
  private async save(value:{mode:StatusColorMode;color:string;target:ColorTarget}):Promise<void> {
    if (value.target!=='user' && !vscode.workspace.workspaceFolders?.length) {
      this.post({type:'error',message:t('color.workspaceRequired')});return;
    }
    this.saving=true;
    const panel=this.panel;
    try {
      const target=value.target==='user' ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace;
      const config=vscode.workspace.getConfiguration('agentTracker');
      await config.update(settingKeys.display.customColor,value.color,target);
      await config.update(settingKeys.display.colorMode,value.mode,target);
      this.saving=false;
      if (this.panel===panel) {this.update();this.post({type:'saved'});}
    } finally {this.saving=false;}
  }

  private post(message:unknown):void {if (this.ready && this.panel) void this.panel.webview.postMessage(message);}
  dispose():void {this.panel?.dispose();}
}
