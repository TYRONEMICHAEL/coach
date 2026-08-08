import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { SAMPLE_RATE } from '../types.js';

// Mic and speaker via sox's `rec`/`play`, matching the harness audio
// contract (pcm16 mono 24k). This file is the only place that touches real
// audio devices; a browser client would replace it, not the session.

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
  proc.stdout.on('data', (chunk: Buffer) => onFrame(chunk));
  return () => proc.kill('SIGTERM');
}

/** Speaker with barge-in support: stop() drops everything queued. */
export function createSpeaker(): { play: (pcm: Buffer) => void; stop: () => void; close: () => void } {
  let proc: ChildProcess | undefined;

  const ensure = (): ChildProcess => {
    if (!proc || proc.exitCode !== null) {
      proc = spawn('play', [...RAW_ARGS, '-'], { stdio: ['pipe', 'ignore', 'ignore'] });
    }
    return proc;
  };

  return {
    play(pcm: Buffer) {
      ensure().stdin?.write(pcm);
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
