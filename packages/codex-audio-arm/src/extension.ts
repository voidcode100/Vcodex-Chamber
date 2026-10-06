import * as vscode from 'vscode';
import { join } from 'node:path';
import { LinuxArmMicrophone } from './microphone';

let microphone: LinuxArmMicrophone | undefined;

export function activate(context: vscode.ExtensionContext): void {
  microphone = new LinuxArmMicrophone(join(context.extensionPath, 'native/linux-arm64/recorder'), () =>
    vscode.workspace.getConfiguration('vcodexAudio').get<string>('inputDevice', '').trim()
    || vscode.workspace.getConfiguration('captureCodex').get<string>('voice.inputDevice', ''));
  for (const action of ['available', 'start', 'read', 'stop', 'cancel']) {
    context.subscriptions.push(vscode.commands.registerCommand(`_vcodex.audio.${action}`, async (id?: string) => {
      if (process.platform !== 'linux' || process.arch !== 'arm64') throw new Error('Vcodex Audio ARM requires a local Linux ARM64 VS Code host.');
      return microphone!.command(`_vcodex.audio.${action}`, id);
    }));
  }
}

export async function deactivate(): Promise<void> {
  await microphone?.dispose();
  microphone = undefined;
}
