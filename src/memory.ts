import type { MeetingContext, RecordedTake, RehearsalFeedback, RehearsalTake } from './types';

/**
 * Seam 5: durable memory. Two kinds of state, deliberately separate:
 *
 *   learnings    durable, gate-approved facts about the user (cross-session)
 *   candidates   inferred once, not yet durable; a repeat promotes them
 *   meetings     per-meeting prep: context, notes, rehearsal feedback
 *   recordings   rehearsal takes, referenced from the meeting records
 *
 * The Node body keeps all of it as plain markdown files you can read and
 * edit; the browser body keeps the same shapes in local storage.
 */
export interface CoachMemory {
  learnings(): string[];
  addLearning(text: string): void;

  candidates(): string[];
  addCandidate(text: string): void;

  meetings(): MeetingContext[];
  readMeeting(slug: string): MeetingContext | undefined;
  /** Create the meeting if new; return the canonical context either way. */
  upsertMeeting(input: { title: string; when?: string; goal?: string }): MeetingContext;
  meetingNotes(slug: string): string[];
  addMeetingNote(slug: string, note: string): void;

  rehearsalCount(slug: string): number;
  addRehearsalFeedback(take: RehearsalTake, feedback: RehearsalFeedback): void;
  /** Compact one-line read of the meeting's most recent analyzed take —
   * what coaching continuity is built from. Undefined before any take. */
  lastRehearsalSummary(slug: string): string | undefined;

  /**
   * Persist a finished take's audio where this platform keeps artifacts.
   * Returns a human-facing ref (file path, URL) or "session-only" when the
   * platform intentionally does not retain audio.
   */
  persistRecording(take: RecordedTake): string;
}

export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'untitled'
  );
}

export function takeId(slug: string, takeNumber: number): string {
  return `${slug}-take-${takeNumber}`;
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m${String(s).padStart(2, '0')}s`;
}
