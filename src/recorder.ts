import * as fs from 'node:fs';
import { BYTES_PER_SECOND, SAMPLE_RATE } from './types.js';

/**
 * Tees the user's mic stream (16-bit mono PCM) to a WAV file between
 * begin/end rehearsal. Only mic audio is written — the coach's speech is
 * never in the file — so analysis timestamps align exactly with the take.
 */
export class PcmRecorder {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private path?: string;

  get active(): boolean {
    return this.path !== undefined;
  }

  get seconds(): number {
    return this.bytes / BYTES_PER_SECOND;
  }

  start(wavPath: string): void {
    if (this.active) throw new Error('recorder already active');
    this.path = wavPath;
    this.chunks = [];
    this.bytes = 0;
  }

  write(frame: Buffer): void {
    if (!this.active) return;
    this.chunks.push(frame);
    this.bytes += frame.length;
  }

  stop(): { path: string; seconds: number; bytes: number } {
    if (!this.path) throw new Error('recorder not active');
    const result = { path: this.path, seconds: this.seconds, bytes: this.bytes };
    writeWav(this.path, Buffer.concat(this.chunks), SAMPLE_RATE);
    this.path = undefined;
    this.chunks = [];
    this.bytes = 0;
    return result;
  }
}

export function writeWav(path: string, pcm: Buffer, sampleRate: number): void {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(path, Buffer.concat([header, pcm]));
}
