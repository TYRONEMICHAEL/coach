import * as readline from 'node:readline';
import { OpenRouterAnalyzer } from './analysis/openrouter';
import { assertSoxInstalled, createSpeaker, SoxExcerptPlayer, startMic } from './audio/sox';
import { loadConfig } from './config';
import { defaultPersona } from './persona';
import { FileCoachMemory } from './node/memory';
import { PcmTakeRecorder } from './recorder';
import { OpenAIRealtimeProvider } from './realtime/openai';
import { CoachSession } from './session';

async function main(): Promise<void> {
  const config = loadConfig();
  assertSoxInstalled();

  const memory = new FileCoachMemory(config.dataDir);
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
    recorder: new PcmTakeRecorder(),
    player: new SoxExcerptPlayer(),
    persona: { ...defaultPersona, name: config.coachName },
    voice: config.voice,
    greeting:
      'The user just joined the session and can hear you. Open per "How you open" — one or two sentences, then stop.',
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
