import type { RecordedTake, TakeRecorder } from './types';
import { BYTES_PER_SECOND, SAMPLE_RATE } from './types';

/**
 * The default take recorder: tees frames of the user's mic (16-bit mono PCM
 * at SAMPLE_RATE) between begin/end rehearsal and finalizes them as WAV
 * bytes. Only mic audio is written — the coach's speech is never in the
 * take — so analysis timestamps align exactly with what the user said.
 *
 * Platform-neutral: persistence is the memory seam's job.
 */
export class PcmTakeRecorder implements TakeRecorder {
  private chunks: Uint8Array[] = [];
  private bytes = 0;
  private id?: string;

  get active(): boolean {
    return this.id !== undefined;
  }

  get seconds(): number {
    return this.bytes / BYTES_PER_SECOND;
  }

  start(id: string): void {
    if (this.active) throw new Error('recorder already active');
    this.id = id;
    this.chunks = [];
    this.bytes = 0;
  }

  write(frame: Uint8Array): void {
    if (!this.active) return;
    this.chunks.push(frame);
    this.bytes += frame.length;
  }

  async stop(): Promise<RecordedTake> {
    if (!this.id) throw new Error('recorder not active');
    const take: RecordedTake = {
      id: this.id,
      seconds: this.seconds,
      wav: pcm16ToWav(concatBytes(this.chunks), SAMPLE_RATE),
      ref: 'unsaved',
    };
    this.id = undefined;
    this.chunks = [];
    this.bytes = 0;
    return take;
  }
}

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}

/** Wrap raw 16-bit mono PCM bytes in a WAV container. */
export function pcm16ToWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const wav = new Uint8Array(44 + pcm.length);
  const view = new DataView(wav.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) wav[offset + i] = text.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, pcm.length, true);
  wav.set(pcm, 44);
  return wav;
}

/** Convert float samples (-1..1) to 16-bit PCM bytes — the browser path. */
export function float32ToPcm16(samples: Float32Array): Uint8Array {
  const pcm = new Uint8Array(samples.length * 2);
  const view = new DataView(pcm.buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return pcm;
}
