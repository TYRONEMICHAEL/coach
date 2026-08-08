import type { RealtimeTool } from './realtime/provider.js';

export type CapabilityResult = Record<string, unknown>;

/** What the tools can do — implemented by CoachSession, so tool handlers
 * stay declarative and the session owns all state transitions. */
export interface CapabilityServices {
  setMeeting(input: { title: string; when?: string; goal?: string }): CapabilityResult;
  addMeetingNote(note: string): CapabilityResult;
  remember(learning: string): CapabilityResult;
  beginRehearsal(): CapabilityResult;
  endRehearsal(): CapabilityResult;
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
        'Save a durable learning about the user, kept across sessions — a pattern in how they think or present. Not session trivia.',
      parameters: {
        type: 'object',
        properties: { learning: { type: 'string' } },
        required: ['learning'],
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
        return services.remember(requireString(args, 'learning'));
      case 'begin_rehearsal':
        return services.beginRehearsal();
      case 'end_rehearsal':
        return services.endRehearsal();
      default:
        return { error: `unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
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
