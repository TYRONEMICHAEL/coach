# Coach — a realtime voice coaching harness

A voice coach you talk to. It has a personality, durable memory about you, and
capabilities (tools). It knows the difference between *coaching you* and
*listening to you rehearse*, records your rehearsal takes, has them analyzed by
a second model, and then talks you through the feedback — "at about two minutes
in you said X; try Y" — conversationally, over live audio.

Built today on OpenAI's Realtime API and OpenRouter audio analysis. Both are
adapters behind interfaces; neither is load-bearing to the design.

## The two jobs

1. **Coaching** — the default mode. A normal back-and-forth conversation. The
   coach draws on what it has learned about you and saves new durable learnings
   as they surface.
2. **Meeting prep** — you tell it what meeting you're prepping, talk through
   framing (saved as meeting notes), and then do run-throughs. The moment you
   start actually presenting, the coach goes silent and records. When you step
   back out ("okay, how was that?"), the take goes to an analysis model and the
   feedback comes back through the coach's voice.

## The rehearsal loop

```
 you (mic) ──── pcm frames ────► RealtimeProvider (OpenAI Realtime)
      │                                │
      │  (while mode = rehearsal)     tool calls: begin_rehearsal / end_rehearsal
      ▼                                │
  Recorder ── take.wav ──► RehearsalAnalyzer (OpenRouter, audio-capable model)
                                       │
                        timestamped feedback (JSON)
                                       │
              injected back into the live conversation as a system note
                                       │
                      coach delivers it conversationally (voice)
```

- The **model itself is the mode detector.** It has `begin_rehearsal` and
  `end_rehearsal` tools and instructions for when to call them. No audio
  heuristics in the harness — detecting "he's presenting now, not talking to
  me" is a judgment call, so it belongs to the model. The harness only owns
  what must be deterministic: once `begin_rehearsal` fires, recording *is*
  happening; once `end_rehearsal` fires, it has stopped and analysis *is*
  dispatched.
- The recorder **tees the mic stream only**. The coach's own speech is never in
  the file, so analysis timestamps align exactly with the user's take.
- **Analysis never blocks the conversation.** `end_rehearsal` returns
  immediately ("captured 3m12s, analysis running"); the coach says a holding
  line and can keep talking. When the analyzer resolves, the structured
  feedback is injected as a system note and the coach picks it up mid
  conversation. Tool handlers in general run out-of-band — the model keeps
  listening and talking while the harness works.
- Feedback is also written to the meeting's file on disk, so prep artifacts
  outlive the session.

## Structure

```
src/
  types.ts                shared domain types (modes, feedback schema, audio contract)
  persona.ts              personality + instruction composer (the behavior contract)
  memory.ts               CoachMemory: learnings.md + meetings/<slug>.md, plain files
  capabilities.ts         the five tools: definitions + dispatch
  recorder.ts             pcm16 tee -> take-N.wav
  session.ts              CoachSession: the orchestrator; owns mode state
  realtime/provider.ts    RealtimeProvider interface + event types   <- seam 1
  realtime/openai.ts      OpenAI Realtime adapter (websocket)
  realtime/mock.ts        scripted provider for tests
  analysis/analyzer.ts    RehearsalAnalyzer interface + formatting   <- seam 2
  analysis/openrouter.ts  OpenRouter audio-analysis adapter
  audio/sox.ts            mic in / speaker out via sox (mac cli runtime)
  config.ts               env -> config, fail-fast on missing keys
  index.ts                cli entry: composes everything
test/                     harness logic tested against the mock provider; no network
```

### The three seams

- **`RealtimeProvider`** — a thin duplex: pcm16@24k mono in, events out
  (`audio`, `user_transcript`, `assistant_transcript`, `tool_call`,
  `user_speech_started`), plus `submitToolResult`, `injectSystemNote`,
  `updateInstructions`, `interrupt`. Everything OpenAI-specific lives in
  `realtime/openai.ts`. Swapping to another realtime vendor (or a browser
  WebRTC transport) means implementing this interface and nothing else.
- **`RehearsalAnalyzer`** — `analyze(wav, meeting context, learnings) ->
  RehearsalFeedback`. The OpenRouter adapter sends the audio to an
  audio-capable model (default `google/gemini-2.5-flash`, one env var to
  change) and parses a strict JSON shape: summary, strengths, improvements,
  and `moments[]` with seconds-offsets, the quote, a verdict, and a suggested
  sharper phrasing.
- **`CoachMemory`** — two kinds of state, deliberately separate, both plain
  markdown you can read and edit:
  - `data/learnings.md` — durable learnings about the user, one dated line
    each. Loaded into the coach's instructions every session.
  - `data/meetings/<slug>.md` — per-meeting prep: context, notes, and each
    rehearsal's feedback. Recordings sit alongside in `data/recordings/`.

### Mode state

`coaching <-> rehearsal`, held in `CoachSession`, transitions only via the
tools (or the CLI's manual fallback — press Enter if the model misses the
handoff). Rehearsal requires an active meeting: `begin_rehearsal` without one
returns an error telling the model to ask which meeting this is and call
`set_meeting` first — the coach handles it as one natural question.

### Deliberately not here (and the growth path)

- **No UI.** A CLI that needs a mic and a speaker. A browser client later is a
  second `RealtimeProvider` (WebRTC) plus the same session core.
- **No recall/search tool.** All memory currently fits in the instructions; a
  `recall` tool only earns its place when learnings outgrow the prompt.
- **No diarization, no VAD heuristics, no database.** Files and tool calls
  until something measurable demands more.
- **Session transcripts are not persisted.** Only meaningful artifacts survive:
  learnings, meeting notes, rehearsal feedback, recordings.

## Run

Needs Node 20+, `sox` (`brew install sox`), and two keys:

```bash
export OPENAI_API_KEY=...      # realtime voice
export OPENROUTER_API_KEY=...  # rehearsal analysis

npm install && npm start
```

Talk. Say what meeting you're prepping, chat through it, then just start
presenting — the coach goes quiet, records, and debriefs you when you ask how
it went. `Enter` force-ends a rehearsal; `Ctrl+C` ends the session.

Knobs (env): `COACH_MODEL` (default `gpt-realtime`), `COACH_VOICE` (`marin`),
`COACH_ANALYZER_MODEL` (`google/gemini-2.5-flash`), `COACH_DATA_DIR`
(`./data`), `COACH_NAME` (`Coach`).

Tests — the full rehearsal loop against the mock provider, no network:

```bash
npm test && npm run typecheck
```
