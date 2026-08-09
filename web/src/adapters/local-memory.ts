import { renderFeedbackMarkdown, summarizeFeedback } from '../../../src/analysis/analyzer';
import type { CoachMemory } from '../../../src/memory';
import { formatDuration, slugify, today } from '../../../src/memory';
import type { MeetingContext, RecordedTake, RehearsalFeedback, RehearsalTake } from '../../../src/types';

export interface StoredMeeting extends MeetingContext {
  notes: string[];
  rehearsals: Array<{ take: number; date: string; duration: string; markdown: string; summary?: string }>;
}

interface Store {
  learnings: string[];
  candidates: string[];
  meetings: Record<string, StoredMeeting>;
}

const KEY = 'coach.memory.v1';
export const MEMORY_EVENT = 'coach-memory-changed';

const empty = (): Store => ({ learnings: [], candidates: [], meetings: {} });

/**
 * Seam 5, browser edition: the same memory shapes the CLI keeps as markdown
 * files, held in localStorage. Recordings are deliberately session-only in
 * the browser — audio never persists past the tab.
 */
export class LocalCoachMemory implements CoachMemory {
  private read(): Store {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(KEY) || 'null');
      if (
        parsed &&
        Array.isArray(parsed.learnings) &&
        Array.isArray(parsed.candidates) &&
        typeof parsed.meetings === 'object'
      ) {
        return parsed as Store;
      }
    } catch {
      // fall through to empty
    }
    return empty();
  }

  private write(store: Store): void {
    window.localStorage.setItem(KEY, JSON.stringify(store));
    window.dispatchEvent(new CustomEvent(MEMORY_EVENT));
  }

  snapshot(): Store {
    return this.read();
  }

  learnings(): string[] {
    return this.read().learnings;
  }

  addLearning(text: string): void {
    const store = this.read();
    store.learnings.push(`${today()}: ${text.trim()}`);
    this.write(store);
  }

  candidates(): string[] {
    return this.read().candidates;
  }

  addCandidate(text: string): void {
    const store = this.read();
    store.candidates.push(`${today()}: ${text.trim()}`);
    this.write(store);
  }

  meetings(): MeetingContext[] {
    return Object.values(this.read().meetings).map(({ slug, title, when, goal }) => ({
      slug,
      title,
      when,
      goal,
    }));
  }

  readMeeting(slug: string): MeetingContext | undefined {
    const meeting = this.read().meetings[slug];
    if (!meeting) return undefined;
    return { slug, title: meeting.title, when: meeting.when, goal: meeting.goal };
  }

  upsertMeeting(input: { title: string; when?: string; goal?: string }): MeetingContext {
    const slug = slugify(input.title);
    const store = this.read();
    const existing = store.meetings[slug];
    if (existing) {
      existing.when = input.when ?? existing.when;
      existing.goal = input.goal ?? existing.goal;
      this.write(store);
      return { slug, title: existing.title, when: existing.when, goal: existing.goal };
    }
    store.meetings[slug] = {
      slug,
      title: input.title,
      when: input.when,
      goal: input.goal,
      notes: [],
      rehearsals: [],
    };
    this.write(store);
    return { slug, title: input.title, when: input.when, goal: input.goal };
  }

  meetingNotes(slug: string): string[] {
    return this.read().meetings[slug]?.notes ?? [];
  }

  addMeetingNote(slug: string, note: string): void {
    const store = this.read();
    const meeting = store.meetings[slug];
    if (!meeting) throw new Error(`no meeting record for ${slug}`);
    meeting.notes.push(`${today()}: ${note.trim()}`);
    this.write(store);
  }

  rehearsalCount(slug: string): number {
    return this.read().meetings[slug]?.rehearsals.length ?? 0;
  }

  addRehearsalFeedback(take: RehearsalTake, feedback: RehearsalFeedback): void {
    const store = this.read();
    const meeting = store.meetings[take.meeting.slug];
    if (!meeting) throw new Error(`no meeting record for ${take.meeting.slug}`);
    meeting.rehearsals.push({
      take: take.takeNumber,
      date: today(),
      duration: formatDuration(take.seconds),
      markdown: renderFeedbackMarkdown(feedback),
      summary: summarizeFeedback(feedback),
    });
    this.write(store);
  }

  lastRehearsalSummary(slug: string): string | undefined {
    return this.read().meetings[slug]?.rehearsals.at(-1)?.summary;
  }

  /** Browser takes are session-only by design. */
  persistRecording(_take: RecordedTake): string {
    return 'session-only';
  }
}
