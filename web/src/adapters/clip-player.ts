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
        const timer = window.setInterval(() => {
          if (audio.ended || audio.paused || audio.currentTime * 1000 >= endMs) finish();
        }, 50);
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
