// Capture-quality scan: every analyzed take grades its own recording, so a
// crackling mic is a measured fact in the bundle, not a memory of what the
// phone sounded like. Detector is context-relative — a click is a sample
// jump far beyond what the surrounding 5ms supports — so loud fricatives
// and plosives, which carry their own local energy, do not false-positive.

export interface CaptureMoment {
  tSeconds: number;
  peakDelta: number;
}

export interface CaptureReport {
  seconds: number;
  sampleRate: number;
  /** Discrete click events (hits within 20ms are one event). */
  clickEvents: number;
  clicksPerMinute: number;
  /** Worst first, capped — enough to find the pops, not a data dump. */
  moments: CaptureMoment[];
  /** Whatever the client reported about its capture path (mic settings,
   * recorder mime type). Absent for old clients. */
  client?: unknown;
}

const DELTA_FLOOR = 6000;
const RMS_FLOOR = 200;
const RMS_RATIO = 6;
const GROUP_MS = 20;
const MAX_MOMENTS = 40;

/** Parse 16-bit mono WAV bytes and scan for capture clicks. */
export function scanCaptureQuality(wav: Uint8Array, client?: unknown): CaptureReport {
  const { samples, sampleRate } = parseWav16Mono(wav);
  const n = samples.length;
  const seconds = n / sampleRate;
  const win = Math.max(1, Math.round(sampleRate * 0.005));

  // Prefix sums of squares make the 5ms RMS window O(1) per sample.
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i += 1) {
    const s = samples[i] ?? 0;
    prefix[i + 1] = (prefix[i] ?? 0) + s * s;
  }
  const localRms = (i: number): number => {
    const lo = Math.max(0, i - win);
    const hi = Math.min(n, i + win);
    return Math.sqrt(((prefix[hi] ?? 0) - (prefix[lo] ?? 0)) / (hi - lo));
  };

  const groupGap = Math.round((GROUP_MS / 1000) * sampleRate);
  const events: CaptureMoment[] = [];
  let lastHit = -1;
  for (let i = 1; i < n; i += 1) {
    const delta = Math.abs((samples[i] ?? 0) - (samples[i - 1] ?? 0));
    if (delta < DELTA_FLOOR) continue;
    const rms = localRms(i);
    if (rms <= RMS_FLOOR || delta <= RMS_RATIO * rms) continue;
    const current = events[events.length - 1];
    if (lastHit >= 0 && i - lastHit <= groupGap && current) {
      if (delta > current.peakDelta) current.peakDelta = delta;
    } else {
      events.push({ tSeconds: round3(i / sampleRate), peakDelta: delta });
    }
    lastHit = i;
  }

  const moments = [...events].sort((a, b) => b.peakDelta - a.peakDelta).slice(0, MAX_MOMENTS);
  return {
    seconds: round3(seconds),
    sampleRate,
    clickEvents: events.length,
    clicksPerMinute: seconds > 0 ? round3(events.length / (seconds / 60)) : 0,
    moments,
    ...(client === undefined ? {} : { client }),
  };
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** Minimal RIFF walk: find fmt and data, insist on 16-bit mono PCM. */
function parseWav16Mono(wav: Uint8Array): { samples: Int16Array; sampleRate: number } {
  if (wav.length < 44) throw new Error('wav too short');
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (offset: number) =>
    String.fromCharCode(wav[offset] ?? 0, wav[offset + 1] ?? 0, wav[offset + 2] ?? 0, wav[offset + 3] ?? 0);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a wav');

  let sampleRate = 0;
  let dataOffset = -1;
  let dataLength = 0;
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ') {
      const format = view.getUint16(offset + 8, true);
      const channels = view.getUint16(offset + 10, true);
      const bits = view.getUint16(offset + 22, true);
      if (format !== 1 || channels !== 1 || bits !== 16) throw new Error('expected 16-bit mono PCM');
      sampleRate = view.getUint32(offset + 12, true);
    } else if (id === 'data') {
      dataOffset = offset + 8;
      dataLength = Math.min(size, wav.length - dataOffset);
    }
    offset += 8 + size + (size % 2);
  }
  if (!sampleRate || dataOffset < 0) throw new Error('wav missing fmt or data');
  const samples = new Int16Array(Math.floor(dataLength / 2));
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = view.getInt16(dataOffset + i * 2, true);
  }
  return { samples, sampleRate };
}
