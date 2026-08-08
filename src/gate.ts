// The memory gate: the model proposes, the harness decides. Deterministic,
// so what the coach "learns" is a policy you can read and test — not a
// model's whim. Ported from the validated Room Read browser harness.

export type MemoryCategory = 'preference' | 'goal' | 'meeting_context' | 'coaching_pattern';

export type MemorySource =
  | 'explicit_user_statement'
  | 'inference'
  | 'repeated_pattern'
  | 'test_or_setup';

export interface MemoryProposal {
  statement: string;
  category: MemoryCategory;
  source: MemorySource;
  confidence: 'high' | 'medium' | 'low';
  /** What was said or observed that supports the statement. */
  evidence: string;
  sensitive: boolean;
  user_confirmed: boolean;
}

export type MemoryDecision =
  | { action: 'save'; reason: string }
  | { action: 'candidate'; reason: string }
  | { action: 'confirm'; reason: string }
  | { action: 'ignore'; reason: string };

/**
 * priorMatches counts existing learnings/candidates that already resemble
 * the proposal — a repeat observation is stronger than a first impression.
 */
export function decideMemory(proposal: MemoryProposal, priorMatches: number): MemoryDecision {
  if (proposal.source === 'test_or_setup') {
    return { action: 'ignore', reason: 'Tests and setup chatter are not memories.' };
  }
  if (proposal.sensitive && !proposal.user_confirmed) {
    return { action: 'confirm', reason: 'Sensitive information needs explicit permission.' };
  }
  if (proposal.confidence === 'low' && !proposal.user_confirmed) {
    return { action: 'confirm', reason: 'Low-confidence inferences need confirmation.' };
  }
  if (proposal.source === 'explicit_user_statement' && proposal.confidence !== 'low') {
    return { action: 'save', reason: 'The user stated this durable context directly.' };
  }
  if (proposal.source === 'repeated_pattern' || priorMatches > 0 || proposal.user_confirmed) {
    return { action: 'save', reason: 'The pattern is repeated or confirmed.' };
  }
  return { action: 'candidate', reason: 'One inferred observation is not yet a durable pattern.' };
}

const words = (value: string): Set<string> =>
  new Set(
    value
      .toLowerCase()
      .split(/\W+/)
      .filter((word) => word.length > 3)
  );

/** Shared-significant-words count between two statements. */
export function overlapCount(a: string, b: string): number {
  const left = words(a);
  const right = words(b);
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared;
}

/** How many existing statements already resemble this one (overlap >= 2). */
export function matchCount(statement: string, existing: string[]): number {
  return existing.filter((item) => overlapCount(item, statement) >= 2).length;
}
