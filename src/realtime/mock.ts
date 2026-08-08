import type {
  ProviderEvent,
  RealtimeProvider,
  RealtimeSessionConfig,
} from './provider';

/** Scripted provider for tests: records everything the session does to it,
 * and lets tests emit provider events by hand. */
export class MockRealtimeProvider implements RealtimeProvider {
  config?: RealtimeSessionConfig;
  instructionUpdates: string[] = [];
  toolResults: Array<{ callId: string; output: Record<string, unknown>; startResponse: boolean }> = [];
  systemNotes: Array<{ text: string; startResponse: boolean }> = [];
  sentAudioBytes = 0;
  interrupts = 0;
  closed = false;

  private handler: (event: ProviderEvent) => void = () => {};

  async connect(config: RealtimeSessionConfig): Promise<void> {
    this.config = config;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  sendUserAudio(pcm: Uint8Array): void {
    this.sentAudioBytes += pcm.length;
  }

  updateInstructions(instructions: string): void {
    this.instructionUpdates.push(instructions);
  }

  submitToolResult(
    callId: string,
    output: Record<string, unknown>,
    opts?: { startResponse?: boolean }
  ): void {
    this.toolResults.push({ callId, output, startResponse: opts?.startResponse !== false });
  }

  injectSystemNote(text: string, opts?: { startResponse?: boolean }): void {
    this.systemNotes.push({ text, startResponse: opts?.startResponse !== false });
  }

  interrupt(): void {
    this.interrupts += 1;
  }

  onEvent(handler: (event: ProviderEvent) => void): void {
    this.handler = handler;
  }

  emit(event: ProviderEvent): void {
    this.handler(event);
  }
}
