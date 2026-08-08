# Coach — a realtime voice coaching harness

A voice coach you talk to. It has a personality, durable memory about you, and
capabilities (tools). It knows the difference between *coaching you* and
*listening to you rehearse*, records your rehearsal takes, has them analyzed by
a second model that hears the audio (not a transcript), and then talks you
through the feedback — and **plays the exact moment back to you**: "listen to
this — now here's the sharper version."

Built today on OpenAI's Realtime API and OpenRouter audio analysis. Both are
adapters behind interfaces; neither is load-bearing to the design.

## One brain, many bodies

The session core (`src/`) is platform-neutral TypeScript: no Node APIs, no DOM
in the brain. Each surface is a thin set of adapters around the same core:

| Body | Transport | Recorder | Replay | Memory |
|---|---|---|---|---|
| **CLI** (`npm start`) | websocket + sox | PCM tee | sox trim | markdown files in `data/` |
| **Web** (`web/`) | WebRTC via relay | MediaRecorder → WAV | `<audio>` clip player | localStorage |
| **iOS** (the path) | react-native-webrtc or WS | AVAudioEngine/expo-av | AVPlayer slice | files + iCloud |

The iOS app is the same brain again: React Native/Expo imports `src/` verbatim
(it is bundler-clean by construction), and the four adapters above are the
whole port. Nothing in the product logic gets rewritten to ship the app.

## The two jobs

1. **Coaching** — the default mode. A normal back-and-forth conversation. The
   coach draws on what it has learned about you and proposes new durable
   learnings as they surface — but the harness decides what is kept (below).
2. **Meeting prep** — you tell it what meeting you're prepping, talk through
   framing (saved as meeting notes), and then do run-throughs. The moment you
   start actually presenting, the coach goes silent and records. When you step
   back out ("okay, how was that?"), the take goes to the analyzer and the
   feedback comes back through the coach's voice — with replayable evidence.

## The rehearsal loop

```
 you (mic) ─────────────────────► RealtimeProvider (OpenAI Realtime)
      │                                │
      │  (while mode = rehearsal)     tool calls: begin_rehearsal / end_rehearsal
      ▼                                │
 TakeRecorder ── take WAV ──► RehearsalAnalyzer (OpenRouter, hears the audio)
      │                                │
      │            one strength · one priority · replayable clips (JSON)
      │                                │
      │        injected back into the live conversation as a system note
      │                                │
      ▼                                ▼
 ExcerptPlayer ◄── play_excerpt ── coach delivers it conversationally (voice)
   "hear the exact moment" ──► then the coach says the sharper version
```

- The **model itself is the mode detector.** It has `begin_rehearsal` and
  `end_rehearsal` tools and instructions for when to call them. No audio
  heuristics in the harness — detecting "he's presenting now, not talking to
  me" is a judgment call, so it belongs to the model. The harness owns what
  must be deterministic: once `begin_rehearsal` fires, recording *is*
  happening (and the tool result suppresses any spoken reply — silence starts
  deterministically); once `end_rehearsal` fires, recording has stopped and
  analysis *is* dispatched.
- **The coach is physically silent during a take.** The CLI refuses to play
  leaked model speech in rehearsal mode; the web body mutes the coach's audio
  element on the same mode transition. Never a matter of model discipline.
- Only the **mic** is recorded — never the coach's voice — so analysis
  timestamps align exactly with the user's take, and cited clips replay
  exactly what the analyzer heard.
- **Analysis never blocks the conversation.** `end_rehearsal` returns
  immediately ("captured 3m12s, analysis running"); the coach says a holding
  line and keeps talking. When the analyzer resolves, structured feedback is
  injected as a system note and the coach picks it up mid-conversation.
- **Feedback is one strength and one priority** — with clips, a correction,
  and a sub-minute drill — never a report. The analyzer must localize each
  clip precisely or return none: invented timestamps are a schema violation,
  and clips are clamped to the take's real duration.

## The memory gate — the model proposes, the harness decides

`remember` doesn't write memory; it *proposes* (`src/gate.ts` decides):

| Proposal | Decision |
|---|---|
| test / setup chatter | **ignored** |
| sensitive, unconfirmed | **confirm first** (the coach asks naturally) |
| low confidence, unconfirmed | **confirm first** |
| explicit user statement | **saved** |
| repeated pattern, or matches a held candidate | **saved** (promotion) |
| a single inference | **candidate** — held until repeated |

Deterministic, readable, tested. What the coach knows about you is a policy
you can audit, not a model's whim. Learnings feed both the live instructions
and the analyzer's context, so a polluted memory would poison everything —
that's why the gate exists.

## Structure

```
src/                      the brain — platform-neutral
  types.ts                domain types + the audio contract (pcm16 mono 24k)
  session.ts              CoachSession: modes, take lifecycle, gate, replay
  gate.ts                 the memory gate: decideMemory + overlap matching
  capabilities.ts         the six tools: definitions + dispatch
  persona.ts              personality + instruction composer
  memory.ts               CoachMemory interface + shared helpers
  recorder.ts             PcmTakeRecorder + WAV encode (pure)
  analysis/analyzer.ts    analyzer seam: listening brief, parse, note format
  analysis/openrouter.ts  OpenRouter adapter (server-side only, has timeout)
  realtime/provider.ts    RealtimeProvider seam + event grammar
  realtime/openai.ts      websocket adapter (CLI)
  realtime/mock.ts        scripted provider for tests
  node/memory.ts          markdown-file memory (CLI body)
  audio/sox.ts            mic/speaker + excerpt replay via sox (CLI body)
  config.ts               env -> config, fail-fast (CLI body)
  index.ts                CLI entry: composes the Mac body
web/                      the web body
  server.ts               zero-dep relay: SDP exchange + analyze (keys stay here)
  src/adapters/           WebRTC provider · MediaRecorder take · clip player ·
                          localStorage memory · relay analyzer · demo mode
  src/App.tsx, useCoach.ts, coach.css
test/                     the full loop against the mock provider; no network
```

## Run the CLI (Mac)

Needs Node 20+, `sox` (`brew install sox`), and two keys:

```bash
export OPENAI_API_KEY=...      # realtime voice
export OPENROUTER_API_KEY=...  # rehearsal analysis
npm install && npm start
```

Talk. Say what meeting you're prepping, chat through it, then just start
presenting — the coach goes quiet, records, and debriefs you when you ask how
it went, replaying the cited moments through your speakers. `Enter`
force-ends a rehearsal; `Ctrl+C` ends the session.

## Run the web app

```bash
npm install && (cd web && npm install)
npm run web:build
OPENAI_API_KEY=... OPENROUTER_API_KEY=... npm run web:serve   # http://localhost:8787
```

Dev loop: `npm run web:serve` in one terminal, `npm run web:dev` in another
(Vite proxies `/api` to the relay). The browser never sees a key: the relay
exchanges WebRTC SDP with OpenAI and runs analysis server-side.

**Demo mode — no keys:** open `http://localhost:8787/?mock=1`. Same session
core, gate, recorder, and clip player, driven by a scripted panel instead of
OpenAI. With mic permission the take records and replays *your actual voice*.
`?debug=1` shows harness events; `?name=Marguerite` renames the coach.

Knobs (env): `COACH_MODEL` (`gpt-realtime`), `COACH_VOICE` (`marin`),
`COACH_ANALYZER_MODEL` (`thinkingmachines/inkling-small`), `COACH_DATA_DIR`
(`./data`), `COACH_NAME` (`Coach`), `PORT` (web relay, `8787`).

### Why inkling-small is the default analyzer

Controlled sample, 2026-08-08: the same 3-second pure-tone WAV (no speech)
through both models, identical prompt. `google/gemini-2.5-flash` called it a
real rehearsal, fabricated a verbatim "quote", an upward inflection, and a
coaching priority. `thinkingmachines/inkling-small` returned "mic check —
only electronic beeps, zero spoken content" and no priority. The product's
promise is *grounded* evidence; the default follows the evidence. Flip
`COACH_ANALYZER_MODEL` to run the comparison yourself.

## Tests

The full rehearsal loop, the gate, replay clamping, and failure paths run
against the mock provider — no network:

```bash
npm test && npm run typecheck && (cd web && npm run typecheck)
```

## Deliberately not here (and the growth path)

- **No recall/search tool.** All memory currently fits in the instructions; a
  `recall` tool earns its place when learnings outgrow the prompt.
- **No accounts, no hosted deployment.** The relay is single-user by design;
  hosting it for more than you means ephemeral tokens and auth first.
- **No diarization, no VAD heuristics, no database.** Files and tool calls
  until something measurable demands more.
- **Session transcripts are not persisted.** Only meaningful artifacts
  survive: learnings, meeting notes, rehearsal feedback, recordings (CLI).
- **iOS next**: a React Native/Expo body reusing `src/` — see the table up top.
