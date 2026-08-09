import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenRouterAnalyzer } from '../src/analysis/openrouter';
import type { AnalyzeRequest } from '../src/analysis/analyzer';
import type { MeetingContext } from '../src/types';
import { runAbExperiment } from './ab';

/**
 * The web body's relay: a zero-dependency node:http server that keeps both
 * API keys off the browser and serves the built SPA.
 *
 *   GET  /api/status            which keys are configured
 *   POST /api/realtime/session  WebRTC SDP offer -> OpenAI Realtime answer
 *   POST /api/analyze           take WAV (base64) -> structured feedback
 *
 * Run: OPENAI_API_KEY=… OPENROUTER_API_KEY=… npm run web:serve
 * (dev: `npm run web:dev` proxies /api here, so run both.)
 */

const PORT = Number(process.env.PORT ?? 8787);
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? '';
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? '';
const REALTIME_MODEL = process.env.COACH_MODEL ?? 'gpt-realtime';
const VOICE = process.env.COACH_VOICE ?? 'marin';
// Same evidence-based default as src/config.ts: the specialist listener.
const ANALYZER_MODEL = process.env.COACH_ANALYZER_MODEL ?? 'thinkingmachines/inkling-small';
/** The transcript-vs-audio experiment: on unless COACH_AB=0. Bundles land
 * in data/ab/ on this machine only. */
const AB_ENABLED = process.env.COACH_AB !== '0';
const DATA_DIR = process.env.COACH_DATA_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
/** 12 minutes of 24k mono pcm16 as base64 is ~46 MB; leave headroom. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
};

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function realtimeSession(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!OPENAI_KEY) {
    json(res, 503, {
      error: 'The server has no OPENAI_API_KEY. Start it with the key in the environment.',
      code: 'api_key_required',
    });
    return;
  }
  const sdp = (await readBody(req)).toString('utf8');
  if (!sdp.includes('v=0')) {
    json(res, 400, { error: 'Invalid WebRTC offer.' });
    return;
  }
  const form = new FormData();
  form.set('sdp', sdp);
  form.set(
    'session',
    JSON.stringify({
      type: 'realtime',
      model: REALTIME_MODEL,
      output_modalities: ['audio'],
      audio: {
        input: { turn_detection: { type: 'semantic_vad' } },
        output: { voice: VOICE },
      },
    })
  );
  const upstream = await fetch('https://api.openai.com/v1/realtime/calls', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_KEY}` },
    body: form,
  });
  const body = await upstream.text();
  if (!upstream.ok) {
    console.error('realtime session failed', upstream.status, body.slice(0, 400));
    const invalidKey = upstream.status === 401 || upstream.status === 403;
    json(res, upstream.status, {
      error: invalidKey
        ? 'OpenAI rejected the server API key. Restart the server with a current key.'
        : 'The coach could not start a voice session.',
      code: invalidKey ? 'invalid_api_key' : 'realtime_session_failed',
    });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/sdp' });
  res.end(body);
}

async function analyze(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!OPENROUTER_KEY) {
    json(res, 503, {
      error: 'The server has no OPENROUTER_API_KEY, so takes cannot be analyzed.',
      code: 'api_key_required',
    });
    return;
  }
  let parsed: {
    wavBase64?: string;
    durationMs?: number;
    meeting?: MeetingContext;
    learnings?: string[];
    takeNumber?: number;
    previousSummary?: string;
  };
  try {
    parsed = JSON.parse((await readBody(req)).toString('utf8'));
  } catch {
    json(res, 400, { error: 'Invalid analyze request.' });
    return;
  }
  if (!parsed.wavBase64 || !parsed.meeting || !Number.isFinite(parsed.durationMs)) {
    json(res, 400, { error: 'analyze needs wavBase64, durationMs, and meeting.' });
    return;
  }
  const request: AnalyzeRequest = {
    wav: new Uint8Array(Buffer.from(parsed.wavBase64, 'base64')),
    durationMs: Number(parsed.durationMs),
    meeting: parsed.meeting,
    learnings: Array.isArray(parsed.learnings) ? parsed.learnings : [],
    takeNumber: Number.isFinite(parsed.takeNumber) ? Number(parsed.takeNumber) : undefined,
    previousSummary: typeof parsed.previousSummary === 'string' ? parsed.previousSummary : undefined,
  };
  const analyzer = new OpenRouterAnalyzer({ apiKey: OPENROUTER_KEY, model: ANALYZER_MODEL });
  try {
    const feedback = await analyzer.analyze(request);
    json(res, 200, feedback);
    // The experiment runs after the user already has their feedback — it can
    // never slow a session down, and its failure is only a log line.
    if (AB_ENABLED && OPENAI_KEY) {
      runAbExperiment(
        {
          openaiKey: OPENAI_KEY,
          openrouterKey: OPENROUTER_KEY,
          dataDir: DATA_DIR,
          textModel: process.env.COACH_AB_TEXT_MODEL,
          judgeModel: process.env.COACH_AB_JUDGE_MODEL,
        },
        { request, audioFeedback: feedback, audioModel: ANALYZER_MODEL }
      )
        .then((dir) => console.log(`ab bundle: ${dir}`))
        .catch((err: unknown) =>
          console.error('ab experiment failed:', err instanceof Error ? err.message : err)
        );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('analyze failed:', message);
    json(res, 502, { error: message });
  }
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let filePath = path.join(DIST, path.normalize(url.pathname).replace(/^([.][.][/\\])+/, ''));
  if (!filePath.startsWith(DIST)) filePath = DIST;
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(DIST, 'index.html');
  }
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Build the web app first: npm run web:build');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  const route = `${req.method} ${new URL(req.url ?? '/', 'http://localhost').pathname}`;
  const handle = async (): Promise<void> => {
    if (route === 'GET /api/status') {
      json(res, 200, {
        openai: Boolean(OPENAI_KEY),
        openrouter: Boolean(OPENROUTER_KEY),
        realtime_model: REALTIME_MODEL,
        analyzer_model: ANALYZER_MODEL,
        voice: VOICE,
      });
      return;
    }
    if (route === 'POST /api/realtime/session') return realtimeSession(req, res);
    if (route === 'POST /api/analyze') return analyze(req, res);
    if (route.startsWith('GET ')) return serveStatic(req, res);
    json(res, 405, { error: 'method not allowed' });
  };
  handle().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${route} failed:`, message);
    if (!res.headersSent) json(res, 500, { error: message });
    else res.end();
  });
});

server.listen(PORT, () => {
  console.log(`coach web relay on http://localhost:${PORT}`);
  console.log(`  openai key: ${OPENAI_KEY ? 'configured' : 'MISSING'} · openrouter key: ${OPENROUTER_KEY ? 'configured' : 'MISSING'}`);
  console.log(`  realtime: ${REALTIME_MODEL} (${VOICE}) · analyzer: ${ANALYZER_MODEL}`);
});
