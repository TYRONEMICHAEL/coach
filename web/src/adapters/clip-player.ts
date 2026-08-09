import { pcm16ToWav } from '../../../src/recorder';
import type { ExcerptPlayer, ExcerptResult, RecordedTake } from '../../../src/types';
import { SAMPLE_RATE } from '../../../src/types';

export interface ClipPlayerOptions {
  element: HTMLAudioElement;
  /** Mute the mic + coach while the user's own audio replays. */
  duck: (on: boolean) => void;
  /** Autoplay was blocked: surface a one-tap fallback, retry on tap. */
  onNeedsTap: (retry: () => void) => void;
}

/**
 * Seam 4, browser edition: replays the exact cited moment of a take through
 * an <audio> element. Safari only allows this after a user gesture the
 * first time — the retry closure keeps play() inside the tap's call stack.
 */
/** 50ms of real, valid silence — enough for a user gesture to bless the
 * element. Built with the product's own encoder, not a hand-rolled URI. */
function silentWavUrl(): string {
  const wav = pcm16ToWav(new Uint8Array(Math.round(SAMPLE_RATE * 0.05) * 2), SAMPLE_RATE);
  const bytes = new Uint8Array(wav);
  return URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: 'audio/wav' }));
}

/** Bless any audio element inside a user gesture so later programmatic
 * playback (the coach's voice arriving over WebRTC) never needs a touch. */
export function blessAudioElement(element: HTMLAudioElement): void {
  const url = silentWavUrl();
  element.src = url;
  const attempt = element.play();
  if (attempt) {
    attempt
      .then(() => element.pause())
      .catch(() => undefined)
      .finally(() => URL.revokeObjectURL(url));
  }
}

/** Soft earcons for eyes-free state changes: a rising pair when recording
 * starts, a falling pair when it stops — the Voice Memos convention. */
function cueWavUrl(kind: 'start' | 'stop'): string {
  const noteMs = 90;
  const gapMs = 30;
  const total = Math.round((SAMPLE_RATE * (noteMs * 2 + gapMs)) / 1000);
  const pcm = new Uint8Array(total * 2);
  const view = new DataView(pcm.buffer);
  const freqs = kind === 'start' ? [660, 990] : [990, 660];
  for (let i = 0; i < total; i += 1) {
    const ms = (i / SAMPLE_RATE) * 1000;
    const inSecond = ms > noteMs + gapMs;
    const inFirst = ms < noteMs;
    if (!inFirst && !inSecond) continue;
    const noteT = inFirst ? ms / 1000 : (ms - noteMs - gapMs) / 1000;
    const freq = inFirst ? freqs[0]! : freqs[1]!;
    const envelope = Math.sin(Math.PI * Math.min(1, (noteT * 1000) / noteMs));
    view.setInt16(i * 2, Math.round(Math.sin(2 * Math.PI * freq * noteT) * envelope * 0.16 * 0x7fff), true);
  }
  const wav = pcm16ToWav(pcm, SAMPLE_RATE);
  const bytes = new Uint8Array(wav);
  return URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: 'audio/wav' }));
}

const cueUrls: { start?: string; stop?: string } = {};

/** Play a state-change cue through a blessed element. */
export function playCue(element: HTMLAudioElement, kind: 'start' | 'stop'): void {
  cueUrls[kind] = cueUrls[kind] ?? cueWavUrl(kind);
  element.src = cueUrls[kind]!;
  void element.play().catch(() => undefined);
}

export class BrowserClipPlayer implements ExcerptPlayer {
  private readonly urls = new Map<string, string>();
  private stopCurrent?: () => void;
  private unlocked = false;

  constructor(private readonly opts: ClipPlayerOptions) {}

  /**
   * Call synchronously inside a real user tap (Begin). Playing a sliver of
   * silence blesses the element, so every later programmatic play() — the
   * coach rolling tape mid-conversation — needs no touch at all.
   */
  unlock(): void {
    if (this.unlocked) return;
    const audio = this.opts.element;
    const url = silentWavUrl();
    audio.src = url;
    const attempt = audio.play();
    if (attempt) {
      attempt
        .then(() => {
          this.unlocked = true;
          audio.pause();
        })
        .catch(() => undefined)
        .finally(() => URL.revokeObjectURL(url));
    }
  }

  dispose(): void {
    this.stopCurrent?.();
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
  }

  async play(take: RecordedTake, startMs: number, endMs: number): Promise<ExcerptResult> {
    return this.playInternal(take, startMs, endMs, false);
  }

  /** Load the take into the element ahead of time — metadata ready means
   * replay starts the moment the coach offers it. */
  prime(take: RecordedTake): void {
    const audio = this.opts.element;
    const url = this.urlFor(take);
    if (audio.src !== url) {
      audio.src = url;
      audio.load();
    }
  }

  private urlFor(take: RecordedTake): string {
    let url = this.urls.get(take.id);
    if (!url) {
      const bytes = new Uint8Array(take.wav);
      url = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: 'audio/wav' }));
      this.urls.set(take.id, url);
    }
    return url;
  }

  private async playInternal(
    take: RecordedTake,
    startMs: number,
    endMs: number,
    fromUserGesture: boolean
  ): Promise<ExcerptResult> {
    const audio = this.opts.element;
    const url = this.urlFor(take);
    this.stopCurrent?.();

    if (audio.src !== url) {
      audio.src = url;
      audio.load();
    }
    const targetSeconds = startMs / 1000;
    try {
      let playPromise: Promise<void>;
      if (fromUserGesture && audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
        // Keep play() synchronous with the user's tap.
        audio.currentTime = targetSeconds;
        playPromise = audio.play();
      } else {
        if (audio.readyState < HTMLMediaElement.HAVE_METADATA) {
          await new Promise<void>((resolve, reject) => {
            const timeout = window.setTimeout(() => reject(new Error('The excerpt did not finish loading.')), 5_000);
            const ready = () => {
              window.clearTimeout(timeout);
              audio.removeEventListener('error', failed);
              resolve();
            };
            const failed = () => {
              window.clearTimeout(timeout);
              audio.removeEventListener('loadedmetadata', ready);
              reject(new Error('The excerpt could not be loaded.'));
            };
            audio.addEventListener('loadedmetadata', ready, { once: true });
            audio.addEventListener('error', failed, { once: true });
          });
        }
        if (Math.abs(audio.currentTime - targetSeconds) > 0.05) {
          await new Promise<void>((resolve) => {
            const timeout = window.setTimeout(resolve, 2_000);
            audio.addEventListener(
              'seeked',
              () => {
                window.clearTimeout(timeout);
                resolve();
              },
              { once: true }
            );
            audio.currentTime = targetSeconds;
          });
        }
        playPromise = audio.play();
      }
      await playPromise;
    } catch {
      this.opts.onNeedsTap(() => {
        void this.playInternal(take, startMs, endMs, true);
      });
      return {
        played: false,
        requires_user_tap: true,
        reason: 'The browser requires one tap before replaying recorded audio; a Play button is on screen.',
      };
    }

    this.opts.duck(true);
    try {
      await new Promise<void>((resolve) => {
        // iOS can stall the element's clock mid-playback; without a hard
        // cap this wait never ends and the mic never comes back. The
        // excerpt's own length plus headroom is the longest it can take.
        const watchdog = window.setTimeout(() => finish(), endMs - startMs + 3_000);
        // iOS also pauses the element transiently while switching audio
        // routes at replay start. A pause is NOT the end — resume it, up
        // to three times, before giving up.
        let resumes = 0;
        const timer = window.setInterval(() => {
          if (audio.ended || audio.currentTime * 1000 >= endMs) {
            finish();
            return;
          }
          if (audio.paused) {
            if (resumes < 3) {
              resumes += 1;
              void audio.play().catch(() => finish());
            } else {
              finish();
            }
          }
        }, 120);
        const finish = () => {
          window.clearInterval(timer);
          window.clearTimeout(watchdog);
          audio.pause();
          resolve();
        };
        this.stopCurrent = finish;
      });
    } finally {
      this.stopCurrent = undefined;
      this.opts.duck(false);
    }
    return { played: true, start_ms: startMs, end_ms: endMs };
  }
}
