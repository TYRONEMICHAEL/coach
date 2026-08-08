import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MeetingContext, RehearsalFeedback, RehearsalTake } from './types.js';
import { renderFeedbackMarkdown } from './analysis/analyzer.js';

/**
 * Two kinds of state, deliberately separate, both plain markdown:
 *   learnings.md          durable learnings about the user (cross-session)
 *   meetings/<slug>.md    per-meeting prep: context, notes, rehearsal feedback
 *   recordings/*.wav      rehearsal takes, referenced from the meeting files
 */
export class CoachMemory {
  constructor(readonly dataDir: string) {
    fs.mkdirSync(path.join(dataDir, 'meetings'), { recursive: true });
    fs.mkdirSync(path.join(dataDir, 'recordings'), { recursive: true });
  }

  private get learningsPath() {
    return path.join(this.dataDir, 'learnings.md');
  }

  private meetingPath(slug: string) {
    return path.join(this.dataDir, 'meetings', `${slug}.md`);
  }

  learnings(): string[] {
    if (!fs.existsSync(this.learningsPath)) return [];
    return fs
      .readFileSync(this.learningsPath, 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('- '))
      .map((l) => l.slice(2).trim());
  }

  addLearning(text: string): void {
    fs.appendFileSync(this.learningsPath, `- ${today()}: ${text.trim()}\n`);
  }

  meetings(): MeetingContext[] {
    const dir = path.join(this.dataDir, 'meetings');
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => this.readMeeting(path.basename(f, '.md')))
      .filter((m): m is MeetingContext => m !== undefined);
  }

  readMeeting(slug: string): MeetingContext | undefined {
    const p = this.meetingPath(slug);
    if (!fs.existsSync(p)) return undefined;
    const text = fs.readFileSync(p, 'utf8');
    const title = text.match(/^# (.+)$/m)?.[1]?.trim() ?? slug;
    const when = text.match(/^- when: (.+)$/m)?.[1]?.trim();
    const goal = text.match(/^- goal: (.+)$/m)?.[1]?.trim();
    return { slug, title, when, goal };
  }

  /** Create the meeting file if new; return the canonical context either way. */
  upsertMeeting(input: { title: string; when?: string; goal?: string }): MeetingContext {
    const slug = slugify(input.title);
    const existing = this.readMeeting(slug);
    if (existing) {
      return {
        slug,
        title: existing.title,
        when: input.when ?? existing.when,
        goal: input.goal ?? existing.goal,
      };
    }
    const lines = [
      `# ${input.title}`,
      ...(input.when ? [`- when: ${input.when}`] : []),
      ...(input.goal ? [`- goal: ${input.goal}`] : []),
      '',
      '## Notes',
      '',
    ];
    fs.writeFileSync(this.meetingPath(slug), lines.join('\n'));
    return { slug, title: input.title, when: input.when, goal: input.goal };
  }

  meetingNotes(slug: string): string[] {
    const p = this.meetingPath(slug);
    if (!fs.existsSync(p)) return [];
    const notesSection = fs.readFileSync(p, 'utf8').split(/^## /m).find((s) => s.startsWith('Notes'));
    if (!notesSection) return [];
    return notesSection
      .split('\n')
      .filter((l) => l.startsWith('- '))
      .map((l) => l.slice(2).trim());
  }

  addMeetingNote(slug: string, note: string): void {
    const p = this.meetingPath(slug);
    if (!fs.existsSync(p)) throw new Error(`no meeting file for ${slug}`);
    const text = fs.readFileSync(p, 'utf8');
    const entry = `- ${today()}: ${note.trim()}\n`;
    // Append inside the Notes section: right before the next section, or at the end.
    const notesStart = text.indexOf('## Notes');
    if (notesStart === -1) {
      fs.writeFileSync(p, `${text.trimEnd()}\n\n## Notes\n${entry}`);
      return;
    }
    const nextSection = text.indexOf('\n## ', notesStart + 1);
    if (nextSection === -1) {
      fs.writeFileSync(p, `${text.trimEnd()}\n${entry}`);
    } else {
      fs.writeFileSync(p, text.slice(0, nextSection) + entry + text.slice(nextSection));
    }
  }

  rehearsalCount(slug: string): number {
    const p = this.meetingPath(slug);
    if (!fs.existsSync(p)) return 0;
    return (fs.readFileSync(p, 'utf8').match(/^### Take /gm) ?? []).length;
  }

  recordingPath(slug: string, takeNumber: number): string {
    return path.join(this.dataDir, 'recordings', `${slug}-take-${takeNumber}.wav`);
  }

  addRehearsalFeedback(take: RehearsalTake, feedback: RehearsalFeedback): void {
    const p = this.meetingPath(take.meeting.slug);
    if (!fs.existsSync(p)) throw new Error(`no meeting file for ${take.meeting.slug}`);
    const text = fs.readFileSync(p, 'utf8');
    const header = text.includes('## Rehearsals') ? '' : '\n## Rehearsals\n';
    const block = [
      '',
      `### Take ${take.takeNumber} — ${today()}, ${formatDuration(take.seconds)}`,
      `recording: ${path.relative(this.dataDir, take.wavPath)}`,
      '',
      renderFeedbackMarkdown(feedback),
    ].join('\n');
    fs.writeFileSync(p, text.trimEnd() + '\n' + header + block + '\n');
  }
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

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m${String(s).padStart(2, '0')}s`;
}
