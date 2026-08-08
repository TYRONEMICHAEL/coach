import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import type { ExcerptPlayer, ExcerptResult, RecordedTake } from '../types';
import { SAMPLE_RATE } from '../types';

// Mic and speaker via sox's `rec`/`play`, matching the harness audio
// contract (pcm16 mono 24k). This file is the only place that touches real
// audio devices; the browser body replaces it, not the session.

const RAW_ARGS = ['-q', '-r', String(SAMPLE_RATE), '-c', '1', '-b', '16', '-e', 'signed-integer', '-t', 'raw'];

export function assertSoxInstalled(): void {
  const probe = spawnSync('sox', ['--version'], { stdio: 'ignore' });
  if (probe.error) {
    throw new Error('sox is required for mic/speaker audio — install with `brew install sox`');
  }
}

/** Start capturing the mic; frames arrive as raw pcm16 buffers. */
export function startMic(onFrame: (pcm: Buffer) => void): () => void {
  const proc = spawn('rec', [...RAW_ARGS, '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
  proc.on('error', () => {});
  proc.stdout.on('data', (chunk: Buffer) => onFrame(chunk));
  return () => proc.kill('SIGTERM');
}

/** Speaker with barge-in support: stop() drops everything queued. */
export function createSpeaker(): { play: (pcm: Uint8Array) => void; stop: () => void; close: () => void } {
  let proc: ChildProcess | undefined;

  const ensure = (): ChildProcess => {
    if (!proc || proc.exitCode !== null || proc.killed) {
      proc = spawn('play', [...RAW_ARGS, '-'], { stdio: ['pipe', 'ignore', 'ignore'] });
      proc.on('error', () => {});
      // stop() kills the process to flush its buffer, so late writes racing
      // the kill hit a dead stdin — EPIPE here is expected, never fatal.
      proc.stdin?.on('error', () => {});
    }
    return proc;
  };

  return {
    play(pcm: Uint8Array) {
      const stdin = ensure().stdin;
      if (stdin?.writable) stdin.write(pcm);
    },
    // Killing the process is the only reliable way to flush sox's buffer;
    // the next play() respawns it.
    stop() {
      proc?.kill('SIGKILL');
      proc = undefined;
    },
    close() {
      proc?.stdin?.end();
      proc?.kill('SIGTERM');
      proc = undefined;
    },
  };
}

/**
 * Excerpt replay through the speakers: sox plays the persisted take file,
 * trimmed to the cited moment. The Mac's answer to the browser's clip
 * player — same seam, same product moment.
 */
export class SoxExcerptPlayer implements ExcerptPlayer {
  private current?: ChildProcess;

  play(take: RecordedTake, startMs: number, endMs: number): Promise<ExcerptResult> {
    if (!take.ref || take.ref === 'unsaved' || take.ref === 'session-only') {
      return Promise.resolve({ played: false, reason: 'The take audio is not on disk to replay.' });
    }
    // One excerpt at a time; a new request supersedes a still-playing one.
    this.current?.kill('SIGKILL');
    const start = (startMs / 1000).toFixed(2);
    const duration = Math.max(0.25, (endMs - startMs) / 1000).toFixed(2);
    return new Promise((resolve) => {
      const proc = spawn('play', ['-q', take.ref, 'trim', start, duration], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      this.current = proc;
      proc.on('error', () =>
        resolve({ played: false, reason: 'The excerpt could not be played on this machine.' })
      );
      proc.on('exit', (code) => {
        if (this.current === proc) this.current = undefined;
        resolve(
          code === 0
            ? { played: true, start_ms: startMs, end_ms: endMs }
            : { played: false, reason: 'Excerpt playback stopped early.' }
        );
      });
    });
  }
}
