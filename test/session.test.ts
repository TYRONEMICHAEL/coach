import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import type { AnalyzeRequest } from '../src/analysis/analyzer';
import { FileCoachMemory } from '../src/node/memory';
import { PcmTakeRecorder } from '../src/recorder';
import { MockRealtimeProvider } from '../src/realtime/mock';
import { CoachSession } from '../src/session';
import type { ExcerptPlayer, ExcerptResult, RecordedTake, RehearsalFeedback } from '../src/types';
import { BYTES_PER_SECOND } from '../src/types';

const FEEDBACK: RehearsalFeedback = {
  assessment: { kind: 'real rehearsal', confidence: 'high', reason: 'sustained take with intent' },
  strength: 'confident open',
  strengthEvidence: ['crisp first sentence'],
  priority: {
    dimension: 'Clarity of the ask',
    title: 'the ask arrived late and hedged',
    whyItMatters: 'the room decides before you ask',
    evidence: ['"maybe we could discuss budget"'],
    clip: { startMs: 74_000, endMs: 78_500, label: 'maybe we could discuss budget' },
    correction: 'state the ask in the first minute',
    drill: 'say the ask alone, three times, no preamble',
  },
  suggestedDelivery: 'I need a decision on 50k today.',
  audioAdvantage: 'voice drops at the ask',
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

class FakePlayer implements ExcerptPlayer {
  calls: Array<{ id: string; startMs: number; endMs: number }> = [];
  async play(take: RecordedTake, startMs: number, endMs: number): Promise<ExcerptResult> {
    this.calls.push({ id: take.id, startMs, endMs });
    return { played: true, start_ms: startMs, end_ms: endMs };
  }
}

function makeSession() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-session-'));
  const provider = new MockRealtimeProvider();
  const analyzer = new FakeAnalyzer();
  const memory = new FileCoachMemory(dataDir);
  const player = new FakePlayer();
  const played: Uint8Array[] = [];
  const statuses: string[] = [];
  const modes: string[] = [];
  const captures: string[] = [];
  const session = new CoachSession({
    provider,
    analyzer,
    memory,
    recorder: new PcmTakeRecorder(),
    player,
    playAudio: (pcm) => played.push(pcm),
    onStatus: (line) => statuses.push(line),
    onModeChange: (mode) => modes.push(mode),
    onCaptureChange: (state) => captures.push(state),
  });
  return { session, provider, analyzer, memory, player, dataDir, played, statuses, modes, captures };
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

const proposal = (over: Record<string, unknown> = {}) => ({
  statement: 'tends to bury the ask',
  category: 'coaching_pattern',
  source: 'inference',
  confidence: 'medium',
  evidence: 'the ask arrived after the summary in take 1',
  sensitive: false,
  user_confirmed: false,
  ...over,
});

test('connect sends persona, memory, and the six tools', async () => {
  const { session, provider } = makeSession();
  await session.start();
  assert.ok(provider.config);
  assert.equal(provider.config.tools.length, 6);
  assert.match(provider.config.instructions, /You are Marguerite/);
  assert.match(provider.config.instructions, /begin_rehearsal/);
  assert.match(provider.config.instructions, /play_excerpt/);
  assert.match(provider.config.instructions, /\(none yet\)/);
});

test('the full rehearsal loop: detect, record, analyze, debrief, persist, replay', async () => {
  const { session, provider, analyzer, memory, player, played, modes, captures } = makeSession();
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
  session.sendMicAudio(new Uint8Array(1000).fill(1));
  assert.equal(provider.sentAudioBytes, 1000);

  const began = await callTool(provider, 'c3', 'begin_rehearsal');
  assert.equal(began.output.recording, true);
  assert.equal(began.output.recording_id, 'q3-board-review-take-1');
  assert.equal(began.startResponse, false); // silence starts deterministically
  assert.equal(session.mode, 'rehearsal');
  assert.deepEqual(modes, ['rehearsal']);

  // During the rehearsal: mic frames are teed, coach audio is muted.
  session.sendMicAudio(new Uint8Array(BYTES_PER_SECOND).fill(2)); // 1s
  session.sendMicAudio(new Uint8Array(BYTES_PER_SECOND / 2).fill(3)); // 0.5s
  provider.emit({ type: 'audio', pcm: new Uint8Array(10) });
  assert.equal(played.length, 0);

  const ended = await callTool(provider, 'c4', 'end_rehearsal');
  assert.equal(ended.output.status, 'analysis_started');
  assert.equal(ended.output.recording_id, 'q3-board-review-take-1');
  assert.equal(ended.startResponse, true);
  assert.equal(session.mode, 'coaching');
  assert.deepEqual(modes, ['rehearsal', 'coaching']);

  await session.settleAnalyses();

  // The capture state machine represented every phase of the take's life —
  // no unrepresented gap between "stopped talking" and "take safe on disk".
  assert.deepEqual(captures, ['recording', 'finalizing', 'analyzing', 'idle']);

  // The analyzer got the take plus context.
  assert.equal(analyzer.requests.length, 1);
  assert.equal(analyzer.requests[0]?.meeting.slug, 'q3-board-review');
  assert.equal(analyzer.requests[0]?.durationMs, 1500);
  assert.equal(analyzer.requests[0]?.wav.length, 44 + BYTES_PER_SECOND * 1.5); // header + only rehearsal frames

  // The recording landed on disk.
  const wavPath = path.join(memory.dataDir, 'recordings', 'q3-board-review-take-1.wav');
  assert.ok(fs.existsSync(wavPath));

  // Feedback came back into the conversation with the replayable clip.
  const note = provider.systemNotes.find((n) => n.text.includes('Rehearsal analysis ready'));
  assert.ok(note);
  assert.match(note.text, /Strength: confident open/);
  assert.match(note.text, /the ask arrived late and hedged/);
  assert.match(note.text, /start_ms 74000 end_ms 78500/);
  assert.match(note.text, /offer to play the moment/i);
  assert.equal(note.startResponse, true);

  // And onto disk, under the meeting.
  const meetingFile = fs.readFileSync(
    path.join(memory.dataDir, 'meetings', 'q3-board-review.md'),
    'utf8'
  );
  assert.match(meetingFile, /## Rehearsals/);
  assert.match(meetingFile, /### Take 1 — \d{4}-\d{2}-\d{2}, 0m02s/);
  assert.match(meetingFile, /correction: state the ask in the first minute/);

  // The model replays the cited moment; end is clamped to the take length.
  const replay = await callTool(provider, 'c5', 'play_excerpt', {
    recording_id: 'q3-board-review-take-1',
    start_ms: 1000,
    end_ms: 99_000,
  });
  assert.equal(replay.output.played, true);
  assert.deepEqual(player.calls, [{ id: 'q3-board-review-take-1', startMs: 1000, endMs: 1500 }]);

  // Omitting the id replays the latest take.
  const replayLatest = await callTool(provider, 'c6', 'play_excerpt', { start_ms: 0, end_ms: 400 });
  assert.equal(replayLatest.output.played, true);
  assert.equal(player.calls.length, 2);
});

test('coach audio plays in coaching mode and mutes during rehearsal', async () => {
  const { session, provider, played } = makeSession();
  await session.start();
  provider.emit({ type: 'audio', pcm: new Uint8Array(4) });
  assert.equal(played.length, 1);

  await callTool(provider, 'c1', 'set_meeting', { title: 'Standup' });
  await callTool(provider, 'c2', 'begin_rehearsal');
  provider.emit({ type: 'audio', pcm: new Uint8Array(4) });
  assert.equal(played.length, 1); // muted while recording
});

test('the memory gate decides: save, candidate, promote, confirm, ignore', async () => {
  const { session, provider, memory } = makeSession();
  await session.start();

  // Explicit statements save directly.
  const explicit = await callTool(provider, 'm1', 'remember', proposal({
    statement: 'prefers openers under thirty seconds',
    source: 'explicit_user_statement',
    confidence: 'high',
  }));
  assert.equal(explicit.output.action, 'save');
  assert.match(fs.readFileSync(path.join(memory.dataDir, 'learnings.md'), 'utf8'), /openers under thirty seconds/);
  assert.match(provider.instructionUpdates.at(-1)!, /openers under thirty seconds/);

  // A first inference is only a candidate — held aside, not a learning.
  const first = await callTool(provider, 'm2', 'remember', proposal());
  assert.equal(first.output.action, 'candidate');
  assert.match(fs.readFileSync(path.join(memory.dataDir, 'candidates.md'), 'utf8'), /bury the ask/);
  assert.ok(!fs.readFileSync(path.join(memory.dataDir, 'learnings.md'), 'utf8').includes('bury the ask'));

  // The same pattern observed again is promoted to a durable learning.
  const second = await callTool(provider, 'm3', 'remember', proposal({
    statement: 'tends to bury the ask under context',
  }));
  assert.equal(second.output.action, 'save');
  assert.match(fs.readFileSync(path.join(memory.dataDir, 'learnings.md'), 'utf8'), /bury the ask under context/);

  // Sensitive or low-confidence proposals come back asking for confirmation.
  const sensitive = await callTool(provider, 'm4', 'remember', proposal({
    statement: 'is anxious about the CFO relationship',
    sensitive: true,
  }));
  assert.equal(sensitive.output.action, 'confirm');
  const lowConfidence = await callTool(provider, 'm5', 'remember', proposal({
    statement: 'probably dislikes small talk',
    confidence: 'low',
  }));
  assert.equal(lowConfidence.output.action, 'confirm');

  // Confirmed sensitive statements save.
  const confirmed = await callTool(provider, 'm6', 'remember', proposal({
    statement: 'is anxious about the CFO relationship',
    sensitive: true,
    user_confirmed: true,
  }));
  assert.equal(confirmed.output.action, 'save');

  // Setup chatter is ignored entirely.
  const ignored = await callTool(provider, 'm7', 'remember', proposal({
    statement: 'testing one two three',
    source: 'test_or_setup',
  }));
  assert.equal(ignored.output.action, 'ignore');
  assert.ok(!fs.readFileSync(path.join(memory.dataDir, 'learnings.md'), 'utf8').includes('testing one two three'));
});

test('meeting notes write files and refresh instructions', async () => {
  const { session, provider, memory } = makeSession();
  await session.start();

  const noNote = await callTool(provider, 'c1', 'meeting_note', { note: 'CFO cares about runway' });
  assert.match(String(noNote.output.error), /set_meeting/);

  await callTool(provider, 'c2', 'set_meeting', { title: 'CFO sync', when: 'Tuesday' });
  await callTool(provider, 'c3', 'meeting_note', { note: 'CFO cares about runway' });

  assert.deepEqual(memory.meetingNotes('cfo-sync').map((n) => n.split(': ')[1]), ['CFO cares about runway']);
  assert.match(provider.instructionUpdates.at(-1)!, /CFO sync/);

  // Unknown tools come back as recoverable errors, never throws.
  const unknown = await callTool(provider, 'c4', 'divine_the_future');
  assert.match(String(unknown.output.error), /unknown tool/);
});

test('a failed analysis is reported into the conversation, recording kept', async () => {
  const { session, provider, analyzer, memory } = makeSession();
  analyzer.failWith = 'analyzer http 500';
  await session.start();
  await callTool(provider, 'c1', 'set_meeting', { title: 'Pitch' });
  await callTool(provider, 'c2', 'begin_rehearsal');
  session.sendMicAudio(new Uint8Array(BYTES_PER_SECOND));
  await callTool(provider, 'c3', 'end_rehearsal');
  await session.settleAnalyses();

  const note = provider.systemNotes.find((n) => n.text.includes('analysis failed'));
  assert.ok(note);
  assert.match(note.text, /analyzer http 500/);
  assert.match(note.text, /recording itself is saved/);
  assert.ok(fs.existsSync(path.join(memory.dataDir, 'recordings', 'pitch-take-1.wav')));
});

test('manual end works when the model misses the handoff', async () => {
  const { session, provider } = makeSession();
  await session.start();

  session.endRehearsalManually(); // no-op outside a rehearsal
  await tick();
  assert.equal(provider.systemNotes.length, 0);

  await callTool(provider, 'c1', 'set_meeting', { title: 'Town hall' });
  await callTool(provider, 'c2', 'begin_rehearsal');
  session.sendMicAudio(new Uint8Array(BYTES_PER_SECOND));
  session.endRehearsalManually();
  await tick();
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
    memory: new FileCoachMemory(fs.mkdtempSync(path.join(os.tmpdir(), 'coach-barge-'))),
    recorder: new PcmTakeRecorder(),
    stopAudio: () => stopped++,
  });
  await s.start();
  provider.emit({ type: 'user_speech_started' });
  assert.equal(stopped, 1);
  assert.equal(provider.interrupts, 1);
});
