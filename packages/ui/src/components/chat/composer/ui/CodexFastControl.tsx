import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { cn } from '@/lib/utils';

const DRAFT_FAST_KEY = 'codex-fast:draft';
type FastSetting = boolean;

export type CodexFastControlProps = {
  sessionId: string | null;
  footerIconButtonClass: string;
  iconSizeClass: string;
};

/** Independent Codex service-tier switch. The model picker remains responsible for model/effort. */
export function CodexFastControl({ sessionId, footerIconButtonClass, iconSizeClass }: CodexFastControlProps) {
  const [open, setOpen] = React.useState(false);
  const [enabled, setEnabled] = React.useState<FastSetting>(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const pendingDraft = React.useRef<FastSetting | null>(null);

  React.useEffect(() => {
    const stored = sessionId && typeof window !== 'undefined' ? window.localStorage.getItem(`codex-fast:${sessionId}`) : null;
    const draft = typeof window !== 'undefined' ? window.localStorage.getItem(DRAFT_FAST_KEY) : null;
    const next = stored === 'true' ? true : stored === 'false' ? false : draft === 'true';
    pendingDraft.current = !stored && draft === 'true' ? true : null;
    setEnabled(next);
    setError(null);
  }, [sessionId]);

  const persist = React.useCallback(async (next: FastSetting) => {
    if (!sessionId) return;
    const response = await runtimeFetch(`/api/session/${encodeURIComponent(sessionId)}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serviceTier: next ? 'fast' : null }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(`codex-fast:${sessionId}`, String(next));
      window.localStorage.removeItem(DRAFT_FAST_KEY);
    }
  }, [sessionId]);

  React.useEffect(() => {
    const draft = pendingDraft.current;
    if (!sessionId || draft === null) return;
    pendingDraft.current = null;
    void persist(draft).catch((reason) => setError(reason instanceof Error ? reason.message : 'Unable to apply Codex Fast'));
  }, [persist, sessionId]);

  const apply = React.useCallback(async (next: FastSetting) => {
    const previous = enabled;
    setEnabled(next);
    setError(null);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(sessionId ? `codex-fast:${sessionId}` : DRAFT_FAST_KEY, String(next));
    }
    if (!sessionId) {
      setOpen(false);
      return;
    }
    setSaving(true);
    try {
      await persist(next);
      setOpen(false);
    } catch (reason) {
      setEnabled(previous);
      setError(reason instanceof Error ? reason.message : 'Unable to update Codex Fast');
    } finally {
      setSaving(false);
    }
  }, [enabled, persist, sessionId]);

  const label = enabled ? 'Codex Fast enabled' : 'Codex Fast disabled';
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        asChild
        onMouseDown={(event) => event.preventDefault()}
        onPointerDownCapture={(event) => { if (event.pointerType === 'touch') event.preventDefault(); }}
      >
        <button
          type="button"
          className={cn(footerIconButtonClass, 'rounded-md hover:bg-transparent', enabled && 'text-primary')}
          aria-label={label}
          title={error ? `Codex Fast: ${error}` : label}
        >
          <Icon name={saving ? 'loader-4' : 'flashlight'} className={cn(iconSizeClass, saving && 'animate-spin')} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" className="min-w-48">
        <DropdownMenuItem onSelect={() => void apply(true)} data-checked={enabled}>
          <Icon name="flashlight" className="mr-2 size-4" />
          Fast
          {enabled ? <Icon name="check" className="ml-auto size-4" /> : null}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void apply(false)} data-checked={!enabled}>
          <Icon name="brain-ai-3" className="mr-2 size-4" />
          Default
          {!enabled ? <Icon name="check" className="ml-auto size-4" /> : null}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
