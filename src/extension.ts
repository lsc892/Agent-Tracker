// VS Code의 활성화·비활성화 요청을 앱의 시작·종료로 연결한다.
import type * as vscode from 'vscode';
import { AgentTrackerApp } from './app';

let app: AgentTrackerApp | undefined;

/**
 * 책임: 확장 시작과 초기화 실패 시 리소스 회수를 맡는다.
 * 알고리즘: 앱 인스턴스를 등록하고 순서대로 시작하며, 실패하면 같은 인스턴스를 정리한 뒤 오류를 전달한다.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // [실행 정책] 시작 전에 앱을 등록해 비활성화가 같은 인스턴스를 정리할 수 있게 한다.
  const current = new AgentTrackerApp(context);
  app = current;
  try {
    await current.start();
  } catch (error) {
    // [종료 정책] 시작에 실패한 인스턴스를 정리하고 그 사이 다른 앱이 등록됐으면 보존한다.
    await current.dispose();
    if (app === current) app = undefined;
    throw error;
  }
}

export async function deactivate(): Promise<void> {
  // [종료 정책] 비활성화 시점의 앱을 기다린 뒤 같은 인스턴스만 등록에서 제거한다.
  const current = app;
  await current?.dispose();
  if (app === current) app = undefined;
}
