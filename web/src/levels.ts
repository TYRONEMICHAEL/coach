/** Live audio levels, written by the level engine every frame and read by
 * the wave line's draw loop. A plain mutable object keeps the audio path
 * out of React's render cycle entirely. */
export const levels = { mic: 0, voice: 0 };

export function resetLevels(): void {
  levels.mic = 0;
  levels.voice = 0;
}
