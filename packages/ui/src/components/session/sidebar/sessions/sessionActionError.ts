import type { useI18n } from '@/lib/i18n';
import { OpencodeApiError } from '@/lib/opencode/client';
import { isVSCodeRuntime } from '@/lib/desktop';

type Translate = ReturnType<typeof useI18n>['t'];

/**
 * One sentence a person can act on when a session action fails. An OpenCode
 * failure names the status, the error class and the log ref, because "500"
 * alone sends whoever reads it hunting for a server that is in fact up.
 */
export const describeSessionActionError = (error: Error, t: Translate): string => {
  const backendName = (message: string): string => isVSCodeRuntime() ? message.replaceAll('OpenCode', 'Codex') : message;
  if (error instanceof OpencodeApiError) {
    if (error.status !== undefined && error.ref) {
      return backendName(t('sessions.sidebar.session.action.upstreamErrorWithRef', {
        status: error.status,
        name: error.tag ?? 'Error',
        ref: error.ref,
      }));
    }
    if (error.status !== undefined) {
      return backendName(t('sessions.sidebar.session.action.upstreamError', {
        status: error.status,
        message: error.detail || error.tag || t('sessions.sidebar.session.action.noDetails'),
      }));
    }
  }
  return backendName(error.message || t('sessions.sidebar.session.action.noDetails'));
};
