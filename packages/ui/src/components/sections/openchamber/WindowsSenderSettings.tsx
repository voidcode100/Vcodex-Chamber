import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SettingsSection, SettingsFieldRow } from '@/components/sections/shared/SettingsSection';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { isVSCodeRuntime } from '@/lib/desktop';
import { toast } from '@/components/ui';
type Status = { activeSessionId?: string; pendingCaptures?: number; uncertainRequests?: number; connection?: string; auth?: string; target?: { sessionId?: string }; voice?: { state?: string } };
type SenderSettings = { receiverEnabled: boolean; receiverAddress: string; receiverPort: number; receiverToken: string; certificateSha256: string; targetMode: 'active' | 'pinned'; targetSessionId: string; status?: Status };
const empty: SenderSettings = { receiverEnabled: false, receiverAddress: '0.0.0.0', receiverPort: 43127, receiverToken: '', certificateSha256: '', targetMode: 'active', targetSessionId: '' };

export const WindowsSenderSettings = () => {
  const { vscode } = useRuntimeAPIs();
  const [value, setValue] = React.useState(empty);
  const [busy, setBusy] = React.useState(false), [loading, setLoading] = React.useState(true), [error, setError] = React.useState('');
  React.useEffect(() => {
    let live = true;
    void vscode?.executeCommand('captureCodex.getWindowsSenderSettings').then(result => { if (live) setValue({ ...empty, ...(result as SenderSettings) }); })
      .catch(reason => { if (live) setError(String(reason)); }).finally(() => { if (live) setLoading(false); });
    const timer = window.setInterval(() => {
      void vscode?.executeCommand('captureCodex.getReceiverStatus').then(status => { if (live) setValue(current => ({ ...current, status: status as Status })); }).catch(() => undefined);
    }, 5000);
    return () => { live = false; window.clearInterval(timer); };
  }, [vscode]);
  const update = <K extends keyof SenderSettings>(key: K, next: SenderSettings[K]) => setValue(current => ({ ...current, [key]: next }));
  const save = async () => {
    if (!vscode) return;
    if (!Number.isInteger(value.receiverPort) || value.receiverPort < 1024 || value.receiverPort > 65535) throw new Error('端口必须在 1024–65535 之间。');
    if (value.targetMode === 'pinned' && !value.targetSessionId.trim()) throw new Error('固定模式需要会话 ID。');
    const result = await vscode.executeCommand('captureCodex.updateWindowsSenderSettings', value);
    setValue({ ...empty, ...(result as SenderSettings) });
  };
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await action(); }
    catch (reason) { const message = reason instanceof Error ? reason.message : String(reason); setError(message); toast.error(message); }
    finally { setBusy(false); }
  };
  const copy = (text: string) => run(async () => { if (!text) throw new Error('请先启动接收端。'); await navigator.clipboard.writeText(text); toast.success('已复制'); });
  if (!isVSCodeRuntime()) return null;
  return <SettingsSection title="WindowsSender 与 Codex 提词器" description="WindowsSender 填写运行 VS Code 的这台主机地址。截图键先加入会话框，发送键批量提交；开始/停止录音分别使用两个快捷键。">
    <div className="space-y-0.5">
      <div className="mb-3 rounded-lg border border-border bg-muted/30 p-3 text-xs space-y-1" role="status">
        <p>{value.receiverEnabled ? '接收端已启动' : '接收端已停止'} · Codex：{value.status?.connection || '待检查'} · 登录：{value.status?.auth || '待检查'}</p>
        <p>目标：{value.status?.target?.sessionId || '尚未打开会话'} · 暂存截图：{value.status?.pendingCaptures || 0} · 录音：{value.status?.voice?.state || 'idle'}</p>
        {Boolean(value.status?.uncertainRequests) && <p className="text-destructive">有提交结果未确认的截图，请先检查对应会话；已阻止重复发送。</p>}
        {error && <p className="text-destructive">{error}</p>}
      </div>
      <SettingsFieldRow settingsItem="capture.receiver-address" label="监听地址" description="0.0.0.0 接受局域网连接；仅同机可用 127.0.0.1。" alignEnd={false}><Input value={value.receiverAddress} onChange={event => update('receiverAddress', event.target.value)} disabled={loading || busy} className="h-8 font-mono text-xs" /></SettingsFieldRow>
      <SettingsFieldRow settingsItem="capture.receiver-port" label="接收端口" alignEnd={false}><Input type="number" min={1024} max={65535} value={value.receiverPort} onChange={event => update('receiverPort', Number(event.target.value))} disabled={loading || busy} className="h-8 w-32 font-mono text-xs" /></SettingsFieldRow>
      <SettingsFieldRow settingsItem="capture.receiver-token" label="配对令牌" description="首次启动自动生成，复制到 WindowsSender。" alignEnd={false}><div className="flex gap-2"><Input type="password" value={value.receiverToken} onChange={event => update('receiverToken', event.target.value)} disabled={loading || busy} className="h-8 font-mono text-xs" /><Button size="xs" variant="outline" disabled={busy || !value.receiverToken} onClick={() => void copy(value.receiverToken)}>复制</Button></div></SettingsFieldRow>
      <SettingsFieldRow settingsItem="capture.receiver-certificate" label="证书指纹" description="启动后生成，可直接粘贴到 WindowsSender，支持冒号格式。" alignEnd={false}><div className="flex gap-2"><Input readOnly value={value.certificateSha256 || '尚未启动'} className="h-8 font-mono text-xs" /><Button size="xs" variant="outline" disabled={busy || !value.certificateSha256} onClick={() => void copy(value.certificateSha256)}>复制</Button></div></SettingsFieldRow>
      <SettingsFieldRow settingsItem="capture.target-mode" label="截图与录音目标" description="接收后绑定会话，切换页面不改变已暂存内容的目标。会话 Prompt 在新建会话时设置。" alignEnd={false}><Select value={value.targetMode} onValueChange={mode => update('targetMode', mode as SenderSettings['targetMode'])} disabled={loading || busy}><SelectTrigger className="h-8"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="active">当前打开会话</SelectItem><SelectItem value="pinned">固定会话</SelectItem></SelectContent></Select></SettingsFieldRow>
      {value.targetMode === 'pinned' && <SettingsFieldRow settingsItem="capture.target-session" label="固定会话 ID" alignEnd={false}><div className="flex gap-2"><Input value={value.targetSessionId} onChange={event => update('targetSessionId', event.target.value)} disabled={loading || busy} className="h-8 font-mono text-xs"/><Button size="xs" variant="outline" disabled={busy || !value.status?.activeSessionId} onClick={() => update('targetSessionId', value.status?.activeSessionId || '')}>使用当前会话</Button></div></SettingsFieldRow>}
      <div className="flex flex-wrap gap-2 py-2">
        <Button size="xs" disabled={loading || busy} onClick={() => void run(async () => { await save(); toast.success('设置已保存'); })}>{busy ? '处理中…' : '保存并应用'}</Button>
        <Button size="xs" variant="outline" disabled={loading || busy} onClick={() => void run(async () => {
          if (!value.receiverEnabled) await save();
          await vscode?.executeCommand('captureCodex.toggleReceiver');
          const result = await vscode?.executeCommand('captureCodex.getWindowsSenderSettings'); setValue({ ...empty, ...(result as SenderSettings) });
        })}>{value.receiverEnabled ? '停止接收端' : '启动接收端'}</Button>
        <Button size="xs" variant="outline" onClick={() => void run(async () => { await vscode?.executeCommand('captureCodex.configureVoice'); })}>麦克风 / 听写设置</Button>
        <Button size="xs" variant="outline" onClick={() => void run(async () => { await vscode?.executeCommand('captureCodex.openPrompter'); })}>打开提词器</Button>
      </div>
      <p className="typography-meta text-muted-foreground py-2">客户端需保持 VS Code 开启并启用接收端。离线截图保留在发送端；恢复连接只暂存，按发送键后才提交。录音使用客户端麦克风和 Codex Audio，停止后自动转写并发送。</p>
    </div>
  </SettingsSection>;
};
