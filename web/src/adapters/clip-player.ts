import type { ExcerptPlayer, ExcerptResult, RecordedTake } from '../../../src/types';

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
export class BrowserClipPlayer implements ExcerptPlayer {
  private readonly urls = new Map<string, string>();
  private stopCurrent?: () => void;

  constructor(private readonly opts: ClipPlayerOptions) {}

  dispose(): void {
    this.stopCurrent?.();
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
  }

  async play(take: RecordedTake, startMs: number, endMs: number): Promise<ExcerptResult> {
    return this.playInternal(take, startMs, endMs, false);
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
        const timer = window.setInterval(() => {
          if (audio.ended || audio.currentTime * 1000 >= endMs) {
            window.clearInterval(timer);
            audio.pause();
            resolve();
          }
        }, 50);
        this.stopCurrent = () => {
          window.clearInterval(timer);
          audio.pause();
          resolve();
        };
      });
    } finally {
      this.stopCurrent = undefined;
      this.opts.duck(false);
    }
    return { played: true, start_ms: startMs, end_ms: endMs };
  }
}
