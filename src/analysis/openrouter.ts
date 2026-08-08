import * as fs from 'node:fs';
import type { AnalyzeRequest, RehearsalAnalyzer } from './analyzer.js';
import { parseFeedbackJson } from './analyzer.js';
import type { RehearsalFeedback } from '../types.js';

export interface OpenRouterAnalyzerOptions {
  apiKey: string;
  /** Any audio-capable OpenRouter model, e.g. "google/gemini-2.5-flash". */
  model: string;
  baseUrl?: string;
}

export class OpenRouterAnalyzer implements RehearsalAnalyzer {
  constructor(private readonly opts: OpenRouterAnalyzerOptions) {}

  async analyze(request: AnalyzeRequest): Promise<RehearsalFeedback> {
    const audio = fs.readFileSync(request.wavPath).toString('base64');
    const baseUrl = this.opts.baseUrl ?? 'https://openrouter.ai/api/v1';
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.opts.model,
        temperature: 0.4,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: buildPrompt(request) },
              { type: 'input_audio', input_audio: { data: audio, format: 'wav' } },
            ],
          },
        ],
      }),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(`analyzer request failed (${response.status}): ${detail}`);
    }
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const text = contentText(body.choices?.[0]?.message?.content);
    if (!text) throw new Error('analyzer returned an empty response');
    return parseFeedbackJson(text);
  }
}

/** Model content is usually a string, occasionally an array of parts. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'object' && part !== null ? (part as { text?: unknown }).text : undefined))
      .filter((t): t is string => typeof t === 'string')
      .join('\n');
  }
  return '';
}

function buildPrompt(request: AnalyzeRequest): string {
  const { meeting, learnings } = request;
  const lines: string[] = [
    'You are an executive communication coach reviewing one rehearsal take: the attached audio is the user talking through material for an upcoming meeting. Only the user speaks in the recording.',
    '',
    `Meeting: ${meeting.title}`,
  ];
  if (meeting.when) lines.push(`When: ${meeting.when}`);
  if (meeting.goal) lines.push(`What the user wants out of it: ${meeting.goal}`);
  if (learnings.length) {
    lines.push('', 'Known patterns about this user from previous coaching:');
    for (const l of learnings) lines.push(`- ${l}`);
  }
  lines.push(
    '',
    'Assess the take: structure, clarity of the ask, evidence, filler, pacing, confidence. Anchor everything in what was actually said.',
    '',
    'Respond with ONLY a JSON object, no prose and no code fences, in exactly this shape:',
    '{',
    '  "summary": "two or three sentences: the overall read",',
    '  "strengths": ["specific things that worked"],',
    '  "improvements": ["specific things to fix, most important first"],',
    '  "moments": [',
    '    {',
    '      "at_s": 134,',
    '      "quote": "short verbatim quote of what they said",',
    '      "verdict": "strong" | "weak",',
    '      "note": "why it landed or why it did not",',
    '      "better": "for weak moments: the sharper way to say it"',
    '    }',
    '  ]',
    '}',
    '',
    'Rules: at_s is seconds from the start of the audio. 3 to 8 moments, mixing strong and weak where honest. Quotes verbatim and short. Every weak moment gets a concrete "better" phrasing the user could actually say.'
  );
  return lines.join('\n');
}
