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
    analyzerModel: env.COACH_ANALYZER_MODEL ?? 'google/gemini-2.5-flash',
    dataDir: env.COACH_DATA_DIR ?? path.join(coachRoot, 'data'),
    coachName: env.COACH_NAME ?? 'Coach',
  };
}
