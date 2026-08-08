import type { AnalyzeRequest, RehearsalAnalyzer } from './analyzer';
import { buildAnalysisPrompt, parseFeedbackJson } from './analyzer';
import type { RehearsalFeedback } from '../types';

export interface OpenRouterAnalyzerOptions {
  apiKey: string;
  /** Any audio-capable OpenRouter model, e.g. "google/gemini-2.5-flash"
   * or "thinkingmachines/inkling-small". */
  model: string;
  baseUrl?: string;
  /** Hard cap on one analysis run. Default five minutes. */
  timeoutMs?: number;
}

/** Runs server-side (CLI or the web relay) — the key never reaches a browser. */
export class OpenRouterAnalyzer implements RehearsalAnalyzer {
  constructor(private readonly opts: OpenRouterAnalyzerOptions) {}

  async analyze(request: AnalyzeRequest): Promise<RehearsalFeedback> {
    const baseUrl = this.opts.baseUrl ?? 'https://openrouter.ai/api/v1';
    const timeoutMs = this.opts.timeoutMs ?? 5 * 60_000;
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.opts.model,
          temperature: 0.3,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: buildAnalysisPrompt(request) },
                {
                  type: 'input_audio',
                  input_audio: { data: Buffer.from(request.wav).toString('base64'), format: 'wav' },
                },
              ],
            },
          ],
        }),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new Error(`analyzer timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
      throw err;
    }
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(`analyzer request failed (${response.status}): ${detail}`);
    }
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const text = contentText(body.choices?.[0]?.message?.content);
    if (!text) throw new Error('analyzer returned an empty response');
    return parseFeedbackJson(text, request.durationMs);
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
