import type { CapabilityResult, CapabilityServices } from './capabilities.js';
import { coachTools, executeTool } from './capabilities.js';
import { formatFeedbackNote } from './analysis/analyzer.js';
import type { RehearsalAnalyzer } from './analysis/analyzer.js';
import type { CoachMemory } from './memory.js';
import { formatDuration } from './memory.js';
import type { Persona } from './persona.js';
import { buildInstructions, defaultPersona } from './persona.js';
import { PcmRecorder } from './recorder.js';
import type { ProviderEvent, RealtimeProvider } from './realtime/provider.js';
import type { MeetingContext, Mode, RehearsalTake } from './types.js';

export interface CoachSessionOptions {
  provider: RealtimeProvider;
  analyzer: RehearsalAnalyzer;
  memory: CoachMemory;
  persona?: Persona;
  voice?: string;
  playAudio?: (pcm: Buffer) => void;
  stopAudio?: () => void;
  onTranscript?: (role: 'user' | 'coach', text: string) => void;
  onStatus?: (line: string) => void;
}

/**
 * The orchestrator. Owns the mode state machine and the rehearsal take
 * lifecycle; everything else is delegated through the three seams
 * (provider, analyzer, memory).
 */
export class CoachSession {
  mode: Mode = 'coaching';
  activeMeeting?: MeetingContext;

  private readonly provider: RealtimeProvider;
  private readonly analyzer: RehearsalAnalyzer;
  private readonly memory: CoachMemory;
  private readonly persona: Persona;
  private readonly recorder = new PcmRecorder();
  private currentTake?: RehearsalTake;
  private pendingAnalyses: Promise<void>[] = [];
  private readonly opts: CoachSessionOptions;

  constructor(opts: CoachSessionOptions) {
    this.opts = opts;
    this.provider = opts.provider;
    this.analyzer = opts.analyzer;
    this.memory = opts.memory;
    this.persona = opts.persona ?? defaultPersona;
  }

  async start(): Promise<void> {
    this.provider.onEvent((e) => this.onProviderEvent(e));
    await this.provider.connect({
      instructions: this.instructions(),
      tools: coachTools(),
      voice: this.opts.voice,
    });
  }

  async stop(): Promise<void> {
    // A take interrupted by shutdown still lands on disk, just unanalyzed.
    if (this.recorder.active) {
      const rec = this.recorder.stop();
      this.status(`rehearsal recording saved unanalyzed: ${rec.path}`);
    }
    await this.provider.close();
  }

  /** Every mic frame flows through here: to the provider always, and into
   * the recorder while a rehearsal is running. */
  sendMicAudio(pcm: Buffer): void {
    this.provider.sendUserAudio(pcm);
    this.recorder.write(pcm);
  }

  /** CLI fallback for when the model misses the handoff out of a rehearsal. */
  endRehearsalManually(): void {
    if (this.mode !== 'rehearsal') return;
    const result = this.endRehearsal();
    if (typeof result.error === 'string') {
      this.status(result.error);
      return;
    }
    this.provider.injectSystemNote(
      `The user manually ended the rehearsal (${String(result.seconds)}s captured); the analysis is running and will arrive as a system note. Acknowledge briefly.`,
      { startResponse: true }
    );
  }

  /** Resolves when all dispatched analyses have settled (tests, shutdown). */
  async settleAnalyses(): Promise<void> {
    await Promise.allSettled(this.pendingAnalyses);
  }

  private onProviderEvent(e: ProviderEvent): void {
    switch (e.type) {
      case 'audio':
        // Hard guarantee: the coach never talks over a run-through. If the
        // model leaks speech mid-rehearsal, it is simply not played.
        if (this.mode !== 'rehearsal') this.opts.playAudio?.(e.pcm);
        break;
      case 'user_speech_started':
        this.opts.stopAudio?.();
        this.provider.interrupt();
        break;
      case 'user_transcript':
        this.opts.onTranscript?.('user', e.text);
        break;
      case 'assistant_transcript':
        this.opts.onTranscript?.('coach', e.text);
        break;
      case 'tool_call':
        void this.handleToolCall(e.callId, e.name, e.args);
        break;
      case 'error':
        this.status(`provider error: ${e.message}`);
        break;
      case 'closed':
        this.status(`provider closed${e.reason ? `: ${e.reason}` : ''}`);
        break;
    }
  }

  private async handleToolCall(
    callId: string,
    name: string,
    args: Record<string, unknown>
  ): Promise<void> {
    const result = await executeTool(name, args, this.services());
    // begin_rehearsal gets no spoken response — silence starts at the tool
    // result, deterministically, not at the model's discretion.
    const startResponse = name !== 'begin_rehearsal';
    this.provider.submitToolResult(callId, result, { startResponse });
  }

  private services(): CapabilityServices {
    return {
      setMeeting: (input) => {
        const meeting = this.memory.upsertMeeting(input);
        this.activeMeeting = meeting;
        this.refreshInstructions();
        this.status(`active meeting: ${meeting.title}`);
        return {
          ok: true,
          meeting: meeting.title,
          notes_on_file: this.memory.meetingNotes(meeting.slug).length,
          rehearsals_so_far: this.memory.rehearsalCount(meeting.slug),
        };
      },
      addMeetingNote: (note) => {
        if (!this.activeMeeting) return { error: 'no active meeting — call set_meeting first' };
        this.memory.addMeetingNote(this.activeMeeting.slug, note);
        return { ok: true };
      },
      remember: (learning) => {
        this.memory.addLearning(learning);
        this.refreshInstructions();
        this.status(`learned: ${learning}`);
        return { ok: true };
      },
      beginRehearsal: () => this.beginRehearsal(),
      endRehearsal: () => this.endRehearsal(),
    };
  }

  private beginRehearsal(): CapabilityResult {
    if (this.mode === 'rehearsal') return { error: 'a rehearsal is already running' };
    if (!this.activeMeeting)
      return {
        error:
          'no active meeting — ask which meeting this run-through is for, call set_meeting, then begin_rehearsal',
      };
    const meeting = this.activeMeeting;
    const takeNumber = this.memory.rehearsalCount(meeting.slug) + 1;
    const wavPath = this.memory.recordingPath(meeting.slug, takeNumber);
    this.recorder.start(wavPath);
    this.currentTake = { meeting, takeNumber, wavPath, seconds: 0 };
    this.mode = 'rehearsal';
    this.status(`recording take ${takeNumber} for "${meeting.title}"`);
    return {
      ok: true,
      recording: true,
      take: takeNumber,
      note: 'Stay completely silent until the user steps out of the run-through, then call end_rehearsal.',
    };
  }

  private endRehearsal(): CapabilityResult {
    if (this.mode !== 'rehearsal' || !this.currentTake) return { error: 'no rehearsal is running' };
    const rec = this.recorder.stop();
    const take: RehearsalTake = { ...this.currentTake, seconds: rec.seconds };
    this.currentTake = undefined;
    this.mode = 'coaching';
    this.status(`captured ${formatDuration(rec.seconds)} — analysis dispatched`);
    this.dispatchAnalysis(take);
    return {
      ok: true,
      seconds: Math.round(rec.seconds),
      status: 'analysis_started',
      note: 'Say one short holding line; the analysis arrives shortly as a system note. Keep the conversation going meanwhile.',
    };
  }

  private dispatchAnalysis(take: RehearsalTake): void {
    const pending = this.analyzer
      .analyze({ wavPath: take.wavPath, meeting: take.meeting, learnings: this.memory.learnings() })
      .then((feedback) => {
        this.memory.addRehearsalFeedback(take, feedback);
        this.provider.injectSystemNote(formatFeedbackNote(take, feedback), { startResponse: true });
        this.status(`analysis ready for take ${take.takeNumber}`);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.provider.injectSystemNote(
          `The rehearsal analysis failed (${message}). Tell the user plainly and offer another take; the recording itself is saved.`,
          { startResponse: true }
        );
        this.status(`analysis failed: ${message}`);
      });
    this.pendingAnalyses.push(pending);
  }

  private instructions(): string {
    return buildInstructions({
      persona: this.persona,
      learnings: this.memory.learnings(),
      meetingsOnFile: this.memory.meetings(),
      activeMeeting: this.activeMeeting,
      activeMeetingNotes: this.activeMeeting
        ? this.memory.meetingNotes(this.activeMeeting.slug)
        : undefined,
      mode: this.mode,
    });
  }

  private refreshInstructions(): void {
    this.provider.updateInstructions(this.instructions());
  }

  private status(line: string): void {
    this.opts.onStatus?.(line);
  }
}
