import type { MeetingContext, RehearsalFeedback, RehearsalMoment, RehearsalTake } from '../types.js';

// Seam 2: rehearsal analysis. Takes the recorded WAV plus context, returns
// structured, timestamped feedback. The OpenRouter adapter is one
// implementation; anything that can hear audio can sit behind this.

export interface AnalyzeRequest {
  wavPath: string;
  meeting: MeetingContext;
  learnings: string[];
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
 * Tolerant JSON extraction: analysis models wrap JSON in fences or prose
 * often enough that strict parsing would fail runs for no good reason.
 */
export function parseFeedbackJson(text: string): RehearsalFeedback {
  const raw = extractJsonObject(text);
  const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';
  if (!summary) throw new Error('analysis response had no summary');
  return {
    summary,
    strengths: stringArray(raw.strengths),
    improvements: stringArray(raw.improvements),
    moments: momentArray(raw.moments),
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

function momentArray(v: unknown): RehearsalMoment[] {
  if (!Array.isArray(v)) return [];
  const moments: RehearsalMoment[] = [];
  for (const item of v) {
    if (typeof item !== 'object' || item === null) continue;
    const m = item as Record<string, unknown>;
    const at = Number(m.at_s);
    const quote = typeof m.quote === 'string' ? m.quote.trim() : '';
    const verdict = m.verdict === 'strong' || m.verdict === 'weak' ? m.verdict : undefined;
    const note = typeof m.note === 'string' ? m.note.trim() : '';
    if (!Number.isFinite(at) || at < 0 || !quote || !verdict || !note) continue;
    moments.push({
      at_s: at,
      quote,
      verdict,
      note,
      better: typeof m.better === 'string' && m.better.trim() !== '' ? m.better.trim() : undefined,
    });
  }
  return moments.sort((a, b) => a.at_s - b.at_s);
}

/** Markdown block appended to the meeting file for one take. */
export function renderFeedbackMarkdown(fb: RehearsalFeedback): string {
  const lines: string[] = [fb.summary, ''];
  if (fb.strengths.length) {
    lines.push('**Strengths**');
    for (const s of fb.strengths) lines.push(`- ${s}`);
  }
  if (fb.improvements.length) {
    lines.push('**Improvements**');
    for (const s of fb.improvements) lines.push(`- ${s}`);
  }
  if (fb.moments.length) {
    lines.push('**Moments**');
    for (const m of fb.moments) {
      lines.push(`- ${mmss(m.at_s)} ${m.verdict} — "${m.quote}" — ${m.note}`);
      if (m.better) lines.push(`  - try: "${m.better}"`);
    }
  }
  return lines.join('\n');
}

/** Compact note injected into the live conversation once analysis lands. */
export function formatFeedbackNote(take: RehearsalTake, fb: RehearsalFeedback): string {
  const lines: string[] = [
    `Rehearsal analysis ready — "${take.meeting.title}", take ${take.takeNumber}, ${mmss(take.seconds)} long.`,
    `Overall: ${fb.summary}`,
  ];
  if (fb.strengths.length) lines.push(`Strengths: ${fb.strengths.join('; ')}`);
  if (fb.improvements.length) lines.push(`Needs work: ${fb.improvements.join('; ')}`);
  if (fb.moments.length) {
    lines.push('Moments (time into the take):');
    for (const m of fb.moments) {
      const better = m.better ? ` → sharper: "${m.better}"` : '';
      lines.push(`- ${mmss(m.at_s)} ${m.verdict}: "${m.quote}" — ${m.note}${better}`);
    }
  }
  lines.push(
    'Deliver this conversationally: overall read first, then the two or three moments that matter most — where it happened, what they said, and the sharper version. Offer the rest rather than reciting it.'
  );
  return lines.join('\n');
}
