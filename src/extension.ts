import type * as vscode from 'vscode';
import { AgentTrackerApp } from './app';

let app: AgentTrackerApp | undefined;

/**
 * 책임: 확장 시작과 초기화 실패 시 리소스 회수를 맡는다.
 * 알고리즘: 앱 인스턴스를 등록하고 순서대로 시작하며, 실패하면 같은 인스턴스를 정리한 뒤 오류를 전달한다.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const current = new AgentTrackerApp(context);
  app = current;
  try {
    await current.start();
  } catch (error) {
    await current.dispose();
    if (app === current) app = undefined;
    throw error;
  }
}

export async function deactivate(): Promise<void> {
  const current = app;
  await current?.dispose();
  if (app === current) app = undefined;
}
