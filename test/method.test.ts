import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildAnalysisPrompt } from '../src/analysis/analyzer';
import { buildInstructions, defaultPersona } from '../src/persona';

// The ears and the mouth share one method: a diagnosis the analyzer names
// must be a word the coach already owns, and the method must never dissolve
// the evidence fence.

test('the listening brief hears through the five instruments and named traps', () => {
  const brief = buildAnalysisPrompt({ meeting: { slug: 'b', title: 'B' }, learnings: [] });
  for (const name of ['Rate', 'Volume', 'Pitch', 'Melody', 'Pause']) {
    assert.match(brief, new RegExp(`- ${name}:`));
  }
  assert.match(brief, /Uptalk/);
  assert.match(brief, /The fade/);
  assert.match(brief, /diagnose it by name and evidence/);
});

test('the persona teaches with the same method, inside the evidence fence', () => {
  const instructions = buildInstructions({
    persona: defaultPersona,
    learnings: [],
    meetingsOnFile: [],
    mode: 'coaching',
  });
  assert.match(instructions, /five instruments/);
  assert.match(instructions, /One instrument at a time/);
  assert.match(instructions, /Contrast is the teacher/);
  // Method adds vocabulary; it never licenses judging sound by ear.
  assert.match(instructions, /only from the specialist's analysis note/);
  assert.match(instructions, /never analyze how a take SOUNDED yourself/);
});
