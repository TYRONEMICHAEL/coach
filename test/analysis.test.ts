import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatFeedbackNote, mmss, parseFeedbackJson } from '../src/analysis/analyzer.js';
import type { RehearsalTake } from '../src/types.js';

test('parses feedback json wrapped in fences and prose', () => {
  const text = [
    'Here is my analysis:',
    '```json',
    JSON.stringify({
      summary: 'Solid open, buried ask.',
      strengths: ['clear framing'],
      improvements: ['state the ask earlier'],
      moments: [
        { at_s: 134.4, quote: 'we might need budget', verdict: 'weak', note: 'hedged', better: 'I am asking for 50k' },
        { at_s: 12, quote: 'three things matter today', verdict: 'strong', note: 'crisp roadmap' },
        { at_s: 'nonsense', quote: '', verdict: 'weak', note: 'dropped' },
      ],
    }),
    '```',
    'Hope that helps!',
  ].join('\n');

  const fb = parseFeedbackJson(text);
  assert.equal(fb.summary, 'Solid open, buried ask.');
  assert.equal(fb.moments.length, 2); // invalid moment dropped
  assert.equal(fb.moments[0]?.at_s, 12); // sorted by time
  assert.equal(fb.moments[1]?.better, 'I am asking for 50k');
});

test('rejects a response with no usable summary', () => {
  assert.throws(() => parseFeedbackJson('{"strengths": []}'), /no summary/);
  assert.throws(() => parseFeedbackJson('no json here at all'), /no JSON/);
});

test('mmss and the injected note carry timestamps and quotes', () => {
  assert.equal(mmss(134.4), '2:14');
  assert.equal(mmss(0), '0:00');
  const take: RehearsalTake = {
    meeting: { slug: 'q3-board', title: 'Q3 board' },
    takeNumber: 2,
    wavPath: '/x/q3-board-take-2.wav',
    seconds: 190,
  };
  const note = formatFeedbackNote(take, {
    summary: 'Better pacing.',
    strengths: ['calm delivery'],
    improvements: ['tighten the close'],
    moments: [{ at_s: 61, quote: 'so basically', verdict: 'weak', note: 'filler open', better: 'The point is' }],
  });
  assert.match(note, /take 2, 3:10 long/);
  assert.match(note, /1:01 weak: "so basically"/);
  assert.match(note, /sharper: "The point is"/);
  assert.match(note, /Deliver this conversationally/);
});
