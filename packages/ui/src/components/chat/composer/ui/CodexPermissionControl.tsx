import React from 'react';

import { Icon } from '@/components/icon/Icon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { cn } from '@/lib/utils';

type PermissionChoice = 'ask' | 'help' | 'full' | `profile:${string}`;
type PermissionProfile = { id: string; description?: string | null; allowed?: boolean };
const DRAFT_PERMISSION_KEY = 'codex-permission:draft';

export type CodexPermissionControlProps = {
  sessionId: string | null;
  directory?: string;
  footerIconButtonClass: string;
  iconSizeClass: string;
};

/** Codex's sandbox/approval choices, kept separate from OpenChamber's auto-accept policy. */
export function CodexPermissionControl({ sessionId, directory, footerIconButtonClass, iconSizeClass }: CodexPermissionControlProps) {
  const [open, setOpen] = React.useState(false);
  const [choice, setChoice] = React.useState<PermissionChoice>('ask');
  const [profiles, setProfiles] = React.useState<PermissionProfile[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const pendingDraftChoice = React.useRef<PermissionChoice | null>(null);

  React.useEffect(() => {
    const stored = sessionId && typeof window !== 'undefined' ? window.localStorage.getItem(`codex-permission:${sessionId}`) : null;
    const draft = typeof window !== 'undefined' ? window.localStorage.getItem(DRAFT_PERMISSION_KEY) : null;
    const valid = (value: string | null): value is PermissionChoice => value === 'ask' || value === 'help' || value === 'full' || Boolean(value?.startsWith('profile:'));
    const next = valid(stored) ? stored : valid(draft) ? draft : 'ask';
    pendingDraftChoice.current = !stored && valid(draft) ? next : null;
    setChoice(next);
    setProfiles([]);
    setError(null);
  }, [sessionId]);

  const settingsForChoice = React.useCallback((next: PermissionChoice): Record<string, unknown> => {
    const workspaceWrite = {
      type: 'workspaceWrite',
      writableRoots: directory ? [directory] : [],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
    return next === 'ask'
      ? { approvalPolicy: 'on-request', sandboxPolicy: workspaceWrite, permissions: null }
      : next === 'help'
        ? { approvalPolicy: 'untrusted', sandboxPolicy: workspaceWrite, permissions: null }
        : next === 'full'
          ? { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' }, permissions: null }
          : { permissions: next.slice('profile:'.length), sandboxPolicy: null };
  }, [directory]);

  const persistChoice = React.useCallback(async (next: PermissionChoice) => {
    if (!sessionId) return;
    const response = await runtimeFetch(`/api/session/${encodeURIComponent(sessionId)}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settingsForChoice(next)),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(`codex-permission:${sessionId}`, next);
      window.localStorage.removeItem(DRAFT_PERMISSION_KEY);
    }
  }, [sessionId, settingsForChoice]);

  React.useEffect(() => {
    const next = pendingDraftChoice.current;
    if (!sessionId || !next) return;
    pendingDraftChoice.current = null;
    void persistChoice(next).catch((reason) => {
      setError(reason instanceof Error ? reason.message : 'Unable to apply Codex permissions');
    });
  }, [persistChoice, sessionId]);

  const loadProfiles = React.useCallback(async () => {
    if (profiles.length || loading) return;
    setLoading(true);
    try {
      const query = directory ? `?directory=${encodeURIComponent(directory)}` : '';
      const response = await runtimeFetch(`/api/codex/permission-profiles${query}`);
      if (!response.ok) return;
      const payload = await response.json() as { data?: PermissionProfile[] };
      setProfiles(Array.isArray(payload.data) ? payload.data.filter((profile) => profile.allowed !== false && typeof profile.id === 'string') : []);
    } catch (error) {
      console.warn('[codex] permission profiles unavailable', error);
    } finally {
      setLoading(false);
    }
  }, [directory, loading, profiles.length]);

  const apply = React.useCallback(async (next: PermissionChoice) => {
    const previous = choice;
    setChoice(next);
    setError(null);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(sessionId ? `codex-permission:${sessionId}` : DRAFT_PERMISSION_KEY, next);
    }
    if (!sessionId) {
      setOpen(false);
      return;
    }
    setSaving(true);
    try {
      await persistChoice(next);
      setOpen(false);
    } catch (error) {
      setChoice(previous);
      if (typeof window !== 'undefined') {
        const key = sessionId ? `codex-permission:${sessionId}` : DRAFT_PERMISSION_KEY;
        window.localStorage.setItem(key, previous);
      }
      setError(error instanceof Error ? error.message : 'Unable to update Codex permissions');
      console.warn('[codex] permission setting failed', error);
    } finally {
      setSaving(false);
    }
  }, [choice, persistChoice, sessionId]);

  const label = choice === 'full' ? 'Full access' : choice === 'help' ? 'Help me approve' : choice === 'ask' ? 'Ask for approval' : profiles.find((profile) => `profile:${profile.id}` === choice)?.id || 'Profile';

  return (
    <DropdownMenu open={open} onOpenChange={(nextOpen) => { setOpen(nextOpen); if (nextOpen) void loadProfiles(); }}>
      <DropdownMenuTrigger
        asChild
        onMouseDown={(event) => event.preventDefault()}
        onPointerDownCapture={(event) => { if (event.pointerType === 'touch') event.preventDefault(); }}
      >
        <button type="button" className={cn(footerIconButtonClass, 'rounded-md hover:bg-transparent', choice !== 'ask' && 'text-primary')} aria-label={`Codex permissions: ${label}`} title={error ? `Codex permissions: ${error}` : `Codex permissions: ${label}`}>
          <Icon name={saving ? 'loader-4' : choice === 'full' ? 'shield-check' : 'shield-user'} className={cn(iconSizeClass, saving && 'animate-spin')} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" className="min-w-56">
        <DropdownMenuLabel>Codex permissions</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => void apply('ask')} data-checked={choice === 'ask'}>
          <Icon name="shield-user" className="mr-2 size-4" /> Ask for approval {choice === 'ask' ? <Icon name="check" className="ml-auto size-4" /> : null}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void apply('help')} data-checked={choice === 'help'}>
          <Icon name="checkbox-circle" className="mr-2 size-4" /> Help me approve {choice === 'help' ? <Icon name="check" className="ml-auto size-4" /> : null}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void apply('full')} data-checked={choice === 'full'}>
          <Icon name="shield-check" className="mr-2 size-4" /> Full access {choice === 'full' ? <Icon name="check" className="ml-auto size-4" /> : null}
        </DropdownMenuItem>
        {profiles.length > 0 ? <DropdownMenuSeparator /> : null}
        {profiles.map((profile) => (
          <DropdownMenuItem key={profile.id} onSelect={() => void apply(`profile:${profile.id}`)} data-checked={choice === `profile:${profile.id}`}>
            <Icon name="key" className="mr-2 size-4" /> {profile.id} {choice === `profile:${profile.id}` ? <Icon name="check" className="ml-auto size-4" /> : null}
          </DropdownMenuItem>
        ))}
        {error ? <DropdownMenuLabel className="text-destructive">{error}</DropdownMenuLabel> : null}
        {loading ? <DropdownMenuLabel className="text-muted-foreground">Loading profiles...</DropdownMenuLabel> : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
