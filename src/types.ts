// Shared domain types. Everything here is platform-neutral: no Node, no DOM.

/** Audio contract across the whole harness: 16-bit signed PCM, mono. */
export const SAMPLE_RATE = 24_000;
export const BYTES_PER_SECOND = SAMPLE_RATE * 2;

/** The coach is always in exactly one mode. */
export type Mode = 'coaching' | 'rehearsal';

export interface MeetingContext {
  slug: string;
  title: string;
  /** Free text — "Tuesday 10am", "2026-08-12". */
  when?: string;
  /** What the user wants out of the meeting. */
  goal?: string;
}

/** A finished take: canonical analyzable audio plus where it persists. */
export interface RecordedTake {
  /** Harness-issued id, e.g. "q3-board-review-take-2". */
  id: string;
  seconds: number;
  /** Complete 16-bit mono PCM WAV at SAMPLE_RATE. */
  wav: Uint8Array;
  /** Human-facing location: a file path, an object URL, or "session-only". */
  ref: string;
}

/** One rehearsal in flight or completed, tied to its meeting. */
export interface RehearsalTake {
  meeting: MeetingContext;
  takeNumber: number;
  /** Recording id (see RecordedTake.id). */
  id: string;
  seconds: number;
}

/**
 * Seam 3: take capture. The session decides WHEN recording happens; the
 * recorder owns HOW audio is captured on its platform. The CLI tees mic PCM
 * frames through write(); a browser recorder captures independently and may
 * ignore write() entirely.
 */
export interface TakeRecorder {
  readonly active: boolean;
  start(id: string): void;
  /** Tee one frame of user mic audio. No-op when inactive or unsupported. */
  write(frame: Uint8Array): void;
  /** Finalize the take. Rejects only when no take is active. */
  stop(): Promise<RecordedTake>;
}

export interface ExcerptResult {
  played: boolean;
  start_ms?: number;
  end_ms?: number;
  /** Browsers may require one user tap before replaying audio. */
  requires_user_tap?: boolean;
  reason?: string;
}

/**
 * Seam 4: excerpt replay — the validated moment of the product. Plays a
 * precise slice of the user's own take back to them.
 */
export interface ExcerptPlayer {
  play(take: RecordedTake, startMs: number, endMs: number): Promise<ExcerptResult>;
}

/** A moment the analyzer can prove: a replayable slice of the take. */
export interface EvidenceClip {
  startMs: number;
  endMs: number;
  /** What to listen for; opens with the clip's first words when possible. */
  label: string;
}

export type TakeKind = 'real rehearsal' | 'warm-up' | 'mic check' | 'unclear';

export interface TakeAssessment {
  kind: TakeKind;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

/** The one highest-leverage improvement, grounded in the audio. */
export interface RehearsalPriority {
  /** e.g. "Pace", "Vocal authority", "Pauses", "Confidence". */
  dimension: string;
  title: string;
  whyItMatters: string;
  evidence: string[];
  clip?: EvidenceClip;
  /** One behavior to change on the next take. */
  correction: string;
  /** One practice drill under a minute. */
  drill: string;
}

/**
 * Rehearsal feedback, shaped by the product's coaching philosophy:
 * one strength worth keeping, one priority worth fixing, everything
 * anchored in audio the user can replay. Never a report.
 */
export interface RehearsalFeedback {
  assessment: TakeAssessment;
  strength: string;
  strengthEvidence: string[];
  strengthClip?: EvidenceClip;
  /** Absent when the take was not a real rehearsal. */
  priority?: RehearsalPriority;
  /** A faithful sharper delivery using only the speaker's own content. */
  suggestedDelivery: string;
  /** One observation possible only from audio, when there is one. */
  audioAdvantage?: string;
}
