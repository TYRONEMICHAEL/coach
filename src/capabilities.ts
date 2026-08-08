import type { MemoryProposal } from './gate';
import type { RealtimeTool } from './realtime/provider';
import type { ExcerptResult } from './types';

export type CapabilityResult = Record<string, unknown>;

/** What the tools can do — implemented by CoachSession, so tool handlers
 * stay declarative and the session owns all state transitions. */
export interface CapabilityServices {
  setMeeting(input: { title: string; when?: string; goal?: string }): CapabilityResult;
  addMeetingNote(note: string): CapabilityResult;
  /** The gate decides; the result reports save/candidate/confirm/ignore. */
  remember(proposal: MemoryProposal): CapabilityResult;
  beginRehearsal(): CapabilityResult;
  endRehearsal(): Promise<CapabilityResult> | CapabilityResult;
  /** Replay a precise slice of the user's own take. */
  playExcerpt(input: {
    recordingId?: string;
    startMs: number;
    endMs: number;
  }): Promise<ExcerptResult> | ExcerptResult;
}

export function coachTools(): RealtimeTool[] {
  return [
    {
      name: 'set_meeting',
      description:
        'Start (or resume) prep for a specific meeting. Call before meeting notes or rehearsals.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short meeting name, e.g. "Q3 board review"' },
          when: { type: 'string', description: 'When it happens, free text' },
          goal: { type: 'string', description: 'What the user wants out of the meeting' },
        },
        required: ['title'],
      },
    },
    {
      name: 'meeting_note',
      description: 'Save a fact, decision, or framing point to the active meeting\'s prep notes.',
      parameters: {
        type: 'object',
        properties: { note: { type: 'string' } },
        required: ['note'],
      },
    },
    {
      name: 'remember',
      description:
        'Propose durable information about the user — a pattern in how they think or present, a stated preference or goal. Not session trivia. The harness, not you, decides whether it is saved, held as a candidate, needs confirmation, or is ignored; relay a confirmation request naturally.',
      parameters: {
        type: 'object',
        properties: {
          statement: { type: 'string', description: 'The durable statement, in plain words.' },
          category: {
            type: 'string',
            enum: ['preference', 'goal', 'meeting_context', 'coaching_pattern'],
          },
          source: {
            type: 'string',
            enum: ['explicit_user_statement', 'inference', 'repeated_pattern', 'test_or_setup'],
          },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          evidence: { type: 'string', description: 'What was said or observed that supports it.' },
          sensitive: { type: 'boolean', description: 'Health, relationships, money, conflict.' },
          user_confirmed: {
            type: 'boolean',
            description: 'True only after the user explicitly agreed to keep this.',
          },
        },
        required: ['statement', 'category', 'source', 'confidence', 'evidence', 'sensitive', 'user_confirmed'],
      },
    },
    {
      name: 'begin_rehearsal',
      description:
        'The user is starting an actual run-through (presenting to their imagined audience, not talking to you). Starts recording. Stay silent after calling this.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'end_rehearsal',
      description:
        'The user has stepped out of the run-through and is talking to you again. Stops recording and starts the analysis, which arrives later as a system note.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'play_excerpt',
      description:
        'Play a precise excerpt of the user\'s own recorded take back to them — the moment cited in the analysis, or any span they ask to hear. Use the clip start/end milliseconds from the analysis note.',
      parameters: {
        type: 'object',
        properties: {
          recording_id: {
            type: 'string',
            description: 'The take to replay; defaults to the most recent take.',
          },
          start_ms: { type: 'number' },
          end_ms: { type: 'number' },
        },
        required: ['start_ms', 'end_ms'],
      },
    },
  ];
}

/** Dispatch a tool call. Never throws — errors come back as { error } so the
 * model can recover conversationally. */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  services: CapabilityServices
): Promise<CapabilityResult> {
  try {
    switch (name) {
      case 'set_meeting':
        return services.setMeeting({
          title: requireString(args, 'title'),
          when: optionalString(args, 'when'),
          goal: optionalString(args, 'goal'),
        });
      case 'meeting_note':
        return services.addMeetingNote(requireString(args, 'note'));
      case 'remember':
        return services.remember(parseProposal(args));
      case 'begin_rehearsal':
        return services.beginRehearsal();
      case 'end_rehearsal':
        return await services.endRehearsal();
      case 'play_excerpt':
        return (await services.playExcerpt({
          recordingId: optionalString(args, 'recording_id'),
          startMs: requireNumber(args, 'start_ms'),
          endMs: requireNumber(args, 'end_ms'),
        })) as unknown as CapabilityResult;
      default:
        return { error: `unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function parseProposal(args: Record<string, unknown>): MemoryProposal {
  return {
    statement: requireString(args, 'statement'),
    category: requireEnum(args, 'category', [
      'preference',
      'goal',
      'meeting_context',
      'coaching_pattern',
    ] as const),
    source: requireEnum(args, 'source', [
      'explicit_user_statement',
      'inference',
      'repeated_pattern',
      'test_or_setup',
    ] as const),
    confidence: requireEnum(args, 'confidence', ['high', 'medium', 'low'] as const),
    evidence: requireString(args, 'evidence'),
    sensitive: args.sensitive === true,
    user_confirmed: args.user_confirmed === true,
  };
}

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`missing required argument: ${key}`);
  return v.trim();
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

function requireNumber(args: Record<string, unknown>, key: string): number {
  const v = Number(args[key]);
  if (!Number.isFinite(v)) throw new Error(`missing required argument: ${key}`);
  return v;
}

function requireEnum<T extends string>(
  args: Record<string, unknown>,
  key: string,
  allowed: readonly T[]
): T {
  const v = args[key];
  if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T;
  throw new Error(`argument ${key} must be one of: ${allowed.join(', ')}`);
}
