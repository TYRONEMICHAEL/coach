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
  TakeLifecycleRecord,
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
  /** How long after a take ends before the MODEL may begin another
   * (misfire guard). The user's manual start always bypasses. */
  beginCooldownMs?: number;
  /** Waits between automatic analysis retries; length = extra attempts.
   * Default two retries (2s, 5s). Empty array = single attempt. */
  analysisRetryDelaysMs?: number[];
  /** Fired whenever any take's lifecycle changes — the UI's history. */
  onTakesChange?: (takes: TakeLifecycleRecord[]) => void;
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
  private records: TakeLifecycleRecord[] = [];
  private lastTakeId?: string;
  private lastTakeEndedAt = 0;
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
      if (result.status === 'discarded') return;
      this.provider.injectSystemNote(
        `The user manually ended the rehearsal (${String(result.seconds)}s captured); the analysis is running and will arrive as a system note. Acknowledge briefly.`,
        { startResponse: true }
      );
    });
  }

  /** The user's own start button: take boundaries belong to the human when
   * they want them. Bypasses the post-take cooldown — a person pressing
   * start IS the ground truth the cooldown approximates. */
  beginRehearsalManually(): void {
    if (this.mode === 'rehearsal') return;
    this.opts.stopAudio?.();
    this.provider.interrupt();
    const result = this.beginRehearsal({ manual: true });
    if (typeof result.error === 'string') {
      this.provider.injectSystemNote(
        `The user pressed "Start a take" but it could not begin: ${result.error}. Resolve this in one short question.`,
        { startResponse: true }
      );
      return;
    }
    this.provider.injectSystemNote(
      'The user manually started a rehearsal take; recording is running now. Total silence until they step out or press done.',
      { startResponse: false }
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
    // If the model speaks and begins a rehearsal in the same breath, the
    // recording would chop its sentence mid-word. Cut cleanly instead:
    // cancel any in-flight speech before the take starts.
    if (name === 'begin_rehearsal') {
      this.opts.stopAudio?.();
      this.provider.interrupt();
    }
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
      retryAnalysis: (recordingId) => this.retryAnalysis(recordingId),
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

  private beginRehearsal(opts?: { manual?: boolean }): CapabilityResult {
    if (this.mode === 'rehearsal') return { error: 'a rehearsal is already running' };
    // A take that just ended is usually followed by conversation, not a new
    // take — a begin call seconds later is almost always a misfire. The
    // user's own start button bypasses this.
    if (!opts?.manual && Date.now() - this.lastTakeEndedAt < (this.opts.beginCooldownMs ?? 5_000)) {
      return {
        error:
          'a take ended moments ago — do not begin another unless the user has clearly started presenting again; never call begin_rehearsal to recover from confusion',
      };
    }
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
      this.lastTakeEndedAt = Date.now();
      this.status(`take capture failed: ${message}`);
      return {
        error: `The recording could not be finalized (${message}). Tell the user plainly and offer another take.`,
      };
    }
    this.lastTakeEndedAt = Date.now();
    // A sub-2-second "take" is a boundary misfire, not a rehearsal — never
    // analyze it, never let it become the take the user is judged on.
    if (recorded.seconds < 2) {
      this.setCapture('idle');
      this.status(`discarded a ${recorded.seconds.toFixed(1)}s fragment — not a real take`);
      return {
        status: 'discarded',
        seconds: Math.round(recorded.seconds * 10) / 10,
        note: 'The recording was under two seconds — a boundary mistake, not a take. It was discarded and not analyzed. Do not start another recording unless the user clearly begins presenting; if unsure, ask.',
      };
    }
    recorded.ref = this.memory.persistRecording(recorded);
    this.takes.set(recorded.id, recorded);
    this.lastTakeId = recorded.id;
    // Warm the replay path now: when the coach offers the moment, the
    // audio is already loaded and seekable.
    this.player?.prime?.(recorded);
    const take: RehearsalTake = { ...pending, seconds: recorded.seconds };
    this.records.unshift({
      id: recorded.id,
      takeNumber: take.takeNumber,
      meeting: take.meeting,
      seconds: recorded.seconds,
      status: 'analyzing',
      attempt: 1,
    });
    this.emitTakes();
    this.setCapture('analyzing');
    this.status(`captured ${formatDuration(recorded.seconds)} — analysis dispatched`);
    this.dispatchAnalysis(take, recorded);
    return {
      ok: true,
      seconds: Math.round(recorded.seconds),
      recording_id: recorded.id,
      status: 'analysis_started',
      note: 'Say one short holding line; the analysis arrives shortly as a system note. Do not evaluate the take yourself while waiting — you have no reliable read on it until the note lands.',
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
    let requestedStart = input.startMs;
    let requestedEnd = input.endMs;
    // Realtime models sometimes pass seconds where milliseconds belong,
    // which replays a sliver from the start of the take. An end value at or
    // below the take's length in SECONDS is unambiguous: rescale.
    if (requestedEnd > requestedStart && requestedEnd <= take.seconds + 1) {
      requestedStart *= 1000;
      requestedEnd *= 1000;
      this.status('play_excerpt received seconds — rescaled to milliseconds');
    }
    let startMs = Math.max(0, Math.round(requestedStart));
    let endMs = Math.round(requestedEnd);
    const durationMs = Math.round(take.seconds * 1000);
    // A moment shorter than ~3s is inaudible as evidence: expand the
    // window around the request, then clamp inside the take.
    endMs = Math.max(endMs, startMs + 3_000);
    if (endMs > durationMs) {
      endMs = durationMs;
      startMs = Math.max(0, Math.min(startMs, endMs - 3_000));
    }
    endMs = Math.max(endMs, startMs + 250);
    this.status(`replaying ${take.id} ${startMs}–${endMs}ms`);
    return this.player.play(take, startMs, endMs);
  }

  private dispatchAnalysis(take: RehearsalTake, recorded: RecordedTake): void {
    this.opts.onAnalysis?.('started', take.takeNumber);
    this.pendingAnalyses.push(this.runAnalysis(take, recorded));
  }

  /** Analyze with automatic retries: transient failures should cost the
   * user nothing. Only a final failure reaches the conversation — with the
   * retry paths named. */
  private async runAnalysis(take: RehearsalTake, recorded: RecordedTake): Promise<void> {
    const delays = this.opts.analysisRetryDelaysMs ?? [2_000, 5_000];
    const attempts = delays.length + 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const feedback = await this.analyzer.analyze({
          wav: recorded.wav,
          durationMs: Math.round(recorded.seconds * 1000),
          meeting: take.meeting,
          learnings: this.memory.learnings(),
          takeNumber: take.takeNumber,
          // Read before this take's feedback lands: the previous take's read.
          previousSummary: this.memory.lastRehearsalSummary(take.meeting.slug),
        });
        this.memory.addRehearsalFeedback(take, feedback);
        // Continuity lands immediately: "where we left off" is true within
        // the same session, not just the next one.
        this.refreshInstructions();
        this.updateRecord(recorded.id, { status: 'ready', feedback, error: undefined });
        this.provider.injectSystemNote(formatFeedbackNote(take, feedback), { startResponse: true });
        this.setCapture('idle');
        this.status(`analysis ready for take ${take.takeNumber}`);
        this.opts.onAnalysis?.('ready', take.takeNumber);
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (attempt < attempts) {
          this.status(`analysis attempt ${attempt} failed (${message}) — retrying`);
          this.updateRecord(recorded.id, { attempt: attempt + 1, error: message });
          await sleep(delays[attempt - 1] ?? 0);
          continue;
        }
        this.updateRecord(recorded.id, { status: 'failed', error: message });
        this.provider.injectSystemNote(
          `The rehearsal analysis failed after ${attempts} attempts (${message}). The recording itself is safe. Tell the user plainly, in one sentence. You can call retry_analysis to send it again when they want, and a retry control is also on their screen.`,
          { startResponse: true }
        );
        this.setCapture('idle');
        this.status(`analysis failed: ${message}`);
        this.opts.onAnalysis?.('failed', take.takeNumber);
      }
    }
  }

  /** Re-send a captured take whose analysis failed — callable by the model
   * (retry_analysis) and by the user from the takes list. */
  retryAnalysis(recordingId?: string): CapabilityResult {
    const record = recordingId
      ? this.records.find((r) => r.id === recordingId)
      : this.records.find((r) => r.status === 'failed');
    if (!record) return { error: recordingId ? `no take ${recordingId}` : 'no failed take to retry' };
    if (record.status === 'analyzing') return { error: 'that take is already being analyzed' };
    const recorded = this.takes.get(record.id);
    if (!recorded) return { error: 'that take is no longer available in this session' };
    this.updateRecord(record.id, { status: 'analyzing', attempt: record.attempt + 1, error: undefined });
    this.setCapture('analyzing');
    this.status(`re-sending take ${record.takeNumber} for analysis`);
    this.dispatchAnalysis(
      { meeting: record.meeting, takeNumber: record.takeNumber, id: record.id, seconds: record.seconds },
      recorded
    );
    return { ok: true, status: 'analysis_restarted', take: record.takeNumber };
  }

  private updateRecord(id: string, patch: Partial<TakeLifecycleRecord>): void {
    const record = this.records.find((r) => r.id === id);
    if (!record) return;
    Object.assign(record, patch);
    this.emitTakes();
  }

  private emitTakes(): void {
    this.opts.onTakesChange?.(this.records.map((r) => ({ ...r })));
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
    const meetingsOnFile = this.memory.meetings();
    return buildInstructions({
      persona: this.persona,
      learnings: this.memory.learnings(),
      meetingsOnFile,
      lastReads: meetingsOnFile
        .map((m) => ({ title: m.title, summary: this.memory.lastRehearsalSummary(m.slug) }))
        .filter((entry): entry is { title: string; summary: string } => Boolean(entry.summary)),
      activeMeeting: this.activeMeeting,
      activeMeetingNotes: this.activeMeeting
        ? this.memory.meetingNotes(this.activeMeeting.slug)
        : undefined,
      activeMeetingLastRead: this.activeMeeting
        ? this.memory.lastRehearsalSummary(this.activeMeeting.slug)
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

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}
