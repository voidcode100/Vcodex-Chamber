import React from 'react';
import { AttachedFilesList } from './FileAttachment';
import { Button } from '@/components/ui/button';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { toast } from '@/components/ui';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import type { ToolPopupContent } from './message/types';

export const WindowsSenderQueue = ({ sessionId, onShowPopup }: { sessionId: string | null; onShowPopup?: (value: ToolPopupContent) => void }) => {
  const { vscode } = useRuntimeAPIs();
  const [files, setFiles] = React.useState<AttachedFile[]>([]);
  const [sending, setSending] = React.useState(false);
  const [uncertain, setUncertain] = React.useState<string[]>([]);
  React.useEffect(() => {
    let live = true, revision = 0;
    setFiles([]);
    setUncertain([]);
    if (!vscode || !sessionId) return;
    const read = async () => {
      const current = ++revision;
      try {
        const captures = await vscode.executeCommand('captureCodex.getPendingCaptures', sessionId) as Array<{ id: string; monitor: string; preview: string; uncertainRequestId?: string }>;
        if (live && current === revision) {
          setFiles((captures || []).map(c => ({ id: c.id, file: new File([], `${c.monitor}-${c.id}.png`, { type: 'image/png' }),
            dataUrl: c.preview, filename: `${c.monitor}-${c.id}.png`, mimeType: 'image/png', size: 0, source: 'local' })));
          setUncertain([...new Set((captures || []).flatMap(c => c.uncertainRequestId ? [c.uncertainRequestId] : []))]);
        }
      } catch { /* An unavailable receiver is displayed in connection settings. */ }
    };
    void read();
    const onMessage = (event: MessageEvent) => { if (event.data?.type === 'captureCodex.queueChanged') void read(); };
    window.addEventListener('message', onMessage);
    // Recover a dropped webview notification without re-uploading screenshots.
    const timer = window.setInterval(() => void read(), 15000);
    return () => { live = false; window.removeEventListener('message', onMessage); window.clearInterval(timer); };
  }, [sessionId, vscode]);
  const remove = async (ids: string[]) => {
    if (sending || uncertain.length > 0) return;
    setSending(true);
    try {
      await vscode?.executeCommand('captureCodex.removePendingCaptures', sessionId, ids);
      setFiles(current => current.filter(file => !ids.includes(file.id)));
    } catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
    finally { setSending(false); }
  };
  if (!files.length) return null;
  return <div className="space-y-2 border-b border-border/60 px-3 py-2" data-windowssender-queue>
    <div className="flex items-center justify-between gap-2"><span className="typography-meta text-muted-foreground">WindowsSender · 待发送 {files.length} 张截图</span>
      <div className="flex flex-wrap gap-2"><Button size="xs" variant="ghost" disabled={sending || uncertain.length > 0} onClick={() => void remove(files.map(file => file.id))}>清空截图</Button><Button size="xs" variant="outline" disabled={sending || uncertain.length > 0} onClick={async () => {
        setSending(true);
        const ids = files.map(file => file.id);
        try { await vscode?.executeCommand('captureCodex.sendPendingCaptures', sessionId); setFiles(current => current.filter(file => !ids.includes(file.id))); }
        catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
        finally { setSending(false); }
      }}>{sending ? '处理中…' : '发送全部截图'}</Button></div></div>
    <AttachedFilesList files={files} readOnly={sending || uncertain.length > 0} onRemove={id => void remove([id])} onShowPopup={onShowPopup} />
    {uncertain.length > 0 && <div className="space-y-2 text-xs"><p className="text-destructive">提交结果未确认。请检查会话是否已收到这些截图，再选择：</p><div className="flex flex-wrap gap-2">{[true, false].map(received => <Button key={String(received)} size="xs" variant="outline" disabled={sending} onClick={async () => {
      setSending(true);
      try { for (const requestId of uncertain) await vscode?.executeCommand('captureCodex.resolveUncertainCapture', requestId, received); setUncertain([]); }
      catch (error) { toast.error(String(error)); } finally { setSending(false); }
    }}>{received ? '确认已收到，清除队列' : '确认未收到，允许重试'}</Button>)}</div></div>}
  </div>;
};
