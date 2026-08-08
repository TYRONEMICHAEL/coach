import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CoachSession } from '../../src/session';
import { defaultPersona } from '../../src/persona';
import type { Mode, RehearsalFeedback } from '../../src/types';
import { BrowserClipPlayer } from './adapters/clip-player';
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
export const COACH_NAME = params.get('name') || (MOCK_MODE ? 'Coach (demo)' : 'Coach');

export const memory = new LocalCoachMemory();

export function useCoach() {
  const [phase, setPhase] = useState<'idle' | 'connecting' | 'live' | 'error'>('idle');
  const [mode, setMode] = useState<Mode>('coaching');
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
  const [demoFeedback, setDemoFeedback] = useState<RehearsalFeedback | null>(null);
  const [demoLog, setDemoLog] = useState<string[]>([]);

  const sessionRef = useRef<CoachSession | null>(null);
  const providerRef = useRef<ScriptedProvider | null>(null);
  const micRef = useRef<MediaStream | null>(null);
  const playerRef = useRef<BrowserClipPlayer | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const clipAudioRef = useRef<HTMLAudioElement | null>(null);
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

  const begin = useCallback(async () => {
    setError('');
    setPhase('connecting');
    setTranscript([]);
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

      const remoteAudio = remoteAudioRef.current;
      const clipAudio = clipAudioRef.current;
      if (!clipAudio || !remoteAudio) throw new Error('Audio elements are not ready.');

      const player = new BrowserClipPlayer({
        element: clipAudio,
        duck,
        onNeedsTap: (retry) => setTapRetry(() => retry),
      });
      playerRef.current = player;

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
            onActivity: (state) => setSpeaking(state === 'speaking'),
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
        onAnalysis: (state) => {
          setAnalysisPending(state === 'started');
          if (state !== 'started') setProgressMessage('');
        },
      });
      sessionRef.current = session;
      await session.start();
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
  }, [duck, pushStatus]);

  const end = useCallback(async () => {
    await sessionRef.current?.stop().catch(() => undefined);
    sessionRef.current = null;
    providerRef.current = null;
    micRef.current?.getTracks().forEach((track) => track.stop());
    micRef.current = null;
    playerRef.current?.dispose();
    playerRef.current = null;
    setPhase('idle');
    setMode('coaching');
    modeRef.current = 'coaching';
    setSpeaking(false);
    setAnalysisPending(false);
    setMuted(false);
    mutedRef.current = false;
    setTapRetry(null);
    setDemoFeedback(null);
    setDemoLog([]);
  }, []);

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
    if (mode === 'rehearsal') return 'recording';
    if (speaking) return 'speaking';
    if (analysisPending) return 'thinking';
    return 'listening';
  }, [phase, mode, speaking, analysisPending]);

  return {
    phase,
    presence,
    mode,
    muted,
    error,
    transcript,
    statuses,
    serverStatus,
    progressMessage,
    analysisPending,
    memoryVersion,
    tapPending: tapRetry !== null,
    demo: MOCK_MODE
      ? { provider: providerRef, feedback: demoFeedback, log: demoLog }
      : null,
    remoteAudioRef,
    clipAudioRef,
    begin,
    end,
    toggleMute,
    finishTake,
    playPendingExcerpt,
  };
}
