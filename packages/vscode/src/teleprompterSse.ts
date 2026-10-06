/** Consume complete SSE records while retaining an incomplete network chunk. */
export function consumeSseFrames(buffer: string, chunk: string): { buffer: string; frames: string[] } {
  const combined = `${buffer}${chunk}`;
  const frames = combined.split(/\r?\n\r?\n/);
  return { buffer: frames.pop() ?? '', frames };
}
