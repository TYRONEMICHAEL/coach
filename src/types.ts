// Shared domain types. Everything here is provider-neutral.

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

/** One timestamped observation inside a rehearsal take. */
export interface RehearsalMoment {
  /** Seconds from the start of the recording. */
  at_s: number;
  /** What the user actually said (short quote). */
  quote: string;
  verdict: 'strong' | 'weak';
  /** Why it landed, or why it didn't. */
  note: string;
  /** Suggested sharper phrasing; expected when verdict is weak. */
  better?: string;
}

export interface RehearsalFeedback {
  summary: string;
  strengths: string[];
  improvements: string[];
  moments: RehearsalMoment[];
}

export interface RehearsalTake {
  meeting: MeetingContext;
  takeNumber: number;
  wavPath: string;
  seconds: number;
}
