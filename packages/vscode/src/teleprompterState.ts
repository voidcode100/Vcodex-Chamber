export type TeleprompterSettings = { speed: number; fontSize: number; lineHeight: number; follow: boolean; finalOnly: boolean };
export const teleprompterDefaults: TeleprompterSettings = { speed: 35, fontSize: 28, lineHeight: 1.45, follow: true, finalOnly: false };
export type TeleprompterSnapshot = {
  type: 'snapshot'; revision: number; sessionId?: string; text: string;
  phase: 'waiting' | 'streaming' | 'complete' | 'error'; error?: string;
};

/** Only the execution boundary ends playback buffering, not a text/tool item. */
export class TeleprompterState {
  private parts = new Map<string, string>();
  snapshot: TeleprompterSnapshot;
  constructor(sessionId?: string) {
    this.snapshot = { type: 'snapshot', revision: 0, sessionId, text: '', phase: 'waiting' };
  }
  private beginOutput(): void {
    // Busy/start can repeat for status changes and approval requests in one turn.
    // Clear only when crossing into a new execution, preserving its text parts.
    if (this.snapshot.phase !== 'streaming') {
      this.parts.clear();
      this.snapshot.error = undefined;
    }
    this.snapshot.phase = 'streaming';
  }
  accept(event: { type?: string; data?: Record<string, unknown> }): boolean {
    const data = event.data;
    if (!data || typeof data.sessionID !== 'string') return false;
    if (this.snapshot.sessionId && data.sessionID !== this.snapshot.sessionId) return false;
    const key = `${data.assistantMessageID ?? 'assistant'}:${data.ordinal ?? 0}`;
    switch (event.type) {
      case 'session.execution.started': this.beginOutput(); break;
      case 'session.text.delta':
        if (typeof data.delta !== 'string') return false;
        // A reconnect can miss the start notification; the next delta still
        // must not append a new turn to the completed turn's text.
        this.beginOutput();
        this.parts.set(key, (this.parts.get(key) ?? '') + data.delta);
        break;
      case 'session.text.ended':
        if (typeof data.text !== 'string') return false;
        this.parts.set(key, data.text);
        break;
      case 'session.execution.succeeded': this.snapshot.phase = 'complete'; break;
      case 'session.execution.failed': this.snapshot.phase = 'error'; break;
      default: return false;
    }
    this.snapshot.sessionId = data.sessionID;
    this.snapshot.text = [...this.parts.values()].join('\n\n');
    this.snapshot.revision++;
    return true;
  }
}
