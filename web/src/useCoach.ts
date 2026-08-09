import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CoachSession } from '../../src/session';
import { defaultPersona } from '../../src/persona';
import type { CaptureState, Mode, RehearsalFeedback } from '../../src/types';
import { BrowserClipPlayer, blessAudioElement } from './adapters/clip-player';
import { LocalCoachMemory, MEMORY_EVENT } from './adapters/local-memory';
import { MediaRecorderTake } from './adapters/media-recorder';
import { MockAnalyzer, ScriptedProvider, SyntheticTakeRecorder } from './adapters/mock';
import { RelayAnalyzer } from './adapters/relay-analyzer';
import { WebRTCRealtimeProvider } from './adapters/webrtc-provider';

export type Presence = 'idle' | 'connecting' | 'listening' | 'speaking' | 'recording' | 'thinking' | 'error';

export interface TranscriptLine {
  role: 'user' | 'coach';
  text: string;
}

export interface ServerStatus {
  openai: boolean;
  openrouter: boolean;
  realtime_model?: string;
  analyzer_model?: string;
}

const params = new URLSearchParams(window.location.search);
export const MOCK_MODE = params.has('mock');
export const DEBUG_MODE = params.has('debug');
export const COACH_NAME = params.get('name') || defaultPersona.name;

export const memory = new LocalCoachMemory();

const GREETING =
  'The user just opened the app and can hear you. Open per "How you open" — one or two sentences in your own voice, then stop and listen.';

// One AudioContext for the page's lifetime. createMediaElementSource can
// only ever be called once per element, and closing a context strands the
// element — so the graph persists and is suspended between sessions.
type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };
let sharedCtx: AudioContext | null = null;
const elementSources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();

function getSharedCtx(): AudioContext | null {
  if (sharedCtx) return sharedCtx;
  const AudioContextClass = window.AudioContext || (window as WebkitWindow).webkitAudioContext;
  if (!AudioContextClass) return null;
  sharedCtx = new AudioContextClass();
  return sharedCtx;
}

interface LevelEngine {
  raf: number;
  stop: () => void;
}

export function useCoach() {
  const [phase, setPhase] = useState<'idle' | 'connecting' | 'live' | 'error'>('idle');
  const [mode, setMode] = useState<Mode>('coaching');
  const [capture, setCapture] = useState<CaptureState>('idle');
  const [speaking, setSpeaking] = useState(false);
  const [analysisPending, setAnalysisPending] = useState(false);
  const [progressMessage, setProgressMessage] = useState('');
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState('');
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [tapRetry, setTapRetry] = useState<(() => void) | null>(null);
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null);
  const [memoryVersion, setMemoryVersion] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [demoFeedback, setDemoFeedback] = useState<RehearsalFeedback | null>(null);
  const [demoLog, setDemoLog] = useState<string[]>([]);

  const sessionRef = useRef<CoachSession | null>(null);
  const providerRef = useRef<ScriptedProvider | null>(null);
  const micRef = useRef<MediaStream | null>(null);
  const playerRef = useRef<BrowserClipPlayer | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const clipAudioRef = useRef<HTMLAudioElement | null>(null);
  const presenceRef = useRef<HTMLDivElement | null>(null);
  const levelsRef = useRef<LevelEngine | null>(null);
  const takeTimerRef = useRef<number | null>(null);
  const speakingDropRef = useRef<number | null>(null);
  const modeRef = useRef<Mode>('coaching');
  const mutedRef = useRef(false);

  useEffect(() => {
    if (!MOCK_MODE) {
      fetch('/api/status')
        .then((response) => response.json())
        .then((value: ServerStatus) => setServerStatus(value))
        .catch(() => setServerStatus({ openai: false, openrouter: false }));
    }
    const onMemory = () => setMemoryVersion((v) => v + 1);
    window.addEventListener(MEMORY_EVENT, onMemory);
    return () => window.removeEventListener(MEMORY_EVENT, onMemory);
  }, []);

  const pushStatus = useCallback((line: string) => {
    setStatuses((lines) => [line, ...lines].slice(0, 40));
  }, []);

  const duck = useCallback((on: boolean) => {
    const track = micRef.current?.getAudioTracks()[0];
    if (track) track.enabled = on ? false : !mutedRef.current;
    const remote = remoteAudioRef.current;
    if (remote) remote.muted = on || modeRef.current === 'rehearsal';
  }, []);

  /** Voices become motion: mic and coach levels stream into the presence
   * orb as CSS variables, outside React's render loop. */
  const startLevels = useCallback(() => {
    if (levelsRef.current) return;
    const ctx = getSharedCtx();
    if (!ctx) return;
    void ctx.resume().catch(() => undefined);
    const micAnalyser = ctx.createAnalyser();
    micAnalyser.fftSize = 512;
    const voiceAnalyser = ctx.createAnalyser();
    voiceAnalyser.fftSize = 512;
    const sessionNodes: AudioNode[] = [];
    if (micRef.current) {
      try {
        const source = ctx.createMediaStreamSource(micRef.current);
        source.connect(micAnalyser);
        sessionNodes.push(source);
      } catch {
        // no mic level — the orb still breathes on its own
      }
    }
    // The clip element joins the graph once, forever: replaying the user's
    // take animates the orb exactly like a live voice.
    const clipElement = clipAudioRef.current;
    if (clipElement) {
      try {
        let clipSource = elementSources.get(clipElement);
        if (!clipSource) {
          clipSource = ctx.createMediaElementSource(clipElement);
          clipSource.connect(ctx.destination);
          elementSources.set(clipElement, clipSource);
        }
        clipSource.connect(voiceAnalyser);
        sessionNodes.push(clipSource);
      } catch {
        // replay still audible through the element's default path
      }
    }
    let voiceConnected = false;
    const micData = new Uint8Array(micAnalyser.fftSize);
    const voiceData = new Uint8Array(voiceAnalyser.fftSize);
    let mic = 0;
    let voice = 0;
    const rms = (analyser: AnalyserNode, data: Uint8Array<ArrayBuffer>): number => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i += 1) {
        const v = ((data[i] ?? 128) - 128) / 128;
        sum += v * v;
      }
      return Math.sqrt(sum / data.length);
    };
    const engine: LevelEngine = {
      raf: 0,
      stop: () => {
        cancelAnimationFrame(engine.raf);
        for (const node of sessionNodes) {
          try {
            if (node instanceof MediaElementAudioSourceNode) node.disconnect(voiceAnalyser);
            else node.disconnect();
          } catch {
            // already disconnected
          }
        }
        void ctx.suspend().catch(() => undefined);
        const el = presenceRef.current;
        if (el) {
          el.style.setProperty('--mic', '0');
          el.style.setProperty('--voice', '0');
        }
      },
    };
    const loop = () => {
      if (!voiceConnected) {
        const src = remoteAudioRef.current?.srcObject;
        if (src instanceof MediaStream && src.getAudioTracks().length > 0) {
          try {
            const source = ctx.createMediaStreamSource(src);
            source.connect(voiceAnalyser);
            sessionNodes.push(source);
            voiceConnected = true;
          } catch {
            voiceConnected = true; // do not retry every frame
          }
        }
      }
      // Fast attack, slow decay — the orb catches consonants, settles softly.
      mic = Math.max(rms(micAnalyser, micData), mic * 0.88);
      voice = Math.max(rms(voiceAnalyser, voiceData), voice * 0.88);
      const el = presenceRef.current;
      if (el) {
        el.style.setProperty('--mic', Math.min(1, mic * 5).toFixed(3));
        el.style.setProperty('--voice', Math.min(1, voice * 5).toFixed(3));
      }
      engine.raf = requestAnimationFrame(loop);
    };
    engine.raf = requestAnimationFrame(loop);
    levelsRef.current = engine;
  }, []);

  const stopLevels = useCallback(() => {
    levelsRef.current?.stop();
    levelsRef.current = null;
  }, []);

  const stopTakeTimer = useCallback(() => {
    if (takeTimerRef.current !== null) {
      window.clearInterval(takeTimerRef.current);
      takeTimerRef.current = null;
    }
    setElapsed(0);
  }, []);

  const setSpeakingSmoothed = useCallback((next: boolean) => {
    if (speakingDropRef.current !== null) {
      window.clearTimeout(speakingDropRef.current);
      speakingDropRef.current = null;
    }
    if (next) {
      setSpeaking(true);
      return;
    }
    // Responses arrive in bursts; a hard drop between sentences flickers.
    speakingDropRef.current = window.setTimeout(() => setSpeaking(false), 550);
  }, []);

  const begin = useCallback(async () => {
    setError('');
    setPhase('connecting');
    setTranscript([]);

    // Everything audio-blessed must happen NOW, synchronously inside the
    // tap, before the first await — this is what makes replay touch-free.
    const remoteAudio = remoteAudioRef.current;
    const clipAudio = clipAudioRef.current;
    if (!clipAudio || !remoteAudio) {
      setError('Audio elements are not ready.');
      setPhase('error');
      return;
    }
    const player = new BrowserClipPlayer({
      element: clipAudio,
      duck,
      onNeedsTap: (retry) => setTapRetry(() => retry),
    });
    player.unlock();
    blessAudioElement(remoteAudio);
    playerRef.current = player;
    void getSharedCtx()?.resume().catch(() => undefined);

    try {
      if (!MOCK_MODE) {
        const status = (await fetch('/api/status')
          .then((r) => r.json())
          .catch(() => ({ openai: false, openrouter: false }))) as ServerStatus;
        setServerStatus(status);
        if (!status.openai) {
          throw new Error(
            'The relay has no OpenAI key. Start it with OPENAI_API_KEY set — or open ?mock=1 for the keyless demo.'
          );
        }
      }

      let stream: MediaStream | null = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        });
      } catch {
        if (!MOCK_MODE) throw new Error('The coach needs the microphone. Allow mic access and try again.');
      }
      micRef.current = stream;

      const recorder = stream ? new MediaRecorderTake(() => micRef.current) : new SyntheticTakeRecorder();

      const provider = MOCK_MODE
        ? new ScriptedProvider({
            onCoachLine: () => {
              setSpeaking(true);
              window.setTimeout(() => setSpeaking(false), 1400);
            },
            onNote: (text) => setDemoLog((log) => [`system note → ${text.split('\n')[0] ?? ''}`, ...log].slice(0, 12)),
            onToolResult: (name, output) =>
              setDemoLog((log) => [`${name} → ${JSON.stringify(output).slice(0, 110)}`, ...log].slice(0, 12)),
          })
        : new WebRTCRealtimeProvider({
            stream: stream as MediaStream,
            audioElement: remoteAudio,
            onActivity: (state) => setSpeakingSmoothed(state === 'speaking'),
          });
      if (MOCK_MODE) providerRef.current = provider as ScriptedProvider;

      const analyzer = MOCK_MODE
        ? new MockAnalyzer((feedback) => setDemoFeedback(feedback))
        : new RelayAnalyzer((message) => setProgressMessage(message));

      const session = new CoachSession({
        provider,
        analyzer,
        memory,
        recorder,
        player,
        persona: { ...defaultPersona, name: COACH_NAME.replace(' (demo)', '') },
        greeting: MOCK_MODE ? undefined : GREETING,
        onTranscript: (role, text) =>
          setTranscript((lines) => [...lines, { role, text }].slice(-8)),
        onStatus: pushStatus,
        onModeChange: (next) => {
          modeRef.current = next;
          setMode(next);
          const remote = remoteAudioRef.current;
          // The browser body's silence guarantee: the coach's audio path is
          // physically muted while a take is running.
          if (remote) remote.muted = next === 'rehearsal';
        },
        onCaptureChange: (state) => {
          setCapture(state);
          if (state === 'recording') {
            const startedAt = Date.now();
            setElapsed(0);
            takeTimerRef.current = window.setInterval(
              () => setElapsed(Math.floor((Date.now() - startedAt) / 1000)),
              1000
            );
          } else {
            stopTakeTimer();
          }
        },
        onAnalysis: (state) => {
          setAnalysisPending(state === 'started');
          if (state !== 'started') setProgressMessage('');
        },
      });
      sessionRef.current = session;
      await session.start();
      startLevels();
      setPhase('live');
      if (MOCK_MODE) {
        setDemoLog(['demo connected — drive the loop with the panel below']);
      }
    } catch (caught) {
      micRef.current?.getTracks().forEach((track) => track.stop());
      micRef.current = null;
      setError(caught instanceof Error ? caught.message : 'The coach could not start.');
      setPhase('error');
    }
  }, [duck, pushStatus, setSpeakingSmoothed, startLevels, stopTakeTimer]);

  const end = useCallback(async () => {
    await sessionRef.current?.stop().catch(() => undefined);
    sessionRef.current = null;
    providerRef.current = null;
    micRef.current?.getTracks().forEach((track) => track.stop());
    micRef.current = null;
    playerRef.current?.dispose();
    playerRef.current = null;
    stopLevels();
    stopTakeTimer();
    if (speakingDropRef.current !== null) window.clearTimeout(speakingDropRef.current);
    setPhase('idle');
    setMode('coaching');
    setCapture('idle');
    modeRef.current = 'coaching';
    setSpeaking(false);
    setAnalysisPending(false);
    setMuted(false);
    mutedRef.current = false;
    setTapRetry(null);
    setTranscript([]);
    setDemoFeedback(null);
    setDemoLog([]);
  }, [stopLevels, stopTakeTimer]);

  const toggleMute = useCallback(() => {
    setMuted((current) => {
      const next = !current;
      mutedRef.current = next;
      micRef.current?.getAudioTracks().forEach((track) => {
        track.enabled = !next;
      });
      return next;
    });
  }, []);

  const finishTake = useCallback(() => {
    sessionRef.current?.endRehearsalManually();
  }, []);

  const playPendingExcerpt = useCallback(() => {
    // Nothing may run before the retry: Safari must see play() inside the tap.
    const retry = tapRetry;
    setTapRetry(null);
    retry?.();
  }, [tapRetry]);

  const presence: Presence = useMemo(() => {
    if (phase === 'idle') return 'idle';
    if (phase === 'connecting') return 'connecting';
    if (phase === 'error') return 'error';
    if (capture === 'recording') return 'recording';
    if (speaking) return 'speaking';
    if (capture === 'finalizing' || capture === 'analyzing' || analysisPending) return 'thinking';
    return 'listening';
  }, [phase, capture, speaking, analysisPending]);

  return {
    phase,
    presence,
    mode,
    capture,
    muted,
    error,
    transcript,
    statuses,
    serverStatus,
    progressMessage,
    analysisPending,
    memoryVersion,
    elapsed,
    tapPending: tapRetry !== null,
    demo: MOCK_MODE
      ? { provider: providerRef, feedback: demoFeedback, log: demoLog }
      : null,
    remoteAudioRef,
    clipAudioRef,
    presenceRef,
    begin,
    end,
    toggleMute,
    finishTake,
    playPendingExcerpt,
  };
}
