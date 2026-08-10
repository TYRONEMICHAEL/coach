import type { AnalyzeRequest, RehearsalAnalyzer } from '../../../src/analysis/analyzer';
import type { RehearsalFeedback } from '../../../src/types';

/**
 * Seam 2, browser edition: ships the take to the relay, which holds the
 * OpenRouter key and runs the real analyzer server-side. The browser never
 * sees a key; the audio leaves only when a take is analyzed.
 *
 * XHR instead of fetch for one reason: real upload progress — the user
 * watches their audio actually leave the phone.
 */
export class RelayAnalyzer implements RehearsalAnalyzer {
  constructor(
    private readonly onProgress?: (message: string) => void,
    private readonly getCapture?: () => unknown,
    private readonly url = '/api/analyze'
  ) {}

  analyze(request: AnalyzeRequest): Promise<RehearsalFeedback> {
    return new Promise<RehearsalFeedback>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', this.url);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.timeout = 5.5 * 60_000;
      xhr.responseType = 'text';

      this.onProgress?.('sending your take…');
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) {
          const pct = Math.min(100, Math.round((event.loaded / event.total) * 100));
          this.onProgress?.(pct < 100 ? `sending your take — ${pct}%` : 'take delivered — Inkling is listening…');
        }
      };
      xhr.upload.onload = () => this.onProgress?.('take delivered — Inkling is listening…');

      xhr.onload = () => {
        try {
          if (xhr.status < 200 || xhr.status >= 300) {
            const body = safeJson(xhr.responseText) as { error?: string } | undefined;
            reject(new Error(body?.error || `analysis failed (HTTP ${xhr.status})`));
            return;
          }
          this.onProgress?.('choosing the one thing that matters…');
          resolve(JSON.parse(xhr.responseText) as RehearsalFeedback);
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      };
      xhr.onerror = () => reject(new Error('the take could not reach the server — connection failed'));
      xhr.ontimeout = () => reject(new Error('the analysis took longer than five minutes'));
      xhr.onabort = () => reject(new Error('the analysis request was cancelled'));

      xhr.send(
        JSON.stringify({
          wavBase64: toBase64(request.wav),
          durationMs: request.durationMs,
          meeting: request.meeting,
          learnings: request.learnings,
          takeNumber: request.takeNumber,
          previousSummary: request.previousSummary,
          capture: this.getCapture?.(),
        })
      );
    });
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
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
