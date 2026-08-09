import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface CoachConfig {
  openaiApiKey: string;
  openrouterApiKey: string;
  realtimeModel: string;
  voice: string;
  analyzerModel: string;
  dataDir: string;
  coachName: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CoachConfig {
  const missing = ['OPENAI_API_KEY', 'OPENROUTER_API_KEY'].filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(
      `missing ${missing.join(' and ')} — realtime voice needs OPENAI_API_KEY, rehearsal analysis needs OPENROUTER_API_KEY`
    );
  }
  const coachRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  return {
    openaiApiKey: env.OPENAI_API_KEY as string,
    openrouterApiKey: env.OPENROUTER_API_KEY as string,
    realtimeModel: env.COACH_MODEL ?? 'gpt-realtime',
    voice: env.COACH_VOICE ?? 'marin',
    // inkling-small over gemini-flash by evidence, not vibes: on a pure-tone
    // control take (2026-08-08), gemini fabricated a verbatim "quote" and a
    // coaching priority; inkling correctly returned "mic check, no speech".
    analyzerModel: env.COACH_ANALYZER_MODEL ?? 'thinkingmachines/inkling-small',
    dataDir: env.COACH_DATA_DIR ?? path.join(coachRoot, 'data'),
    coachName: env.COACH_NAME ?? 'Marguerite',
  };
}
