import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { PcmRecorder } from '../src/recorder.js';
import { BYTES_PER_SECOND, SAMPLE_RATE } from '../src/types.js';

test('recorder tees frames into a valid wav file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-rec-'));
  const wavPath = path.join(dir, 'take.wav');
  const recorder = new PcmRecorder();

  recorder.write(Buffer.alloc(100)); // inactive: dropped silently
  assert.equal(recorder.active, false);

  recorder.start(wavPath);
  const frame = Buffer.alloc(BYTES_PER_SECOND / 2, 7); // half a second
  recorder.write(frame);
  recorder.write(frame);
  assert.equal(recorder.active, true);
  assert.equal(recorder.seconds, 1);

  const result = recorder.stop();
  assert.equal(result.seconds, 1);
  assert.equal(result.bytes, BYTES_PER_SECOND);
  assert.equal(recorder.active, false);

  const file = fs.readFileSync(wavPath);
  assert.equal(file.length, 44 + BYTES_PER_SECOND);
  assert.equal(file.toString('ascii', 0, 4), 'RIFF');
  assert.equal(file.toString('ascii', 8, 12), 'WAVE');
  assert.equal(file.readUInt32LE(24), SAMPLE_RATE);
  assert.equal(file.readUInt32LE(40), BYTES_PER_SECOND);
});

test('recorder refuses double start and stop when idle', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-rec-'));
  const recorder = new PcmRecorder();
  assert.throws(() => recorder.stop(), /not active/);
  recorder.start(path.join(dir, 'a.wav'));
  assert.throws(() => recorder.start(path.join(dir, 'b.wav')), /already active/);
});
