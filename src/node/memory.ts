import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderFeedbackMarkdown } from '../analysis/analyzer';
import type { CoachMemory } from '../memory';
import { formatDuration, slugify, today } from '../memory';
import type { MeetingContext, RecordedTake, RehearsalFeedback, RehearsalTake } from '../types';

/**
 * The Node body of CoachMemory: plain markdown under a data directory.
 *   learnings.md            gate-approved durable learnings, one dated line each
 *   candidates.md           inferred-once observations awaiting a repeat
 *   meetings/<slug>.md      per-meeting prep: context, notes, rehearsal feedback
 *   recordings/<take>.wav   rehearsal takes
 */
export class FileCoachMemory implements CoachMemory {
  constructor(readonly dataDir: string) {
    fs.mkdirSync(path.join(dataDir, 'meetings'), { recursive: true });
    fs.mkdirSync(path.join(dataDir, 'recordings'), { recursive: true });
  }

  private get learningsPath() {
    return path.join(this.dataDir, 'learnings.md');
  }

  private get candidatesPath() {
    return path.join(this.dataDir, 'candidates.md');
  }

  private meetingPath(slug: string) {
    return path.join(this.dataDir, 'meetings', `${slug}.md`);
  }

  private readLines(filePath: string): string[] {
    if (!fs.existsSync(filePath)) return [];
    return fs
      .readFileSync(filePath, 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('- '))
      .map((l) => l.slice(2).trim());
  }

  learnings(): string[] {
    return this.readLines(this.learningsPath);
  }

  addLearning(text: string): void {
    fs.appendFileSync(this.learningsPath, `- ${today()}: ${text.trim()}\n`);
  }

  candidates(): string[] {
    return this.readLines(this.candidatesPath);
  }

  addCandidate(text: string): void {
    fs.appendFileSync(this.candidatesPath, `- ${today()}: ${text.trim()}\n`);
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

  addRehearsalFeedback(take: RehearsalTake, feedback: RehearsalFeedback): void {
    const p = this.meetingPath(take.meeting.slug);
    if (!fs.existsSync(p)) throw new Error(`no meeting file for ${take.meeting.slug}`);
    const text = fs.readFileSync(p, 'utf8');
    const header = text.includes('## Rehearsals') ? '' : '\n## Rehearsals\n';
    const block = [
      '',
      `### Take ${take.takeNumber} — ${today()}, ${formatDuration(take.seconds)}`,
      `recording: recordings/${take.id}.wav`,
      '',
      renderFeedbackMarkdown(feedback),
    ].join('\n');
    fs.writeFileSync(p, text.trimEnd() + '\n' + header + block + '\n');
  }

  persistRecording(take: RecordedTake): string {
    const wavPath = path.join(this.dataDir, 'recordings', `${take.id}.wav`);
    fs.writeFileSync(wavPath, take.wav);
    return wavPath;
  }
}
