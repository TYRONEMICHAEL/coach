import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import type { AnalyzeRequest } from '../src/analysis/analyzer.js';
import { CoachMemory } from '../src/memory.js';
import { MockRealtimeProvider } from '../src/realtime/mock.js';
import { CoachSession } from '../src/session.js';
import type { RehearsalFeedback } from '../src/types.js';

const FEEDBACK: RehearsalFeedback = {
  summary: 'Clear structure, ask arrived late.',
  strengths: ['confident open'],
  improvements: ['lead with the ask'],
  moments: [
    { at_s: 5, quote: 'three results this quarter', verdict: 'strong', note: 'crisp' },
    { at_s: 74, quote: 'maybe we could discuss budget', verdict: 'weak', note: 'hedged ask', better: 'I need a decision on 50k today' },
  ],
};

class FakeAnalyzer {
  requests: AnalyzeRequest[] = [];
  failWith?: string;
  async analyze(request: AnalyzeRequest): Promise<RehearsalFeedback> {
    this.requests.push(request);
    if (this.failWith) throw new Error(this.failWith);
    return FEEDBACK;
  }
}

function makeSession() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-session-'));
  const provider = new MockRealtimeProvider();
  const analyzer = new FakeAnalyzer();
  const memory = new CoachMemory(dataDir);
  const played: Buffer[] = [];
  const statuses: string[] = [];
  const session = new CoachSession({
    provider,
    analyzer,
    memory,
    playAudio: (pcm) => played.push(pcm),
    onStatus: (line) => statuses.push(line),
  });
  return { session, provider, analyzer, memory, dataDir, played, statuses };
}

/** Let the async tool-call dispatch settle. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function callTool(
  provider: MockRealtimeProvider,
  callId: string,
  name: string,
  args: Record<string, unknown> = {}
) {
  provider.emit({ type: 'tool_call', callId, name, args });
  await tick();
  const result = provider.toolResults.find((r) => r.callId === callId);
  assert.ok(result, `no tool result for ${callId}`);
  return result;
}

test('connect sends persona, memory, and the five tools', async () => {
  const { session, provider } = makeSession();
  await session.start();
  assert.ok(provider.config);
  assert.equal(provider.config.tools.length, 5);
  assert.match(provider.config.instructions, /You are Coach/);
  assert.match(provider.config.instructions, /begin_rehearsal/);
  assert.match(provider.config.instructions, /\(none yet\)/);
});

test('the full rehearsal loop: detect, record, analyze, debrief, persist', async () => {
  const { session, provider, analyzer, memory, played } = makeSession();
  await session.start();

  // Rehearsing without a meeting is refused with a recovery path.
  const refused = await callTool(provider, 'c1', 'begin_rehearsal');
  assert.match(String(refused.output.error), /set_meeting/);

  const set = await callTool(provider, 'c2', 'set_meeting', {
    title: 'Q3 board review',
    goal: 'approve the hiring plan',
  });
  assert.equal(set.output.ok, true);
  assert.equal(session.activeMeeting?.slug, 'q3-board-review');
  assert.equal(provider.instructionUpdates.length, 1);
  assert.match(provider.instructionUpdates[0]!, /Active meeting/);

  // Mic frames flow to the provider; nothing recorded yet.
  session.sendMicAudio(Buffer.alloc(1000, 1));
  assert.equal(provider.sentAudioBytes, 1000);

  const began = await callTool(provider, 'c3', 'begin_rehearsal');
  assert.equal(began.output.recording, true);
  assert.equal(began.startResponse, false); // silence starts deterministically
  assert.equal(session.mode, 'rehearsal');

  // During the rehearsal: mic frames are teed, coach audio is muted.
  session.sendMicAudio(Buffer.alloc(48_000, 2)); // 1s
  session.sendMicAudio(Buffer.alloc(24_000, 3)); // 0.5s
  provider.emit({ type: 'audio', pcm: Buffer.alloc(10) });
  assert.equal(played.length, 0);

  const ended = await callTool(provider, 'c4', 'end_rehearsal');
  assert.equal(ended.output.status, 'analysis_started');
  assert.equal(ended.startResponse, true);
  assert.equal(session.mode, 'coaching');

  await session.settleAnalyses();

  // The analyzer got the take plus context.
  assert.equal(analyzer.requests.length, 1);
  assert.equal(analyzer.requests[0]?.meeting.slug, 'q3-board-review');
  const wav = fs.readFileSync(analyzer.requests[0]!.wavPath);
  assert.equal(wav.length, 44 + 72_000); // header + only the rehearsal frames

  // Feedback came back into the conversation, timestamped and quoted.
  const note = provider.systemNotes.find((n) => n.text.includes('Rehearsal analysis ready'));
  assert.ok(note);
  assert.match(note.text, /1:14 weak: "maybe we could discuss budget"/);
  assert.match(note.text, /I need a decision on 50k today/);
  assert.equal(note.startResponse, true);

  // And onto disk, under the meeting.
  const meetingFile = fs.readFileSync(
    path.join(memory.dataDir, 'meetings', 'q3-board-review.md'),
    'utf8'
  );
  assert.match(meetingFile, /## Rehearsals/);
  assert.match(meetingFile, /### Take 1 — \d{4}-\d{2}-\d{2}, 0m02s/);
  assert.match(meetingFile, /try: "I need a decision on 50k today"/);
});

test('coach audio plays in coaching mode and mutes during rehearsal', async () => {
  const { session, provider, played } = makeSession();
  await session.start();
  provider.emit({ type: 'audio', pcm: Buffer.alloc(4) });
  assert.equal(played.length, 1);

  await callTool(provider, 'c1', 'set_meeting', { title: 'Standup' });
  await callTool(provider, 'c2', 'begin_rehearsal');
  provider.emit({ type: 'audio', pcm: Buffer.alloc(4) });
  assert.equal(played.length, 1); // muted while recording
});

test('memory tools write files and refresh instructions', async () => {
  const { session, provider, memory, dataDir } = makeSession();
  await session.start();

  const noNote = await callTool(provider, 'c1', 'meeting_note', { note: 'CFO cares about runway' });
  assert.match(String(noNote.output.error), /set_meeting/);

  await callTool(provider, 'c2', 'set_meeting', { title: 'CFO sync', when: 'Tuesday' });
  await callTool(provider, 'c3', 'meeting_note', { note: 'CFO cares about runway' });
  await callTool(provider, 'c4', 'remember', { learning: 'tends to bury the ask' });

  assert.deepEqual(memory.meetingNotes('cfo-sync').map((n) => n.split(': ')[1]), ['CFO cares about runway']);
  assert.match(fs.readFileSync(path.join(dataDir, 'learnings.md'), 'utf8'), /tends to bury the ask/);
  const lastInstructions = provider.instructionUpdates.at(-1)!;
  assert.match(lastInstructions, /tends to bury the ask/);
  assert.match(lastInstructions, /CFO cares about runway/);

  // Unknown tools come back as recoverable errors, never throws.
  const unknown = await callTool(provider, 'c5', 'divine_the_future');
  assert.match(String(unknown.output.error), /unknown tool/);
});

test('a failed analysis is reported into the conversation, recording kept', async () => {
  const { session, provider, analyzer } = makeSession();
  analyzer.failWith = 'analyzer http 500';
  await session.start();
  await callTool(provider, 'c1', 'set_meeting', { title: 'Pitch' });
  await callTool(provider, 'c2', 'begin_rehearsal');
  session.sendMicAudio(Buffer.alloc(48_000));
  await callTool(provider, 'c3', 'end_rehearsal');
  await session.settleAnalyses();

  const note = provider.systemNotes.find((n) => n.text.includes('analysis failed'));
  assert.ok(note);
  assert.match(note.text, /analyzer http 500/);
  assert.match(note.text, /recording itself is saved/);
});

test('manual end works when the model misses the handoff', async () => {
  const { session, provider } = makeSession();
  await session.start();

  session.endRehearsalManually(); // no-op outside a rehearsal
  assert.equal(provider.systemNotes.length, 0);

  await callTool(provider, 'c1', 'set_meeting', { title: 'Town hall' });
  await callTool(provider, 'c2', 'begin_rehearsal');
  session.sendMicAudio(Buffer.alloc(48_000));
  session.endRehearsalManually();
  assert.equal(session.mode, 'coaching');
  const note = provider.systemNotes.find((n) => n.text.includes('manually ended'));
  assert.ok(note);
  await session.settleAnalyses();
});

test('barge-in stops playback and interrupts the provider', async () => {
  const provider = new MockRealtimeProvider();
  let stopped = 0;
  const s = new CoachSession({
    provider,
    analyzer: new FakeAnalyzer(),
    memory: new CoachMemory(fs.mkdtempSync(path.join(os.tmpdir(), 'coach-barge-'))),
    stopAudio: () => stopped++,
  });
  await s.start();
  provider.emit({ type: 'user_speech_started' });
  assert.equal(stopped, 1);
  assert.equal(provider.interrupts, 1);
});
