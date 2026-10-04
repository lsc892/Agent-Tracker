import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { TrackerConfiguration } from '../configuration';
import type { QuotaProviderId, QuotaState } from '../quota/types';
import { quotaHtml, parseQuotaMessage } from './quotaViewPresentation';

export interface QuotaViewDependencies {
  extensionUri: vscode.Uri;
  settings(): TrackerConfiguration;
  quota(): QuotaState[];
  refresh(): Promise<void>;
  openUsage(): void;
}

/** Public VS Code APIs expose panel views, but no status-bar-anchored Webview popovers. */
export class QuotaView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private ready = false;
  private opening: Promise<void> | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly dependencies: QuotaViewDependencies) {}

  async toggle(): Promise<void> {
    if (this.opening) return this.opening;
    if (this.view?.visible) {
      await vscode.commands.executeCommand('workbench.action.closePanel');
      return;
    }
    this.opening = Promise.resolve(vscode.commands.executeCommand('agentTracker.quotaView.focus'))
      .then(() => { this.update(); })
      .finally(() => { this.opening = undefined; });
    return this.opening;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    const media = vscode.Uri.joinPath(this.dependencies.extensionUri, 'media');
    const icons = vscode.Uri.joinPath(this.dependencies.extensionUri, 'resource', 'icon');
    view.webview.options = { enableScripts: true, localResourceRoots: [media, icons] };
    const uri = (base: vscode.Uri, file: string): string => view.webview.asWebviewUri(vscode.Uri.joinPath(base, file)).toString();
    view.webview.html = quotaHtml({ script: uri(media, 'quota.js'), style: uri(media, 'quota.css'),
      codex: uri(icons, 'codex.svg'), claude: uri(icons, 'claude.svg'), csp: view.webview.cspSource, nonce: randomBytes(18).toString('base64') });
    this.disposables.push(view.webview.onDidReceiveMessage((raw: unknown) => {
      const message = parseQuotaMessage(raw);
      if (!message) return;
      void (async () => {
        switch (message.type) {
          case 'ready': this.ready = true; this.update(); break;
          case 'refreshQuota': await this.dependencies.refresh(); break;
          case 'openUsage':
            await vscode.commands.executeCommand('workbench.action.closePanel');
            this.dependencies.openUsage();
            break;
          case 'manage': await this.openExtension(message.provider); break;
          case 'detail':
            await vscode.workspace.getConfiguration('agentTracker').update('display.detail', message.detail, vscode.ConfigurationTarget.Global);
            break;
        }
      })().catch(() => { void vscode.window.showErrorMessage('Agent Tracker 작업을 완료하지 못했습니다. 다시 시도해 주세요.'); });
    }), view.onDidChangeVisibility(() => { if (view.visible) this.update(); }), view.onDidDispose(() => {
      if (this.view === view) { this.view = undefined; this.ready = false; }
    }));
  }

  update(): void {
    if (!this.ready || !this.view) return;
    const settings = this.dependencies.settings();
    void this.view.webview.postMessage({ type: 'quota', states: this.dependencies.quota(), percentage: settings.percentage, detail: settings.detail });
  }

  dispose(): void {
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    this.view = undefined;
    this.ready = false;
  }

  private async openExtension(provider: QuotaProviderId): Promise<void> {
    const id = provider === 'claude' ? 'anthropic.claude-code' : 'openai.chatgpt';
    await vscode.commands.executeCommand('extension.open', id);
  }
}
