import type {
  ProviderEvent,
  RealtimeProvider,
  RealtimeSessionConfig,
} from '../../../src/realtime/provider';

export interface WebRTCProviderOptions {
  /** The user's mic stream — the browser owns it; WebRTC carries it natively. */
  stream: MediaStream;
  /** Where the coach's voice plays. The shell mutes this during rehearsals. */
  audioElement: HTMLAudioElement;
  /** Relay endpoint that exchanges SDP with OpenAI using the server key. */
  sessionUrl?: string;
  /** UI nicety: response lifecycle for the presence animation. */
  onActivity?: (state: 'speaking' | 'idle') => void;
}

/**
 * Seam 1, browser edition: OpenAI Realtime over WebRTC. The mic and the
 * coach's voice travel as media tracks (so sendUserAudio is a no-op), and
 * the same data-channel event grammar the websocket adapter speaks is
 * translated into ProviderEvents here.
 */
export class WebRTCRealtimeProvider implements RealtimeProvider {
  private pc?: RTCPeerConnection;
  private channel?: RTCDataChannel;
  private handler: (event: ProviderEvent) => void = () => {};
  private responseInFlight = false;
  /** call_id -> tool name, learned from function_call items as they appear. */
  private readonly callNames = new Map<string, string>();

  constructor(private readonly opts: WebRTCProviderOptions) {}

  onEvent(handler: (event: ProviderEvent) => void): void {
    this.handler = handler;
  }

  private emit(event: ProviderEvent): void {
    this.handler(event);
  }

  async connect(config: RealtimeSessionConfig): Promise<void> {
    const pc = new RTCPeerConnection();
    this.pc = pc;
    for (const track of this.opts.stream.getTracks()) pc.addTrack(track, this.opts.stream);
    pc.ontrack = (event) => {
      const stream = event.streams[0];
      if (!stream) return;
      this.opts.audioElement.srcObject = stream;
      void this.opts.audioElement.play().catch(() => undefined);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        this.emit({ type: 'closed', reason: `connection ${pc.connectionState}` });
      }
    };

    const channel = pc.createDataChannel('oai-events');
    this.channel = channel;
    channel.onmessage = (event) => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }
      this.onServerEvent(parsed);
    };
    const open = new Promise<void>((resolve, reject) => {
      channel.onopen = () => resolve();
      channel.onerror = () => reject(new Error('The voice data channel failed to open.'));
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const response = await fetch(this.opts.sessionUrl ?? '/api/realtime/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: offer.sdp ?? '',
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(payload.error || 'The coach could not start a voice session.');
    }
    await pc.setRemoteDescription({ type: 'answer', sdp: await response.text() });
    await open;

    // The relay created a bare session; the behavior contract is applied
    // here, through the same session.update the websocket adapter uses.
    this.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: config.instructions,
        tools: config.tools.map((t) => ({
          type: 'function',
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
        tool_choice: 'auto',
      },
    });
  }

  async close(): Promise<void> {
    this.channel?.close();
    this.pc?.close();
    this.channel = undefined;
    this.pc = undefined;
  }

  /** WebRTC carries the mic natively; PCM frames are not our transport. */
  sendUserAudio(_pcm: Uint8Array): void {}

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
    if (this.channel?.readyState === 'open') this.channel.send(JSON.stringify(payload));
  }

  private onServerEvent(e: Record<string, unknown>): void {
    const type = String(e.type ?? '');
    switch (type) {
      case 'response.created':
        this.responseInFlight = true;
        this.opts.onActivity?.('speaking');
        break;
      case 'response.done':
        this.responseInFlight = false;
        this.opts.onActivity?.('idle');
        break;

      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done': {
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

      case 'conversation.item.added':
      case 'conversation.item.created': {
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
