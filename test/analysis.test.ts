import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatFeedbackNote, mmss, parseFeedbackJson } from '../src/analysis/analyzer';
import type { RehearsalTake } from '../src/types';

const wrapped = (payload: unknown) =>
  ['Here is my analysis:', '```json', JSON.stringify(payload), '```', 'Hope that helps!'].join('\n');

test('parses feedback json wrapped in fences and prose, clamping clips', () => {
  const fb = parseFeedbackJson(
    wrapped({
      assessment: { kind: 'real rehearsal', confidence: 'high', reason: 'sustained take' },
      strength: 'calm authority in the open',
      strengthEvidence: ['steady first minute'],
      strengthClip: { startMs: 2_000, endMs: 6_000, label: 'three things matter today' },
      priority: {
        dimension: 'Clarity of the ask',
        title: 'the ask is hedged',
        whyItMatters: 'the room hears an option, not a request',
        evidence: ['"we might need budget"'],
        clip: { startMs: 130_000, endMs: 999_000, label: 'we might need budget' },
        correction: 'ask plainly, then stop',
        drill: 'say the ask alone, three times',
      },
      suggestedDelivery: 'I am asking for 50k.',
      audioAdvantage: 'volume falls right at the ask',
    }),
    140_000
  );
  assert.equal(fb.assessment.kind, 'real rehearsal');
  assert.equal(fb.strength, 'calm authority in the open');
  assert.equal(fb.priority?.clip?.endMs, 140_000); // clamped to the take
  assert.equal(fb.priority?.clip?.startMs, 130_000);
  assert.equal(fb.suggestedDelivery, 'I am asking for 50k.');
});

test('a non-rehearsal take parses with no priority', () => {
  const fb = parseFeedbackJson(
    JSON.stringify({
      assessment: { kind: 'mic check', confidence: 'high', reason: 'counting and setup chatter' },
      strength: 'the voice came through clearly',
      strengthEvidence: [],
      strengthClip: null,
      priority: null,
      suggestedDelivery: '',
      audioAdvantage: '',
    }),
    9_000
  );
  assert.equal(fb.assessment.kind, 'mic check');
  assert.equal(fb.priority, undefined);
  assert.equal(fb.audioAdvantage, undefined);
});

test('malformed clips are dropped rather than trusted', () => {
  const fb = parseFeedbackJson(
    JSON.stringify({
      assessment: { kind: 'real rehearsal', confidence: 'medium', reason: 'ok' },
      strength: 'clear framing',
      strengthClip: { startMs: 'noon', endMs: 12, label: 'x' },
      priority: {
        title: 'rushing',
        correction: 'slow the close',
        clip: { startMs: 9_000, endMs: 3_000, label: 'backwards' },
      },
      suggestedDelivery: '',
    }),
    60_000
  );
  assert.equal(fb.strengthClip, undefined);
  assert.equal(fb.priority?.clip, undefined);
  assert.equal(fb.priority?.dimension, 'Delivery'); // defaulted, not invented
});

test('rejects a response with no usable strength or json', () => {
  assert.throws(
    () => parseFeedbackJson(JSON.stringify({ assessment: { kind: 'unclear' } }), 1000),
    /no strength/
  );
  assert.throws(() => parseFeedbackJson('no json here at all', 1000), /no JSON/);
});

test('the injected note carries the clip, replay instruction, and take id', () => {
  assert.equal(mmss(134.4), '2:14');
  assert.equal(mmss(0), '0:00');
  const take: RehearsalTake = {
    meeting: { slug: 'q3-board', title: 'Q3 board' },
    takeNumber: 2,
    id: 'q3-board-take-2',
    seconds: 190,
  };
  const note = formatFeedbackNote(take, {
    assessment: { kind: 'real rehearsal', confidence: 'high', reason: 'sustained take' },
    strength: 'calm delivery',
    strengthEvidence: ['steady pacing'],
    priority: {
      dimension: 'Pauses',
      title: 'no room around key points',
      whyItMatters: 'ideas do not land',
      evidence: ['runs through the numbers'],
      clip: { startMs: 61_000, endMs: 66_000, label: 'so basically' },
      correction: 'pause after each number',
      drill: 'read the close with a two-beat pause',
    },
    suggestedDelivery: 'The point is simple.',
  });
  assert.match(note, /take 2, 3:10 long/);
  assert.match(note, /Strength: calm delivery/);
  assert.match(note, /no room around key points \(Pauses\)/);
  assert.match(note, /play_excerpt recording_id "q3-board-take-2" start_ms 61000 end_ms 66000/);
  assert.match(note, /Deliver this as a coach, not a report/);
});

test('a note without a priority tells the coach to invite a real take', () => {
  const take: RehearsalTake = {
    meeting: { slug: 'pitch', title: 'Pitch' },
    takeNumber: 1,
    id: 'pitch-take-1',
    seconds: 8,
  };
  const note = formatFeedbackNote(take, {
    assessment: { kind: 'mic check', confidence: 'high', reason: 'setup chatter' },
    strength: 'clear audio',
    strengthEvidence: [],
    suggestedDelivery: '',
  });
  assert.match(note, /not a real rehearsal/);
  assert.match(note, /invite a real run-through/);
});
