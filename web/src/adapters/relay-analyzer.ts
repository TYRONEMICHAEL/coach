import type { AnalyzeRequest, RehearsalAnalyzer } from '../../../src/analysis/analyzer';
import type { RehearsalFeedback } from '../../../src/types';

/**
 * Seam 2, browser edition: ships the take to the relay, which holds the
 * OpenRouter key and runs the real analyzer server-side. The browser never
 * sees a key; the audio leaves only when a take is analyzed.
 */
export class RelayAnalyzer implements RehearsalAnalyzer {
  constructor(
    private readonly onProgress?: (message: string) => void,
    private readonly url = '/api/analyze'
  ) {}

  async analyze(request: AnalyzeRequest): Promise<RehearsalFeedback> {
    this.onProgress?.('Sending the take for a careful listen…');
    const response = await fetch(this.url, {
      method: 'POST',
      signal: AbortSignal.timeout(5.5 * 60_000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wavBase64: toBase64(request.wav),
        durationMs: request.durationMs,
        meeting: request.meeting,
        learnings: request.learnings,
        takeNumber: request.takeNumber,
        previousSummary: request.previousSummary,
      }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error || `analysis failed (HTTP ${response.status})`);
    }
    this.onProgress?.('Choosing the one thing that matters…');
    return (await response.json()) as RehearsalFeedback;
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}
