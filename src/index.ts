import * as readline from 'node:readline';
import { OpenRouterAnalyzer } from './analysis/openrouter.js';
import { assertSoxInstalled, createSpeaker, startMic } from './audio/sox.js';
import { loadConfig } from './config.js';
import { CoachMemory } from './memory.js';
import { defaultPersona } from './persona.js';
import { OpenAIRealtimeProvider } from './realtime/openai.js';
import { CoachSession } from './session.js';

async function main(): Promise<void> {
  const config = loadConfig();
  assertSoxInstalled();

  const memory = new CoachMemory(config.dataDir);
  const speaker = createSpeaker();
  const session = new CoachSession({
    provider: new OpenAIRealtimeProvider({
      apiKey: config.openaiApiKey,
      model: config.realtimeModel,
      voice: config.voice,
    }),
    analyzer: new OpenRouterAnalyzer({
      apiKey: config.openrouterApiKey,
      model: config.analyzerModel,
    }),
    memory,
    persona: { ...defaultPersona, name: config.coachName },
    voice: config.voice,
    playAudio: (pcm) => speaker.play(pcm),
    stopAudio: () => speaker.stop(),
    onTranscript: (role, text) => console.log(`${role === 'user' ? 'you' : 'coach'}: ${text}`),
    onStatus: (line) => console.log(`  [${line}]`),
  });

  await session.start();
  const stopMic = startMic((pcm) => session.sendMicAudio(pcm));

  console.log(`connected — talk to ${config.coachName}. Enter force-ends a rehearsal, Ctrl+C quits.`);
  console.log(`memory: ${config.dataDir}`);

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', () => session.endRehearsalManually());

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nending session…');
    rl.close();
    stopMic();
    speaker.close();
    await session.stop();
    await session.settleAnalyses();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
