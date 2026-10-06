import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consumeSseFrames } from './teleprompterSse';
import { TeleprompterState } from './teleprompterState';
import { TeleprompterPlayback } from '../webview/teleprompterPlayback';

test('only the full turn ends buffering; snapshots retain completion and separate messages', () => {
  const state = new TeleprompterState('s1');
  const send = (type: string, data = {}) => state.accept({ type, data: { sessionID: 's1', assistantMessageID: 'a', ...data } });
  send('session.execution.started');
  send('session.text.delta', { delta: '```cpp\nint x;\n' });
  send('session.text.ended', { text: '```cpp\nint x;\n```' });
  send('session.step.ended');
  assert.equal(state.snapshot.phase, 'streaming');
  send('session.text.delta', { assistantMessageID: 'b', delta: '**done**' });
  send('session.execution.succeeded');
  assert.equal(state.snapshot.phase, 'complete');
  assert.equal(state.snapshot.text, '```cpp\nint x;\n```\n\n**done**');
  assert.equal(state.accept({ type: 'session.text.delta', data: { sessionID: 'other', delta: 'wrong' } }), false);
  send('session.execution.started');
  assert.equal(state.snapshot.phase, 'streaming');
  assert.equal(state.snapshot.text, '', 'new turn clears the completed answer immediately');
  send('session.text.delta', { assistantMessageID: 'c', delta: 'second turn' });
  send('session.execution.started'); // permission/status repeat, NOT a new turn
  send('session.text.delta', { assistantMessageID: 'c', delta: ' continued' });
  send('session.text.delta', { assistantMessageID: 'd', delta: 'another part' });
  send('session.execution.succeeded');
  assert.equal(state.snapshot.text, 'second turn continued\n\nanother part');
});

test('a new delta after completion/error clears old content even if start was missed', () => {
  for (const end of ['session.execution.succeeded', 'session.execution.failed']) {
    const state = new TeleprompterState('s1');
    const send = (type: string, data = {}) => state.accept({ type, data: { sessionID: 's1', assistantMessageID: 'a', ...data } });
    send('session.text.delta', { delta: 'old answer' });
    send(end);
    assert.equal(state.accept({ type: 'session.execution.started', data: { sessionID: 'other' } }), false);
    assert.equal(state.snapshot.text, 'old answer');
    send('session.text.delta', { delta: 'new answer' });
    send('session.text.ended', { text: 'new answer complete' });
    send('session.execution.succeeded');
    assert.equal(state.snapshot.text, 'new answer complete');
  }
});

test('playback holds the top, advances fractional pixels, loops and restarts after new output', () => {
  let top = 0, loops = 0;
  // Model browsers that round subpixel scroll writes.
  const surface = { get scrollTop() { return top; }, set scrollTop(value: number) { top = Math.floor(value); }, scrollHeight: 200, clientHeight: 100 };
  const playback = new TeleprompterPlayback(surface, () => loops++);
  playback.speed = 35;
  playback.reset('streaming');
  top = 50; playback.frame(0); playback.frame(1000);
  assert.equal(top, 0);
  playback.reset('complete');
  for (let time = 0; time <= 1000; time += 10) playback.frame(time);
  assert.ok(top >= 34 && top <= 35);
  for (let time = 1010; time <= 4000; time += 10) playback.frame(time);
  assert.equal(loops, 1);
  playback.enabled = false;
  const paused = top;
  playback.frame(4010); playback.frame(4100);
  assert.equal(top, paused);
  playback.reset('streaming');
  assert.equal(top, 0);
  playback.enabled = true;
  playback.frame(5000);
  assert.equal(top, 0);
  playback.reset('complete'); playback.frame(6000); playback.frame(6100);
  assert.ok(top > 0);
});

test('teleprompter keeps incomplete SSE records between chunks', () => {
  const first = consumeSseFrames('', 'data: {"type":"session.text.delta"');
  assert.deepEqual(first.frames, []);
  const second = consumeSseFrames(first.buffer, '}\n\ndata: {"type":"session.text.delta"}\n\n');
  assert.deepEqual(second.frames, [
    'data: {"type":"session.text.delta"}',
    'data: {"type":"session.text.delta"}',
  ]);
  assert.equal(second.buffer, '');
});

test('teleprompter accepts CRLF SSE separators', () => {
  const result = consumeSseFrames('', 'event: message\r\ndata: hello\r\n\r\npartial');
  assert.deepEqual(result.frames, ['event: message\r\ndata: hello']);
  assert.equal(result.buffer, 'partial');
});
