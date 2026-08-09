import type {
  EvidenceClip,
  MeetingContext,
  RehearsalFeedback,
  RehearsalPriority,
  RehearsalTake,
  TakeAssessment,
  TakeProgress,
} from '../types';
import { methodBriefLines } from '../method';

// Seam 2: rehearsal analysis. Takes the recorded WAV plus context, returns
// the product's coaching read: one strength, one priority, replayable clips.
// The OpenRouter adapter is one implementation; anything that can hear
// audio can sit behind this.

export interface AnalyzeRequest {
  /** Complete WAV (16-bit mono PCM) of the take. */
  wav: Uint8Array;
  durationMs: number;
  meeting: MeetingContext;
  learnings: string[];
  /** Continuity: which take this is and what the previous one was told. */
  takeNumber?: number;
  previousSummary?: string;
}

export interface RehearsalAnalyzer {
  analyze(request: AnalyzeRequest): Promise<RehearsalFeedback>;
}

export function mmss(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * The listening brief. Audio-grounded by design: the analyzer hears the
 * waveform, not a transcript, and must return evidence the user can replay
 * — or nothing. One strength, one priority, never a report.
 */
export function buildAnalysisPrompt(
  request: Pick<AnalyzeRequest, 'meeting' | 'learnings' | 'takeNumber' | 'previousSummary'>
): string {
  const { meeting, learnings } = request;
  const lines: string[] = [
    'You are the listening specialist for a calm, exacting executive communication coach. You receive the complete audio of one rehearsal take: the user talking through material for an upcoming meeting. Only the user speaks in the recording.',
    '',
    `Meeting: ${meeting.title}`,
  ];
  if (meeting.when) lines.push(`When: ${meeting.when}`);
  if (meeting.goal) lines.push(`What the user wants out of it: ${meeting.goal}`);
  if (request.takeNumber && request.takeNumber > 1 && request.previousSummary) {
    lines.push(
      '',
      `This is take ${request.takeNumber} for this meeting. The previous take's read was: ${request.previousSummary}`,
      'Coaching compounds or it is worthless: listen specifically for whether the previous correction moved, and report progress honestly — improved, same, regressed, or not comparable (different material). Anchor the verdict in what you actually heard, never in encouragement.'
    );
  }
  if (learnings.length) {
    lines.push('', 'Known patterns about this user from previous coaching:');
    for (const l of learnings) lines.push(`- ${l}`);
  }
  lines.push(
    '',
    'First classify the recording: real rehearsal, warm-up, mic check, or unclear. A sound check, counting, or commentary about the app is not a real rehearsal; length alone does not decide.',
    '',
    'If it is a real rehearsal, listen for what a transcript cannot show as well as what it can: structure, clarity of the ask, tone against message — and the delivery itself, heard through the method below.',
    '',
    ...methodBriefLines(),
    '',
    'Then choose exactly ONE strength worth keeping and exactly ONE highest-leverage improvement. Anchor both in what was actually said and how it actually sounded — never a generic critique.',
    '',
    'For each cited clip, make a second pass and locate the exact phrase boundary. Return a tight 3–10 second span starting just before the audible behavior and ending just after it, with the clip\'s opening words in the label so playback can be checked. If you cannot localize a moment confidently, return null for the clip instead of guessing. Never invent a timestamp, quote, or acoustic claim.',
    '',
    'suggestedDelivery: the sharper way to say the weakest cited moment, in one or two sentences, using only ideas and vocabulary present in the recording. Do not invent facts. The drill takes under a minute.',
    '',
    'Respond with ONLY a JSON object, no prose and no code fences, in exactly this shape:',
    '{',
    '  "assessment": { "kind": "real rehearsal" | "warm-up" | "mic check" | "unclear", "confidence": "high" | "medium" | "low", "reason": "one grounded sentence" },',
    '  "progress": { "verdict": "improved" | "same" | "regressed" | "not_comparable", "note": "one sentence on the previous correction", "evidence": "what you heard that proves it" } | null,',
    '  "strength": "specific behavior worth keeping",',
    '  "strengthEvidence": ["grounded moment"],',
    '  "strengthClip": { "startMs": 0, "endMs": 0, "label": "opening words of the clip" } | null,',
    '  "priority": {',
    '    "dimension": "Structure | Clarity of the ask | Tone | Confidence | Rate | Volume | Pitch | Melody | Pause | Emphasis | Hesitation",',
    '    "title": "plain diagnosis",',
    '    "whyItMatters": "the listener consequence",',
    '    "evidence": ["grounded moment"],',
    '    "clip": { "startMs": 0, "endMs": 0, "label": "opening words of the clip" } | null,',
    '    "correction": "one behavior for the next take",',
    '    "drill": "one practice drill under a minute"',
    '  } | null,',
    '  "suggestedDelivery": "one or two sentences in the speaker\'s own vocabulary",',
    '  "audioAdvantage": "one observation possible only from audio, or an empty string"',
    '}',
    '',
    'priority is null only when the take was not a real rehearsal. progress is null on a first take or when there was no previous correction to compare against.'
  );
  return lines.join('\n');
}

/**
 * Tolerant JSON extraction: analysis models wrap JSON in fences or prose
 * often enough that strict parsing would fail runs for no good reason.
 * Clips are clamped to the take's duration; malformed clips become
 * undefined rather than lies.
 */
export function parseFeedbackJson(text: string, durationMs: number): RehearsalFeedback {
  const raw = extractJsonObject(text);
  const assessment = parseAssessment(raw.assessment);
  const strength = typeof raw.strength === 'string' ? raw.strength.trim() : '';
  if (!strength) throw new Error('analysis response had no strength');
  return {
    assessment,
    progress: parseProgress(raw.progress),
    strength,
    strengthEvidence: stringArray(raw.strengthEvidence),
    strengthClip: parseClip(raw.strengthClip, durationMs),
    priority: parsePriority(raw.priority, durationMs),
    suggestedDelivery: typeof raw.suggestedDelivery === 'string' ? raw.suggestedDelivery.trim() : '',
    audioAdvantage:
      typeof raw.audioAdvantage === 'string' && raw.audioAdvantage.trim() !== ''
        ? raw.audioAdvantage.trim()
        : undefined,
  };
}

function parseAssessment(v: unknown): TakeAssessment {
  const raw = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  const kind = raw.kind;
  const confidence = raw.confidence;
  return {
    kind:
      kind === 'real rehearsal' || kind === 'warm-up' || kind === 'mic check' || kind === 'unclear'
        ? kind
        : 'unclear',
    confidence: confidence === 'high' || confidence === 'medium' || confidence === 'low' ? confidence : 'low',
    reason:
      typeof raw.reason === 'string' && raw.reason.trim() !== ''
        ? raw.reason.trim()
        : 'The analyzer could not confidently classify the take.',
  };
}

function parseProgress(v: unknown): TakeProgress | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const raw = v as Record<string, unknown>;
  const verdict = raw.verdict;
  if (verdict !== 'improved' && verdict !== 'same' && verdict !== 'regressed' && verdict !== 'not_comparable')
    return undefined;
  const note = typeof raw.note === 'string' ? raw.note.trim() : '';
  if (!note) return undefined;
  return {
    verdict,
    note,
    evidence:
      typeof raw.evidence === 'string' && raw.evidence.trim() !== '' ? raw.evidence.trim() : undefined,
  };
}

function parsePriority(v: unknown, durationMs: number): RehearsalPriority | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const raw = v as Record<string, unknown>;
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const correction = typeof raw.correction === 'string' ? raw.correction.trim() : '';
  if (!title || !correction) return undefined;
  return {
    dimension: typeof raw.dimension === 'string' && raw.dimension.trim() !== '' ? raw.dimension.trim() : 'Delivery',
    title,
    whyItMatters: typeof raw.whyItMatters === 'string' ? raw.whyItMatters.trim() : '',
    evidence: stringArray(raw.evidence),
    clip: parseClip(raw.clip, durationMs),
    correction,
    drill: typeof raw.drill === 'string' ? raw.drill.trim() : '',
  };
}

function parseClip(v: unknown, durationMs: number): EvidenceClip | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const raw = v as Record<string, unknown>;
  const start = Number(raw.startMs);
  const end = Number(raw.endMs);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return undefined;
  // Clips never extend past the take: pull the start back before the cap
  // rather than letting the 250ms minimum overshoot the end.
  const startMs = Math.max(0, Math.min(Math.max(0, durationMs - 250), Math.round(start)));
  const endMs = Math.min(durationMs, Math.max(startMs + 250, Math.round(end)));
  if (endMs <= startMs) return undefined;
  return {
    startMs,
    endMs,
    label: typeof raw.label === 'string' && raw.label.trim() !== '' ? raw.label.trim() : 'Listen to this moment.',
  };
}

function extractJsonObject(text: string): Record<string, unknown> {
  const start = text.indexOf('{');
  if (start === -1) throw new Error('no JSON object in analysis response');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
    } else if (ch === '\\') {
      escaped = inString;
    } else if (ch === '"') {
      inString = !inString;
    } else if (!inString) {
      if (ch === '{') depth++;
      if (ch === '}') depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1)) as Record<string, unknown>;
    }
  }
  throw new Error('unterminated JSON object in analysis response');
}

function stringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim());
}

const clipLine = (clip: EvidenceClip | undefined, recordingId: string): string =>
  clip
    ? ` [replayable: play_excerpt recording_id "${recordingId}" start_ms ${clip.startMs} end_ms ${clip.endMs} — "${clip.label}"]`
    : '';

/** One line of continuity: what the next take's analysis compares against
 * and what the coach opens with next session. */
export function summarizeFeedback(fb: RehearsalFeedback): string {
  const parts: string[] = [];
  if (fb.priority) {
    parts.push(`the priority was "${fb.priority.title}" (${fb.priority.dimension}); the correction: ${fb.priority.correction}`);
  } else {
    parts.push(`no coaching priority (${fb.assessment.kind})`);
  }
  parts.push(`the strength to keep: ${fb.strength}`);
  if (fb.progress) parts.push(`progress on the take before: ${fb.progress.verdict}`);
  return parts.join('; ');
}

/** Markdown block appended to the meeting record for one take. */
export function renderFeedbackMarkdown(fb: RehearsalFeedback): string {
  const lines: string[] = [
    `_${fb.assessment.kind} (${fb.assessment.confidence}): ${fb.assessment.reason}_`,
    '',
  ];
  if (fb.progress) {
    lines.push(
      `**Progress** — ${fb.progress.verdict}: ${fb.progress.note}${fb.progress.evidence ? ` (${fb.progress.evidence})` : ''}`,
      ''
    );
  }
  lines.push(`**Strength** — ${fb.strength}`);
  for (const e of fb.strengthEvidence) lines.push(`- ${e}`);
  if (fb.strengthClip)
    lines.push(`- clip ${mmss(fb.strengthClip.startMs / 1000)}–${mmss(fb.strengthClip.endMs / 1000)}: "${fb.strengthClip.label}"`);
  if (fb.priority) {
    lines.push('', `**Priority** — ${fb.priority.title} (${fb.priority.dimension})`);
    if (fb.priority.whyItMatters) lines.push(`- why: ${fb.priority.whyItMatters}`);
    for (const e of fb.priority.evidence) lines.push(`- ${e}`);
    if (fb.priority.clip)
      lines.push(`- clip ${mmss(fb.priority.clip.startMs / 1000)}–${mmss(fb.priority.clip.endMs / 1000)}: "${fb.priority.clip.label}"`);
    lines.push(`- correction: ${fb.priority.correction}`);
    if (fb.priority.drill) lines.push(`- drill: ${fb.priority.drill}`);
  }
  if (fb.suggestedDelivery) lines.push('', `**Sharper delivery** — "${fb.suggestedDelivery}"`);
  if (fb.audioAdvantage) lines.push(`**Heard, not read** — ${fb.audioAdvantage}`);
  return lines.join('\n');
}

/** Compact note injected into the live conversation once analysis lands. */
export function formatFeedbackNote(take: RehearsalTake, fb: RehearsalFeedback): string {
  const lines: string[] = [
    `Rehearsal analysis ready — "${take.meeting.title}", take ${take.takeNumber}, ${mmss(take.seconds)} long.`,
    `Assessment: ${fb.assessment.kind} (${fb.assessment.confidence} confidence) — ${fb.assessment.reason}`,
  ];
  if (fb.progress) {
    lines.push(
      `Progress on last take's correction: ${fb.progress.verdict} — ${fb.progress.note}${fb.progress.evidence ? ` Evidence: ${fb.progress.evidence}` : ''} Deliver this first: progress named honestly is what makes the coaching real.`
    );
  }
  lines.push(
    `Strength: ${fb.strength}${fb.strengthEvidence.length ? ` (${fb.strengthEvidence.join('; ')})` : ''}${clipLine(fb.strengthClip, take.id)}`
  );
  if (fb.priority) {
    lines.push(
      `Priority — ${fb.priority.title} (${fb.priority.dimension}). ${fb.priority.whyItMatters}${fb.priority.evidence.length ? ` Evidence: ${fb.priority.evidence.join('; ')}` : ''}${clipLine(fb.priority.clip, take.id)}`,
      `Correction for the next take: ${fb.priority.correction}${fb.priority.drill ? ` Drill: ${fb.priority.drill}` : ''}`
    );
  } else {
    lines.push('No coaching priority: the take was not a real rehearsal. Say so lightly and invite a real run-through.');
  }
  if (fb.suggestedDelivery) lines.push(`Sharper delivery to demonstrate in your own voice: "${fb.suggestedDelivery}"`);
  if (fb.audioAdvantage) lines.push(`Audio-only observation: ${fb.audioAdvantage}`);
  lines.push(
    'Deliver this as a coach, not a report: the strength in one sentence, then the one priority and its cost. Where a replayable clip is marked, offer to play the moment; on agreement call play_excerpt with exactly those millisecond values, let them hear it, then demonstrate the sharper delivery.'
  );
  return lines.join('\n');
}
