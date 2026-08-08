import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MemoryProposal } from '../src/gate';
import { decideMemory, matchCount, overlapCount } from '../src/gate';

const base: MemoryProposal = {
  statement: 'tends to bury the ask under context',
  category: 'coaching_pattern',
  source: 'inference',
  confidence: 'medium',
  evidence: 'ask arrived at 4:10 in a 5:00 take',
  sensitive: false,
  user_confirmed: false,
};

test('tests and setup chatter are never memories', () => {
  assert.equal(decideMemory({ ...base, source: 'test_or_setup' }, 5).action, 'ignore');
});

test('sensitive and low-confidence proposals need confirmation', () => {
  assert.equal(decideMemory({ ...base, sensitive: true }, 3).action, 'confirm');
  assert.equal(decideMemory({ ...base, confidence: 'low' }, 3).action, 'confirm');
  assert.equal(decideMemory({ ...base, sensitive: true, user_confirmed: true }, 0).action, 'save');
});

test('explicit statements save; single inferences wait as candidates', () => {
  assert.equal(
    decideMemory({ ...base, source: 'explicit_user_statement', confidence: 'high' }, 0).action,
    'save'
  );
  assert.equal(decideMemory(base, 0).action, 'candidate');
});

test('repetition promotes: prior matches or repeated_pattern save', () => {
  assert.equal(decideMemory(base, 1).action, 'save');
  assert.equal(decideMemory({ ...base, source: 'repeated_pattern' }, 0).action, 'save');
});

test('overlap counts significant words only', () => {
  assert.equal(overlapCount('tends to bury the ask', 'buries the ask in detail'), 0); // short words and differing stems do not count
  assert.equal(overlapCount('leads with context before the point', 'gives context before the point'), 3);
  assert.equal(
    matchCount('states the point before context', [
      '2026-08-08: [coaching_pattern] states context before the point',
      'unrelated line about meetings',
    ]),
    1
  );
});
