import type { CapabilityResult, CapabilityServices } from './capabilities';
import { coachTools, executeTool } from './capabilities';
import { formatFeedbackNote } from './analysis/analyzer';
import type { RehearsalAnalyzer } from './analysis/analyzer';
import type { MemoryProposal } from './gate';
import { decideMemory, matchCount } from './gate';
import type { CoachMemory } from './memory';
import { formatDuration, takeId } from './memory';
import type { Persona } from './persona';
import { buildInstructions, defaultPersona } from './persona';
import type { ProviderEvent, RealtimeProvider } from './realtime/provider';
import type {
  CaptureState,
  ExcerptPlayer,
  ExcerptResult,
  MeetingContext,
  Mode,
  RecordedTake,
  RehearsalTake,
  TakeRecorder,
} from './types';

export interface CoachSessionOptions {
  provider: RealtimeProvider;
  analyzer: RehearsalAnalyzer;
  memory: CoachMemory;
  recorder: TakeRecorder;
  player?: ExcerptPlayer;
  persona?: Persona;
  voice?: string;
  /** Injected once after connect (startResponse) so the coach speaks first,
   * in character, using what memory already holds. */
  greeting?: string;
  playAudio?: (pcm: Uint8Array) => void;
  stopAudio?: () => void;
  onTranscript?: (role: 'user' | 'coach', text: string) => void;
  onStatus?: (line: string) => void;
  /** Fired on every coaching/rehearsal transition — bodies use it to mute
   * the coach's audio path deterministically during a take. */
  onModeChange?: (mode: Mode) => void;
  /** The take lifecycle state machine: recording -> finalizing ->
   * analyzing -> idle. UIs render these instead of inventing transitions,
   * so there is never an unrepresented gap. */
  onCaptureChange?: (state: CaptureState) => void;
  /** Analysis lifecycle, for UI state ("listening back…"). */
  onAnalysis?: (state: 'started' | 'ready' | 'failed', takeNumber: number) => void;
}

/**
 * The orchestrator. Owns the mode state machine, the take lifecycle, and
 * the memory gate; everything else is delegated through the seams
 * (provider, analyzer, memory, recorder, player).
 */
export class CoachSession {
  mode: Mode = 'coaching';
  capture: CaptureState = 'idle';
  activeMeeting?: MeetingContext;

  private readonly provider: RealtimeProvider;
  private readonly analyzer: RehearsalAnalyzer;
  private readonly memory: CoachMemory;
  private readonly recorder: TakeRecorder;
  private readonly player?: ExcerptPlayer;
  private readonly persona: Persona;
  private currentTake?: Omit<RehearsalTake, 'seconds'>;
  private readonly takes = new Map<string, RecordedTake>();
  private lastTakeId?: string;
  private pendingAnalyses: Promise<void>[] = [];
  private readonly opts: CoachSessionOptions;

  constructor(opts: CoachSessionOptions) {
    this.opts = opts;
    this.provider = opts.provider;
    this.analyzer = opts.analyzer;
    this.memory = opts.memory;
    this.recorder = opts.recorder;
    this.player = opts.player;
    this.persona = opts.persona ?? defaultPersona;
  }

  async start(): Promise<void> {
    this.provider.onEvent((e) => this.onProviderEvent(e));
    await this.provider.connect({
      instructions: this.instructions(),
      tools: coachTools(),
      voice: this.opts.voice,
    });
    if (this.opts.greeting) {
      this.provider.injectSystemNote(this.opts.greeting, { startResponse: true });
    }
  }

  async stop(): Promise<void> {
    // A take interrupted by shutdown still lands in memory, just unanalyzed.
    if (this.recorder.active) {
      const rec = await this.recorder.stop();
      rec.ref = this.memory.persistRecording(rec);
      this.status(`rehearsal recording saved unanalyzed: ${rec.ref}`);
    }
    this.setCapture('idle');
    await this.provider.close();
  }

  /** Every mic frame flows through here: to the provider always, and into
   * the recorder while a rehearsal is running. */
  sendMicAudio(pcm: Uint8Array): void {
    this.provider.sendUserAudio(pcm);
    this.recorder.write(pcm);
  }

  /** Fallback for when the model misses the handoff out of a rehearsal
   * (the CLI's Enter key, a browser button). */
  endRehearsalManually(): void {
    if (this.mode !== 'rehearsal') return;
    void Promise.resolve(this.endRehearsal()).then((result) => {
      if (typeof result.error === 'string') {
        this.status(result.error);
        return;
      }
      this.provider.injectSystemNote(
        `The user manually ended the rehearsal (${String(result.seconds)}s captured); the analysis is running and will arrive as a system note. Acknowledge briefly.`,
        { startResponse: true }
      );
    });
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
      remember: (proposal) => this.remember(proposal),
      beginRehearsal: () => this.beginRehearsal(),
      endRehearsal: () => this.endRehearsal(),
      playExcerpt: (input) => this.playExcerpt(input),
    };
  }

  /** The gate decides; the model only proposes. */
  private remember(proposal: MemoryProposal): CapabilityResult {
    const priorMatches = matchCount(proposal.statement, [
      ...this.memory.learnings(),
      ...this.memory.candidates(),
    ]);
    const decision = decideMemory(proposal, priorMatches);
    if (decision.action === 'save') {
      this.memory.addLearning(`[${proposal.category}] ${proposal.statement}`);
      this.refreshInstructions();
      this.status(`learned: ${proposal.statement}`);
    } else if (decision.action === 'candidate') {
      this.memory.addCandidate(`[${proposal.category}] ${proposal.statement}`);
      this.status(`memory candidate held: ${proposal.statement}`);
    } else {
      this.status(`memory ${decision.action}: ${proposal.statement}`);
    }
    return { action: decision.action, reason: decision.reason, statement: proposal.statement };
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
    const id = takeId(meeting.slug, takeNumber);
    this.recorder.start(id);
    this.currentTake = { meeting, takeNumber, id };
    this.setMode('rehearsal');
    this.setCapture('recording');
    this.status(`recording take ${takeNumber} for "${meeting.title}"`);
    return {
      ok: true,
      recording: true,
      take: takeNumber,
      recording_id: id,
      note: 'Stay completely silent until the user steps out of the run-through, then call end_rehearsal.',
    };
  }

  private async endRehearsal(): Promise<CapabilityResult> {
    if (this.mode !== 'rehearsal' || !this.currentTake) return { error: 'no rehearsal is running' };
    const pending = this.currentTake;
    this.currentTake = undefined;
    // The conversation returns to the coach immediately; the capture state
    // keeps telling the truth about the audio until it is safely finalized.
    this.setMode('coaching');
    this.setCapture('finalizing');
    let recorded: RecordedTake;
    try {
      recorded = await this.recorder.stop();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setCapture('idle');
      this.status(`take capture failed: ${message}`);
      return {
        error: `The recording could not be finalized (${message}). Tell the user plainly and offer another take.`,
      };
    }
    recorded.ref = this.memory.persistRecording(recorded);
    this.takes.set(recorded.id, recorded);
    this.lastTakeId = recorded.id;
    const take: RehearsalTake = { ...pending, seconds: recorded.seconds };
    this.setCapture('analyzing');
    this.status(`captured ${formatDuration(recorded.seconds)} — analysis dispatched`);
    this.dispatchAnalysis(take, recorded);
    return {
      ok: true,
      seconds: Math.round(recorded.seconds),
      recording_id: recorded.id,
      status: 'analysis_started',
      note: 'Say one short holding line; the analysis arrives shortly as a system note. Keep the conversation going meanwhile.',
    };
  }

  private async playExcerpt(input: {
    recordingId?: string;
    startMs: number;
    endMs: number;
  }): Promise<ExcerptResult> {
    if (!this.player) return { played: false, reason: 'Excerpt replay is not available in this environment.' };
    const id = input.recordingId ?? this.lastTakeId;
    const take = id ? this.takes.get(id) : undefined;
    if (!take) return { played: false, reason: 'That take is no longer available to replay.' };
    const startMs = Math.max(0, Math.round(input.startMs));
    const durationMs = Math.round(take.seconds * 1000);
    const endMs = Math.min(Math.max(Math.round(input.endMs), startMs + 250), Math.max(durationMs, startMs + 250));
    this.status(`replaying ${take.id} ${startMs}–${endMs}ms`);
    return this.player.play(take, startMs, endMs);
  }

  private dispatchAnalysis(take: RehearsalTake, recorded: RecordedTake): void {
    this.opts.onAnalysis?.('started', take.takeNumber);
    const pending = this.analyzer
      .analyze({
        wav: recorded.wav,
        durationMs: Math.round(recorded.seconds * 1000),
        meeting: take.meeting,
        learnings: this.memory.learnings(),
      })
      .then((feedback) => {
        this.memory.addRehearsalFeedback(take, feedback);
        this.provider.injectSystemNote(formatFeedbackNote(take, feedback), { startResponse: true });
        this.setCapture('idle');
        this.status(`analysis ready for take ${take.takeNumber}`);
        this.opts.onAnalysis?.('ready', take.takeNumber);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.provider.injectSystemNote(
          `The rehearsal analysis failed (${message}). Tell the user plainly and offer another take; the recording itself is saved.`,
          { startResponse: true }
        );
        this.setCapture('idle');
        this.status(`analysis failed: ${message}`);
        this.opts.onAnalysis?.('failed', take.takeNumber);
      });
    this.pendingAnalyses.push(pending);
  }

  private setMode(mode: Mode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.opts.onModeChange?.(mode);
  }

  private setCapture(state: CaptureState): void {
    if (this.capture === state) return;
    this.capture = state;
    this.opts.onCaptureChange?.(state);
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
