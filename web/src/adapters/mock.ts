import type { AnalyzeRequest, RehearsalAnalyzer } from '../../../src/analysis/analyzer';
import { concatBytes, pcm16ToWav } from '../../../src/recorder';
import type {
  ProviderEvent,
  RealtimeProvider,
  RealtimeSessionConfig,
} from '../../../src/realtime/provider';
import type { RecordedTake, RehearsalFeedback, TakeRecorder } from '../../../src/types';
import { SAMPLE_RATE } from '../../../src/types';

/**
 * Demo mode (?mock=1): the full harness loop with no API keys — the same
 * CoachSession, gate, recorder, and clip player as the real thing, driven
 * by a scripted provider instead of OpenAI. With mic permission the take
 * records and replays your actual voice.
 */
export class ScriptedProvider implements RealtimeProvider {
  config?: RealtimeSessionConfig;
  private handler: (event: ProviderEvent) => void = () => {};
  private callSeq = 0;

  constructor(
    private readonly hooks: {
      onCoachLine: (text: string) => void;
      onNote: (text: string) => void;
      onToolResult: (name: string, output: Record<string, unknown>) => void;
    }
  ) {}

  private lastCallName = new Map<string, string>();

  async connect(config: RealtimeSessionConfig): Promise<void> {
    this.config = config;
  }

  async close(): Promise<void> {}

  sendUserAudio(_pcm: Uint8Array): void {}

  updateInstructions(_instructions: string): void {}

  submitToolResult(callId: string, output: Record<string, unknown>): void {
    this.hooks.onToolResult(this.lastCallName.get(callId) ?? callId, output);
  }

  injectSystemNote(text: string): void {
    this.hooks.onNote(text);
  }

  interrupt(): void {}

  onEvent(handler: (event: ProviderEvent) => void): void {
    this.handler = handler;
  }

  /** The demo panel speaks for the model. */
  coachSays(text: string): void {
    this.hooks.onCoachLine(text);
    this.handler({ type: 'assistant_transcript', text });
  }

  userSays(text: string): void {
    this.handler({ type: 'user_transcript', text });
  }

  callTool(name: string, args: Record<string, unknown> = {}): void {
    const callId = `demo-${(this.callSeq += 1)}`;
    this.lastCallName.set(callId, name);
    this.handler({ type: 'tool_call', callId, name, args });
  }
}

/** Canned feedback with clips placed inside the real take's duration. */
export class MockAnalyzer implements RehearsalAnalyzer {
  constructor(private readonly onResult: (feedback: RehearsalFeedback) => void) {}

  async analyze(request: AnalyzeRequest): Promise<RehearsalFeedback> {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const durationMs = Math.max(1_000, request.durationMs);
    const clipStart = Math.round(durationMs * 0.15);
    const clipEnd = Math.min(durationMs, clipStart + 4_000);
    const feedback: RehearsalFeedback = {
      assessment: {
        kind: 'real rehearsal',
        confidence: 'high',
        reason: 'A sustained attempt with a complete idea (demo assessment).',
      },
      strength: 'You sound most convincing when you state the point plainly.',
      strengthEvidence: ['the steady opening of this take'],
      priority: {
        dimension: 'Clarity of the ask',
        title: 'the explanation arrives before the point',
        whyItMatters: 'the room decides while you are still explaining',
        evidence: ['the cited moment below'],
        clip: { startMs: clipStart, endMs: clipEnd, label: 'listen to how the take opens' },
        correction: 'lead with the conclusion, then give the mechanics',
        drill: 'say only the conclusion sentence, three times, no preamble',
      },
      suggestedDelivery: 'The point is simple. Here is the one reason it matters.',
      audioAdvantage: 'demo mode: this feedback is canned, but the clip is your real audio',
    };
    this.onResult(feedback);
    return feedback;
  }
}

/** When the mic is unavailable, takes become a two-tone chirp so replay is
 * still audible end to end. */
export class SyntheticTakeRecorder implements TakeRecorder {
  private id?: string;
  private startedAt = 0;

  get active(): boolean {
    return this.id !== undefined;
  }

  start(id: string): void {
    if (this.active) throw new Error('recorder already active');
    this.id = id;
    this.startedAt = performance.now();
  }

  write(_frame: Uint8Array): void {}

  async stop(): Promise<RecordedTake> {
    if (!this.id) throw new Error('recorder not active');
    const id = this.id;
    this.id = undefined;
    const seconds = Math.min(20, Math.max(3, (performance.now() - this.startedAt) / 1000));
    const frames = Math.round(seconds * SAMPLE_RATE);
    const chunks: Uint8Array[] = [];
    const chunk = new Uint8Array(frames * 2);
    const view = new DataView(chunk.buffer);
    for (let i = 0; i < frames; i += 1) {
      const t = i / SAMPLE_RATE;
      const freq = t % 2 < 1 ? 392 : 523.25; // G4 / C5 alternating
      const envelope = 0.22 * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.5 * t));
      view.setInt16(i * 2, Math.round(Math.sin(2 * Math.PI * freq * t) * envelope * 0x7fff), true);
    }
    chunks.push(chunk);
    return { id, seconds, wav: pcm16ToWav(concatBytes(chunks), SAMPLE_RATE), ref: 'session-only' };
  }
}
