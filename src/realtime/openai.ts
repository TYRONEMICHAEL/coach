import WebSocket from 'ws';
import { SAMPLE_RATE } from '../types.js';
import type {
  ProviderEvent,
  RealtimeProvider,
  RealtimeSessionConfig,
} from './provider.js';

export interface OpenAIRealtimeOptions {
  apiKey: string;
  /** e.g. "gpt-realtime" */
  model: string;
  voice?: string;
  transcriptionModel?: string;
  url?: string;
}

/**
 * OpenAI Realtime API over websocket. Speaks the GA event shapes and
 * tolerates the older beta names on receive, since the two differ only in
 * naming for everything this harness consumes.
 */
export class OpenAIRealtimeProvider implements RealtimeProvider {
  private ws?: WebSocket;
  private handler: (event: ProviderEvent) => void = () => {};
  private responseInFlight = false;
  /** call_id -> tool name, learned from function_call items as they appear. */
  private callNames = new Map<string, string>();

  constructor(private readonly opts: OpenAIRealtimeOptions) {}

  onEvent(handler: (event: ProviderEvent) => void): void {
    this.handler = handler;
  }

  private emit(event: ProviderEvent): void {
    this.handler(event);
  }

  async connect(config: RealtimeSessionConfig): Promise<void> {
    const base = this.opts.url ?? 'wss://api.openai.com/v1/realtime';
    const ws = new WebSocket(`${base}?model=${encodeURIComponent(this.opts.model)}`, {
      headers: { Authorization: `Bearer ${this.opts.apiKey}` },
    });
    this.ws = ws;

    ws.on('message', (data) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(data.toString());
      } catch {
        return;
      }
      this.onServerEvent(event);
    });
    ws.on('close', (_code, reason) => this.emit({ type: 'closed', reason: reason.toString() }));

    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (err) => reject(err));
    });
    // Errors after connect are events, not exceptions.
    ws.on('error', (err) => this.emit({ type: 'error', message: err.message }));

    this.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        model: this.opts.model,
        instructions: config.instructions,
        tools: config.tools.map((t) => ({
          type: 'function',
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
        tool_choice: 'auto',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: SAMPLE_RATE },
            transcription: { model: this.opts.transcriptionModel ?? 'gpt-4o-mini-transcribe' },
            turn_detection: { type: 'semantic_vad' },
          },
          output: {
            format: { type: 'audio/pcm', rate: SAMPLE_RATE },
            voice: config.voice ?? this.opts.voice ?? 'marin',
          },
        },
      },
    });
  }

  async close(): Promise<void> {
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1500);
      ws.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.close();
    });
  }

  sendUserAudio(pcm: Buffer): void {
    this.send({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') });
  }

  updateInstructions(instructions: string): void {
    this.send({ type: 'session.update', session: { type: 'realtime', instructions } });
  }

  submitToolResult(
    callId: string,
    output: Record<string, unknown>,
    opts?: { startResponse?: boolean }
  ): void {
    this.send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(output) },
    });
    if (opts?.startResponse !== false) this.send({ type: 'response.create' });
  }

  injectSystemNote(text: string, opts?: { startResponse?: boolean }): void {
    this.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'system', content: [{ type: 'input_text', text }] },
    });
    if (opts?.startResponse !== false) this.send({ type: 'response.create' });
  }

  interrupt(): void {
    if (this.responseInFlight) this.send({ type: 'response.cancel' });
  }

  private send(payload: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }

  private onServerEvent(e: Record<string, unknown>): void {
    const type = String(e.type ?? '');
    switch (type) {
      case 'response.created':
        this.responseInFlight = true;
        break;
      case 'response.done':
        this.responseInFlight = false;
        break;

      case 'response.output_audio.delta': // GA
      case 'response.audio.delta': { // beta
        if (typeof e.delta === 'string') this.emit({ type: 'audio', pcm: Buffer.from(e.delta, 'base64') });
        break;
      }

      case 'response.output_audio_transcript.done': // GA
      case 'response.audio_transcript.done': { // beta
        if (typeof e.transcript === 'string' && e.transcript.trim() !== '')
          this.emit({ type: 'assistant_transcript', text: e.transcript.trim() });
        break;
      }

      case 'conversation.item.input_audio_transcription.completed': {
        if (typeof e.transcript === 'string' && e.transcript.trim() !== '')
          this.emit({ type: 'user_transcript', text: e.transcript.trim() });
        break;
      }

      case 'input_audio_buffer.speech_started':
        this.emit({ type: 'user_speech_started' });
        break;

      case 'conversation.item.added': // GA
      case 'conversation.item.created': { // beta
        const item = e.item as Record<string, unknown> | undefined;
        if (item?.type === 'function_call' && typeof item.call_id === 'string' && typeof item.name === 'string')
          this.callNames.set(item.call_id, item.name);
        break;
      }

      case 'response.function_call_arguments.done': {
        const callId = typeof e.call_id === 'string' ? e.call_id : undefined;
        if (!callId) break;
        const name = typeof e.name === 'string' ? e.name : this.callNames.get(callId);
        if (!name) break;
        this.emit({ type: 'tool_call', callId, name, args: parseArgs(e.arguments) });
        break;
      }

      case 'error': {
        const err = e.error as Record<string, unknown> | undefined;
        this.emit({ type: 'error', message: String(err?.message ?? 'unknown realtime error') });
        break;
      }

      default:
        break;
    }
  }
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
