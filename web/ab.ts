import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildAnalysisPrompt, parseFeedbackJson } from '../src/analysis/analyzer';
import type { AnalyzeRequest } from '../src/analysis/analyzer';
import { pcm16ToWav } from '../src/recorder';
import type { EvidenceClip, RehearsalFeedback } from '../src/types';
import { SAMPLE_RATE } from '../src/types';

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

  // Ground truth for the audio judge's clips: slice the take at each
  // claimed range and transcribe the slice verbatim. Fabricated timestamps
  // fail this; real ones prove themselves.
  const clipChecks: ClipCheck[] = [];
  for (const [name, clip] of claimedClips(input.audioFeedback)) {
    try {
      const heard = await transcribe(opts, sliceWav(request.wav, clip.startMs, clip.endMs));
      clipChecks.push({ clip: name, claimed_label: clip.label, range_ms: [clip.startMs, clip.endMs], heard });
    } catch (err) {
      clipChecks.push({
        clip: name,
        claimed_label: clip.label,
        range_ms: [clip.startMs, clip.endMs],
        heard: `(verification failed: ${message(err)})`,
      });
    }
  }
  if (clipChecks.length) {
    fs.writeFileSync(path.join(dir, 'clips-verified.json'), JSON.stringify(clipChecks, null, 2));
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
      verdict = await blindedVerdict(opts, judgeModel, transcript, textFeedback, input.audioFeedback, clipChecks);
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
      '## Clip verification (audio ground truth)',
      clipChecks.length
        ? clipChecks
            .map((c) => `- ${c.clip} ${c.range_ms[0]}–${c.range_ms[1]}ms · claimed "${c.claimed_label}" · heard "${c.heard.trim()}"`)
            .join('\n')
        : '(no clips cited)',
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

interface ClipCheck {
  clip: string;
  claimed_label: string;
  range_ms: [number, number];
  heard: string;
}

function claimedClips(fb: RehearsalFeedback): Array<[string, EvidenceClip]> {
  const clips: Array<[string, EvidenceClip]> = [];
  if (fb.strengthClip) clips.push(['strength', fb.strengthClip]);
  if (fb.priority?.clip) clips.push(['priority', fb.priority.clip]);
  return clips;
}

/** Cut a span out of a 24k mono pcm16 WAV — pure byte math. */
export function sliceWav(wav: Uint8Array, startMs: number, endMs: number): Uint8Array {
  const bytesPerMs = (SAMPLE_RATE * 2) / 1000; // 48 — always even at 24k
  const start = 44 + Math.max(0, Math.round(startMs)) * bytesPerMs;
  const end = Math.min(wav.length, 44 + Math.round(endMs) * bytesPerMs);
  return pcm16ToWav(wav.subarray(start, Math.max(start, end)), SAMPLE_RATE);
}

/** whisper-1 with a verbatim prompt: fillers and false starts are exactly
 * what this experiment is about, and sanitized transcripts convict honest
 * audio claims of fabrication. */
async function transcribe(opts: AbOptions, wav: Uint8Array): Promise<string> {
  const form = new FormData();
  const bytes = new Uint8Array(wav);
  form.set('file', new Blob([bytes.buffer as ArrayBuffer], { type: 'audio/wav' }), 'take.wav');
  form.set('model', 'whisper-1');
  form.set('prompt', 'Transcribe verbatim, keeping every um, uh, so, like, and false start.');
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
  b: RehearsalFeedback,
  clipChecks: ClipCheck[]
): Promise<AbVerdict> {
  const prompt = [
    'Two pieces of speaking-coach feedback were produced for the same rehearsal take. You get the transcript and both feedbacks. You do NOT know how either was produced.',
    '',
    'Methodology cautions:',
    '- The transcript aims to be verbatim but transcription still normalizes some disfluencies. A feedback claim about a filler ("um", a tentative "so") that is absent from the transcript is NOT automatically fabrication.',
    '- CLIP VERIFICATION below is ground truth: each cited time range was cut from the actual audio and independently transcribed. A clip whose verification matches its label is proven real — timestamps are then facts, not fabrications. A clip whose verification contradicts its label is hard evidence of fabrication.',
    '',
    'Judge them:',
    '1. Which specific claims in A are NOT supported by the transcript? Which in B (after applying the cautions)?',
    '2. List every claim in B that could not be known from the words alone (tone, pace, pauses, emphasis, timing). For each, judge whether it is proven by clip verification, plausible, or likely fabricated.',
    '3. Which feedback would actually help this speaker more on their next take, and why — one paragraph, no diplomacy.',
    '',
    'Respond with ONLY JSON: { "a_claims_unsupported": [], "b_claims_unsupported": [], "b_beyond_words": [], "b_beyond_words_plausible": true|false, "more_useful": "A"|"B"|"tie", "reason": "" }',
    '',
    'TRANSCRIPT:',
    transcript.trim() || '(no words)',
    '',
    'CLIP VERIFICATION (audio ground truth):',
    clipChecks.length ? JSON.stringify(clipChecks, null, 2) : '(no clips were cited)',
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
