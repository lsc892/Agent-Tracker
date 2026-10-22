import type * as vscode from 'vscode';
import { AgentTrackerApp } from './app';

let app: AgentTrackerApp | undefined;

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
