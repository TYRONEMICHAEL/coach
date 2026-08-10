import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pcm16ToWav } from '../src/recorder';
import { scanCaptureQuality } from '../web/capture-quality';

const SR = 24000;

function wavFrom(samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i += 1) view.setInt16(i * 2, samples[i] ?? 0, true);
  return pcm16ToWav(bytes, SR);
}

function sine(seconds: number, amplitude: number): Int16Array {
  const out = new Int16Array(Math.round(seconds * SR));
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 220 * i) / SR));
  }
  return out;
}

test('a clean tone reports zero clicks', () => {
  const report = scanCaptureQuality(wavFrom(sine(2, 8000)));
  assert.equal(report.clickEvents, 0);
  assert.equal(report.sampleRate, SR);
  assert.ok(Math.abs(report.seconds - 2) < 0.01);
});

test('injected capture pops are found and grouped into events', () => {
  // Speech-level carrier (real takes sit near this RMS); pops stand far
  // outside what the local context supports.
  const samples = sine(2, 2000);
  // Three isolated single-sample pops, well apart; the middle one is a
  // two-sample transient that must still count as ONE event.
  samples[Math.round(0.4 * SR)] = 28000;
  samples[Math.round(1.0 * SR)] = -27000;
  samples[Math.round(1.0 * SR) + 3] = 25000;
  samples[Math.round(1.6 * SR)] = 26000;
  const report = scanCaptureQuality(wavFrom(samples), { recorderMimeType: 'audio/mp4' });
  assert.equal(report.clickEvents, 3);
  assert.ok(report.clicksPerMinute > 80);
  assert.equal(report.moments.length, 3);
  assert.deepEqual(report.client, { recorderMimeType: 'audio/mp4' });
});

test('loud noise (a fricative stand-in) does not false-positive', () => {
  const samples = sine(2, 6000);
  // 200ms of dense pseudo-random noise at speech-burst level: large deltas,
  // but the local RMS is just as large — context-relative stays quiet.
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const start = Math.round(0.9 * SR);
  for (let i = 0; i < Math.round(0.2 * SR); i += 1) {
    samples[start + i] = Math.round((rand() * 2 - 1) * 9000);
  }
  const report = scanCaptureQuality(wavFrom(samples));
  assert.equal(report.clickEvents, 0);
});
