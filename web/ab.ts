import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildAnalysisPrompt, parseFeedbackJson } from '../src/analysis/analyzer';
import type { AnalyzeRequest } from '../src/analysis/analyzer';
import type { RehearsalFeedback } from '../src/types';

/**
 * The transcript-vs-audio experiment, run silently on every analyzed take.
 *
 * Question under test: does the audio specialist add value beyond what any
 * text model could say from a transcript alone? Each take leaves a bundle:
 *
 *   data/ab/<stamp>-<slug>-take-N/
 *     take.wav            the audio as analyzed
 *     transcript.txt      what a transcription model heard as words
 *     audio-judge.json    the specialist's feedback (what the user got)
 *     text-judge.json     same brief, transcript only, no audio
 *     verdict.json        a blinded judge: does B earn its keep over A?
 *     comparison.md       all of it, readable
 *
 * Runs AFTER the product has already responded — never adds latency, and a
 * failure here never touches the session.
 */

export interface AbOptions {
  openaiKey: string;
  openrouterKey: string;
  dataDir: string;
  /** Text judge gets the transcript; default mirrors the audio default's
   * generic rival so the comparison is fair and cheap. */
  textModel?: string;
  judgeModel?: string;
}

export interface AbInput {
  request: AnalyzeRequest;
  audioFeedback: RehearsalFeedback;
  audioModel: string;
}

const TEXT_JUDGE_PREFIX =
  'You are working from a TRANSCRIPT ONLY — you never heard the audio. You cannot know tone, pace, pauses, emphasis, or timing, and you must not pretend to: set every clip field to null and leave audioAdvantage as an empty string. Everything else in the brief applies to what the words alone can show.';

/** Partial evidence beats none: every step writes what it produced, and a
 * failed step becomes a note in the bundle instead of losing the take. */
export async function runAbExperiment(opts: AbOptions, input: AbInput): Promise<string> {
  const { request } = input;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const takeLabel = request.takeNumber ? `-take-${request.takeNumber}` : '';
  const dir = path.join(opts.dataDir, 'ab', `${stamp}-${request.meeting.slug}${takeLabel}`);
  fs.mkdirSync(dir, { recursive: true });
  const problems: string[] = [];

  fs.writeFileSync(path.join(dir, 'take.wav'), request.wav);
  fs.writeFileSync(
    path.join(dir, 'audio-judge.json'),
    JSON.stringify({ model: input.audioModel, feedback: input.audioFeedback }, null, 2)
  );

  let transcript = '';
  try {
    transcript = await transcribe(opts, request.wav);
    fs.writeFileSync(path.join(dir, 'transcript.txt'), transcript);
  } catch (err) {
    problems.push(`transcription failed: ${message(err)}`);
  }

  const textModel = opts.textModel ?? 'google/gemini-2.5-flash';
  let textFeedback: RehearsalFeedback | undefined;
  if (!problems.length) {
    try {
      textFeedback = await textJudge(opts, textModel, request, transcript);
      fs.writeFileSync(
        path.join(dir, 'text-judge.json'),
        JSON.stringify({ model: textModel, feedback: textFeedback }, null, 2)
      );
    } catch (err) {
      problems.push(`text judge failed: ${message(err)}`);
    }
  }

  const judgeModel = opts.judgeModel ?? 'anthropic/claude-sonnet-4.5';
  let verdict: AbVerdict | undefined;
  if (textFeedback) {
    try {
      verdict = await blindedVerdict(opts, judgeModel, transcript, textFeedback, input.audioFeedback);
      fs.writeFileSync(path.join(dir, 'verdict.json'), JSON.stringify({ model: judgeModel, ...verdict }, null, 2));
    } catch (err) {
      problems.push(`verdict judge failed: ${message(err)}`);
    }
  }

  fs.writeFileSync(
    path.join(dir, 'comparison.md'),
    [
      `# ${request.meeting.title}${request.takeNumber ? ` — take ${request.takeNumber}` : ''}`,
      `${Math.round(request.durationMs / 1000)}s · audio judge: ${input.audioModel} · text judge: ${textModel} · verdict: ${judgeModel}`,
      ...(problems.length ? ['', `> incomplete bundle: ${problems.join('; ')}`] : []),
      '',
      '## Transcript',
      transcript.trim() || '(empty)',
      '',
      '## Feedback A — transcript only',
      '```json',
      textFeedback ? JSON.stringify(textFeedback, null, 2) : '(not produced)',
      '```',
      '',
      '## Feedback B — audio (what the user got)',
      '```json',
      JSON.stringify(input.audioFeedback, null, 2),
      '```',
      '',
      '## Blinded verdict',
      '```json',
      verdict ? JSON.stringify(verdict, null, 2) : '(not produced)',
      '```',
    ].join('\n')
  );
  if (problems.length) fs.writeFileSync(path.join(dir, 'problems.txt'), problems.join('\n'));
  return problems.length ? `${dir} (incomplete: ${problems.join('; ')})` : dir;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function transcribe(opts: AbOptions, wav: Uint8Array): Promise<string> {
  const form = new FormData();
  const bytes = new Uint8Array(wav);
  form.set('file', new Blob([bytes.buffer as ArrayBuffer], { type: 'audio/wav' }), 'take.wav');
  form.set('model', 'gpt-4o-mini-transcribe');
  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    signal: AbortSignal.timeout(120_000),
    headers: { Authorization: `Bearer ${opts.openaiKey}` },
    body: form,
  });
  if (!response.ok) throw new Error(`transcription failed (${response.status}): ${(await response.text()).slice(0, 200)}`);
  const body = (await response.json()) as { text?: string };
  return body.text ?? '';
}

async function textJudge(
  opts: AbOptions,
  model: string,
  request: AnalyzeRequest,
  transcript: string
): Promise<RehearsalFeedback> {
  const prompt = [
    TEXT_JUDGE_PREFIX,
    '',
    buildAnalysisPrompt(request),
    '',
    'TRANSCRIPT OF THE TAKE:',
    transcript.trim() || '(the transcription model returned no words)',
  ].join('\n');
  const text = await openrouterText(opts, model, prompt, 0.3);
  return parseFeedbackJson(text, request.durationMs);
}

interface AbVerdict {
  a_claims_unsupported: string[];
  b_claims_unsupported: string[];
  b_beyond_words: string[];
  b_beyond_words_plausible: boolean;
  more_useful: 'A' | 'B' | 'tie';
  reason: string;
}

async function blindedVerdict(
  opts: AbOptions,
  model: string,
  transcript: string,
  a: RehearsalFeedback,
  b: RehearsalFeedback
): Promise<AbVerdict> {
  const prompt = [
    'Two pieces of speaking-coach feedback were produced for the same rehearsal take. You get the transcript and both feedbacks. You do NOT know how either was produced.',
    '',
    'Judge them:',
    '1. Which specific claims in A are NOT supported by the transcript? Which in B?',
    '2. List every claim in B that could not be known from the words alone (tone, pace, pauses, emphasis, timing). For each, judge whether it reads as a plausible observation of real audio or as fabrication (invented quotes, generic acoustic claims that fit any take).',
    '3. Which feedback would actually help this speaker more on their next take, and why — one paragraph, no diplomacy.',
    '',
    'Respond with ONLY JSON: { "a_claims_unsupported": [], "b_claims_unsupported": [], "b_beyond_words": [], "b_beyond_words_plausible": true|false, "more_useful": "A"|"B"|"tie", "reason": "" }',
    '',
    'TRANSCRIPT:',
    transcript.trim() || '(no words)',
    '',
    'FEEDBACK A:',
    JSON.stringify(a, null, 2),
    '',
    'FEEDBACK B:',
    JSON.stringify(b, null, 2),
  ].join('\n');
  const text = await openrouterText(opts, model, prompt, 0.2);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('verdict judge returned no JSON');
  return JSON.parse(text.slice(start, end + 1)) as AbVerdict;
}

async function openrouterText(opts: AbOptions, model: string, prompt: string, temperature: number): Promise<string> {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(180_000),
    headers: { Authorization: `Bearer ${opts.openrouterKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, temperature, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!response.ok) throw new Error(`${model} failed (${response.status}): ${(await response.text()).slice(0, 200)}`);
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'object' && part !== null ? (part as { text?: unknown }).text : undefined))
      .filter((t): t is string => typeof t === 'string')
      .join('\n');
  }
  throw new Error(`${model} returned no text`);
}
