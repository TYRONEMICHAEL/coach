import { float32ToPcm16, pcm16ToWav } from '../../../src/recorder';
import type { RecordedTake, TakeRecorder } from '../../../src/types';
import { SAMPLE_RATE } from '../../../src/types';

const MAX_TAKE_SECONDS = 12 * 60;

// Safari's MP4 recorder must finalize one complete file; periodic fragments
// can replay in an <audio> element yet fail Web Audio decoding. Every rule
// in this file was paid for on a real iPhone.
const RECORDER_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/mp4;codecs=pcm',
  'audio/mp4',
  'audio/webm',
] as const;

export function selectRecordingMimeType(
  isTypeSupported?: (mimeType: string) => boolean
): string | undefined {
  if (!isTypeSupported) return 'audio/mp4';
  return RECORDER_MIME_TYPES.find((candidate) => isTypeSupported(candidate));
}

type ExtendedWindow = Window & {
  webkitAudioContext?: typeof AudioContext;
  webkitOfflineAudioContext?: typeof OfflineAudioContext;
};

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** Decode whatever the browser recorded and resample it to the harness
 * audio contract: 16-bit mono PCM WAV at SAMPLE_RATE. */
export async function blobToWav(blob: Blob): Promise<{ wav: Uint8Array; seconds: number }> {
  const extended = window as ExtendedWindow;
  const AudioContextClass = window.AudioContext || extended.webkitAudioContext;
  const OfflineAudioContextClass = window.OfflineAudioContext || extended.webkitOfflineAudioContext;
  if (!AudioContextClass || !OfflineAudioContextClass) {
    throw new Error('This browser could not prepare the recording.');
  }

  const context = new AudioContextClass();
  let decoded: AudioBuffer;
  try {
    decoded = await withTimeout(
      context.decodeAudioData(await blob.arrayBuffer()),
      30_000,
      'The recording could not be prepared in time. Try another take.'
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes('prepared in time')) throw error;
    throw new Error(
      'The take was recorded, but this browser could not read the audio back. Reload once and try again.'
    );
  } finally {
    await context.close();
  }

  if (decoded.duration > MAX_TAKE_SECONDS) {
    throw new Error('Keep a single take under 12 minutes.');
  }

  const frames = Math.max(1, Math.ceil(decoded.duration * SAMPLE_RATE));
  const offline = new OfflineAudioContextClass(1, frames, SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await withTimeout(
    offline.startRendering(),
    30_000,
    'The recording could not be prepared in time. Try another take.'
  );
  return {
    wav: pcm16ToWav(float32ToPcm16(rendered.getChannelData(0)), SAMPLE_RATE),
    seconds: decoded.duration,
  };
}

/**
 * Seam 3, browser edition. WebRTC owns the live mic transport, so instead
 * of teeing PCM frames this recorder runs MediaRecorder on the same mic
 * stream between begin/end rehearsal, then converts the finalized blob to
 * the canonical WAV. Only the mic is recorded — never the coach's voice.
 */
export class MediaRecorderTake implements TakeRecorder {
  private recorder?: MediaRecorder;
  private chunks: Blob[] = [];
  private id?: string;

  constructor(private readonly getStream: () => MediaStream | null) {}

  get active(): boolean {
    return this.id !== undefined;
  }

  start(id: string): void {
    if (this.active) throw new Error('recorder already active');
    const stream = this.getStream();
    if (!stream) throw new Error('The microphone is not available.');
    if (!('MediaRecorder' in window)) throw new Error('Recording is not supported in this browser.');
    const mimeType = selectRecordingMimeType((type) => MediaRecorder.isTypeSupported(type));
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    this.recorder = recorder;
    this.id = id;
    this.chunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size) this.chunks.push(event.data);
    };
    if (recorder.mimeType.toLowerCase().startsWith('audio/mp4')) recorder.start();
    else recorder.start(250);
  }

  /** The live transport already carries mic audio; nothing to tee here. */
  write(_frame: Uint8Array): void {}

  async stop(): Promise<RecordedTake> {
    const recorder = this.recorder;
    const id = this.id;
    if (!recorder || !id) throw new Error('recorder not active');
    this.recorder = undefined;
    this.id = undefined;

    const blob = await new Promise<Blob>((resolve, reject) => {
      const watchdog = setTimeout(
        () => reject(new Error('The recording did not finalize. Try another take.')),
        10_000
      );
      recorder.onstop = () => {
        clearTimeout(watchdog);
        const joined = new Blob(this.chunks, { type: recorder.mimeType || 'audio/webm' });
        this.chunks = [];
        if (!joined.size) reject(new Error('The recording came back empty. Try another take.'));
        else resolve(joined);
      };
      if (recorder.state === 'inactive') recorder.onstop(new Event('stop'));
      else recorder.stop();
    });

    const { wav, seconds } = await blobToWav(blob);
    return { id, seconds, wav, ref: 'session-only' };
  }
}
