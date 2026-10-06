type ScrollSurface = { scrollTop: number; scrollHeight: number; clientHeight: number };

/** No scroll-event pause handler: scrollTop changes dispatch scroll asynchronously. */
export class TeleprompterPlayback {
  phase: 'waiting' | 'streaming' | 'complete' | 'error' = 'waiting';
  enabled = true;
  speed = 35;
  private position = 0;
  private previousTime?: number;
  constructor(private readonly surface: ScrollSurface, private readonly onLoop = () => {}) {}
  reset(phase: TeleprompterPlayback['phase']): void {
    this.phase = phase;
    this.position = 0;
    this.surface.scrollTop = 0;
    this.previousTime = undefined;
  }
  frame(now: number): void {
    const elapsed = this.previousTime === undefined ? 0 : Math.min(100, Math.max(0, now - this.previousTime));
    this.previousTime = now;
    if (this.phase === 'streaming') { this.surface.scrollTop = 0; this.position = 0; return; }
    if (this.phase !== 'complete' || !this.enabled) { this.position = this.surface.scrollTop; return; }
    const end = Math.max(0, this.surface.scrollHeight - this.surface.clientHeight);
    if (end === 0) return;
    // Preserve fractional pixels even if the browser rounds assigned scrollTop.
    this.position += this.speed * elapsed / 1000;
    if (this.position > end) { this.position = 0; this.onLoop(); }
    this.surface.scrollTop = Math.min(end, this.position);
  }
}
