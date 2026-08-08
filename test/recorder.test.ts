import assert from 'node:assert/strict';
import { test } from 'node:test';
import { float32ToPcm16, PcmTakeRecorder, pcm16ToWav } from '../src/recorder';
import { BYTES_PER_SECOND, SAMPLE_RATE } from '../src/types';

test('recorder tees frames into a valid wav take', async () => {
  const recorder = new PcmTakeRecorder();

  recorder.write(new Uint8Array(100)); // inactive: dropped silently
  assert.equal(recorder.active, false);

  recorder.start('board-take-1');
  const frame = new Uint8Array(BYTES_PER_SECOND / 2).fill(7); // half a second
  recorder.write(frame);
  recorder.write(frame);
  assert.equal(recorder.active, true);
  assert.equal(recorder.seconds, 1);

  const take = await recorder.stop();
  assert.equal(take.id, 'board-take-1');
  assert.equal(take.seconds, 1);
  assert.equal(recorder.active, false);

  const wav = take.wav;
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(wav.length, 44 + BYTES_PER_SECOND);
  assert.equal(String.fromCharCode(...wav.subarray(0, 4)), 'RIFF');
  assert.equal(String.fromCharCode(...wav.subarray(8, 12)), 'WAVE');
  assert.equal(view.getUint32(24, true), SAMPLE_RATE);
  assert.equal(view.getUint32(40, true), BYTES_PER_SECOND);
  assert.equal(wav[44], 7); // the teed frames, verbatim
});

test('recorder refuses double start and stop when idle', async () => {
  const recorder = new PcmTakeRecorder();
  await assert.rejects(() => recorder.stop(), /not active/);
  recorder.start('a');
  assert.throws(() => recorder.start('b'), /already active/);
});

test('float32 conversion clamps and preserves silence', () => {
  const pcm = float32ToPcm16(new Float32Array([0, 1.5, -1.5, 0.5]));
  const view = new DataView(pcm.buffer);
  assert.equal(view.getInt16(0, true), 0);
  assert.equal(view.getInt16(2, true), 0x7fff); // clamped high
  assert.equal(view.getInt16(4, true), -0x8000); // clamped low
  assert.ok(Math.abs(view.getInt16(6, true) - 0x7fff / 2) <= 1);
  const wav = pcm16ToWav(pcm, SAMPLE_RATE);
  assert.equal(wav.length, 44 + 8);
});
