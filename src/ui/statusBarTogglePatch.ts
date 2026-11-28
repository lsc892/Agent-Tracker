// Schedules the status bar toggle patch for the current desktop installation.
import { fork } from 'node:child_process';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { t } from '../localization';

export function scheduleStatusBarTogglePatch(context: vscode.ExtensionContext): void {
  if (context.extensionMode !== vscode.ExtensionMode?.Production || !vscode.env?.appRoot
    || vscode.env.uiKind !== vscode.UIKind.Desktop || vscode.env.remoteName
    || (process.platform !== 'win32' && process.platform !== 'linux')) return;
  const mainPid = process.env.VSCODE_PID;
  if (!mainPid || !/^[1-9]\d*$/.test(mainPid)) return;

  const toolsDirectory = join(context.extensionPath, 'tools', 'vscode');
  const { appRoot } = vscode.env;
  try {
    const patcher = require(join(toolsDirectory, 'statusbar-toggle.cjs')) as {
      isInstallationVerified(appRoot: string, version: string): boolean;
    };
    if (patcher.isInstallationVerified(appRoot, vscode.version)) return;
    const helper = fork(join(toolsDirectory, 'statusbar-toggle-auto.cjs'), [appRoot, mainPid, vscode.version], {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      execArgv: [],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    helper.once('message', (message: { status: string; reason?: string }) => {
      if (message.status === 'scheduled') void vscode.window.showInformationMessage(t('extension.restartForStatusBarToggle'));
      if (message.status === 'failed') console.warn('[Agent Tracker] Status bar toggle patch:', message.reason);
    });
    helper.once('error', error => console.warn('[Agent Tracker] Status bar toggle patch:', error.message));
    helper.unref();
  } catch (error) {
    console.warn('[Agent Tracker] Status bar toggle patch:', error);
  }
}
