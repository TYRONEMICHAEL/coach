import { useEffect, useRef } from 'react';
import { levels } from './levels';
import type { Presence } from './useCoach';

const INK = '23, 35, 58';
const TERRACOTTA = '185, 93, 71';

/**
 * The living line — the whole interface's pulse. Never flat: a slow
 * breath at rest, real audio when anyone speaks, terracotta and taut
 * while the room is the user's, a gentle synthetic swell during replay.
 */
export default function WaveLine({ state, replaying }: { state: Presence; replaying: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef({ state, replaying });
  stateRef.current = { state, replaying };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    let raf = 0;
    let amplitude = 0;
    let energy = 0;
    const start = performance.now();

    const draw = () => {
      const { state: presence, replaying: isReplaying } = stateRef.current;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = width * dpr;
        canvas.height = height * dpr;
      }
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);

      const t = (performance.now() - start) / 1000;
      const live = presence !== 'idle' && presence !== 'connecting' && presence !== 'error';
      // Where real levels are unavailable (iOS keeps its hands off the call
      // audio), the state itself keeps the line moving.
      const stateFloor =
        presence === 'speaking'
          ? 0.28 + 0.2 * Math.sin(t * 2.3) + 0.07 * Math.sin(t * 7.1)
          : presence === 'recording'
            ? 0.22 + 0.1 * Math.sin(t * 1.7)
            : 0;
      const target = isReplaying
        ? 0.35 + 0.3 * Math.sin(t * 2.4)
        : live
          ? Math.max(levels.mic, levels.voice, stateFloor)
          : 0;
      // Fast rise, soft fall — consonants catch, silence settles.
      energy = target > energy ? target : energy * 0.94;
      const breath = 0.045 + 0.02 * Math.sin(t * 0.7);
      amplitude = Math.min(1, breath + energy);

      const mid = height / 2;
      const reach = height * 0.42;
      const color = presence === 'recording' ? TERRACOTTA : INK;

      const wave = (phase: number, freq: number, alpha: number, weight: number) => {
        context.beginPath();
        for (let x = 0; x <= width; x += 2) {
          const p = x / width;
          const taper = Math.sin(Math.PI * p) ** 1.4;
          const y =
            mid +
            taper *
              reach *
              amplitude *
              (0.62 * Math.sin(p * Math.PI * freq + t * 1.9 + phase) +
                0.38 * Math.sin(p * Math.PI * freq * 2.7 - t * 1.3 + phase * 1.7));
          if (x === 0) context.moveTo(x, y);
          else context.lineTo(x, y);
        }
        context.strokeStyle = `rgba(${color}, ${alpha})`;
        context.lineWidth = weight;
        context.stroke();
      };

      const mainWeight = presence === 'recording' ? 2 : 1.5;
      wave(0, 3, 0.85, mainWeight);
      wave(1.9, 3.6, 0.22, 1);

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <canvas ref={canvasRef} className="waveLine" aria-hidden="true" />;
}
