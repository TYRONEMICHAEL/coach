// Seam 1: the realtime transport. The coach core talks only to this
// interface; everything vendor-specific lives in an adapter beside it.
//
// Audio contract, both directions: 16-bit signed PCM, mono, 24 kHz
// (SAMPLE_RATE in types.ts). Adapters resample internally if their wire
// format differs.

export interface RealtimeTool {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

export interface RealtimeSessionConfig {
  instructions: string;
  tools: RealtimeTool[];
  voice?: string;
}

export type ProviderEvent =
  | { type: 'audio'; pcm: Buffer }
  | { type: 'user_speech_started' }
  | { type: 'user_transcript'; text: string }
  | { type: 'assistant_transcript'; text: string }
  | { type: 'tool_call'; callId: string; name: string; args: Record<string, unknown> }
  | { type: 'error'; message: string }
  | { type: 'closed'; reason?: string };

export interface RealtimeProvider {
  connect(config: RealtimeSessionConfig): Promise<void>;
  close(): Promise<void>;

  /** Stream a frame of the user's mic audio. Safe to call continuously. */
  sendUserAudio(pcm: Buffer): void;

  /** Replace the session instructions (used when memory or mode context changes). */
  updateInstructions(instructions: string): void;

  /**
   * Answer a tool_call. Handlers run out-of-band in the harness, so the model
   * keeps listening and talking while work is in flight. startResponse
   * (default true) asks the model to speak once the result lands.
   */
  submitToolResult(
    callId: string,
    output: Record<string, unknown>,
    opts?: { startResponse?: boolean }
  ): void;

  /**
   * Push out-of-band information into the conversation (e.g. a finished
   * rehearsal analysis) as a system note the model can act on.
   */
  injectSystemNote(text: string, opts?: { startResponse?: boolean }): void;

  /** Cancel the in-flight response, if any (barge-in support). */
  interrupt(): void;

  onEvent(handler: (event: ProviderEvent) => void): void;
}
