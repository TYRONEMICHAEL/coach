import { useMemo, useState } from 'react';
import type { StoredMeeting } from './adapters/local-memory';
import type { Presence } from './useCoach';
import { COACH_NAME, DEBUG_MODE, MOCK_MODE, memory, useCoach } from './useCoach';

const stateCopy: Record<Presence, string> = {
  idle: 'Ready when you are',
  connecting: 'Joining you…',
  listening: 'Listening',
  speaking: COACH_NAME.replace(' (demo)', ''),
  recording: 'The room is yours.',
  thinking: 'Listening back…',
  error: 'Couldn’t join',
};

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function App() {
  const coach = useCoach();
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewTab, setReviewTab] = useState<'meetings' | 'memories'>('meetings');

  const snapshot = useMemo(() => memory.snapshot(), [coach.memoryVersion, reviewOpen]);
  const active = coach.phase === 'live';

  return (
    <main className={`coachShell${coach.mode === 'rehearsal' ? ' coachShell--rehearsal' : ''}`}>
      <audio ref={coach.remoteAudioRef} autoPlay playsInline className="hiddenAudio" />
      <audio ref={coach.clipAudioRef} playsInline preload="metadata" className="hiddenAudio" />

      <header className="coachHeader">
        <div>
          <span className="wordmark">COACH</span>
          <span className="prototypeTag">{MOCK_MODE ? 'DEMO — NO KEYS' : 'ONE BRAIN · WEB BODY'}</span>
        </div>
        <div className="headerActions">
          {!MOCK_MODE && coach.serverStatus && !(coach.serverStatus.openai && coach.serverStatus.openrouter) && (
            <span className="statusPill warn">
              {coach.serverStatus.openai ? 'Voice only — no analyzer key' : 'Relay keys missing'}
            </span>
          )}
          <button
            className="reviewButton"
            type="button"
            onClick={() => setReviewOpen(true)}
          >
            Review
          </button>
        </div>
      </header>

      <section className="coachStage" aria-live="polite">
        <p className="eyebrow">YOUR SPEAKING COACH</p>
        <h1>{COACH_NAME.replace(' (demo)', '')}</h1>
        <div ref={coach.presenceRef} className={`presence presence--${coach.presence}`} aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        <p className="coachStatus">
          {coach.muted
            ? 'Microphone muted'
            : coach.presence === 'thinking' && coach.progressMessage
              ? coach.progressMessage
              : stateCopy[coach.presence]}
        </p>
        {coach.presence === 'recording' && <p className="takeTimer">{formatElapsed(coach.elapsed)}</p>}
        {coach.phase === 'idle' && (
          <p className="coachPrompt">
            Talk through a meeting. Rehearse a take. Hear the exact moment that needs work — then say it better.
          </p>
        )}
        {coach.error && <p className="coachError">{coach.error}</p>}

        {coach.tapPending && (
          <div className="excerptFallback" role="status">
            <p>The browser needs one tap before it can replay your take.</p>
            <button type="button" onClick={coach.playPendingExcerpt}>
              Play excerpt
            </button>
          </div>
        )}

        {coach.transcript.length > 0 && coach.mode !== 'rehearsal' && (
          <div className="transcriptPeek">
            {coach.transcript.slice(-2).map((line, index, shown) => (
              <p
                key={`${line.text}-${index}`}
                className={`${line.role === 'coach' ? 'coachLine' : 'userLine'}${index < shown.length - 1 ? ' pastLine' : ''}`}
              >
                {line.role === 'user' && <span>You</span>}
                {line.text}
              </p>
            ))}
          </div>
        )}

        {!active ? (
          <button className="beginButton" type="button" onClick={() => void coach.begin()}>
            {coach.phase === 'error' ? 'Try again' : 'Begin'}
          </button>
        ) : (
          <div className="liveControls">
            <button type="button" onClick={coach.toggleMute} aria-pressed={coach.muted}>
              {coach.muted ? 'Unmute' : 'Mute'}
            </button>
            {coach.mode === 'rehearsal' && (
              <button type="button" className="doneButton" onClick={coach.finishTake}>
                I’m done
              </button>
            )}
            <button type="button" className="endButton" onClick={() => void coach.end()}>
              End
            </button>
          </div>
        )}

        <p className="privacyLine">
          Takes stay in this tab and are sent once, only to be analyzed. Meeting notes and deliberately kept
          memories live on this device — the coach proposes, the harness decides.
        </p>
      </section>

      {MOCK_MODE && coach.demo && <DemoPanel coach={coach} />}

      {DEBUG_MODE && coach.statuses.length > 0 && (
        <aside className="debugPanel">
          <strong>Harness events</strong>
          {coach.statuses.map((line, index) => (
            <code key={`${line}-${index}`}>{line}</code>
          ))}
        </aside>
      )}

      {reviewOpen && (
        <div className="reviewBackdrop" onClick={() => setReviewOpen(false)}>
          <aside className="reviewDrawer" onClick={(event) => event.stopPropagation()}>
            <div className="reviewTop">
              <div>
                <p className="eyebrow">WHAT {COACH_NAME.replace(' (demo)', '').toUpperCase()} HOLDS</p>
                <h2>Your notebook</h2>
              </div>
              <button type="button" onClick={() => setReviewOpen(false)} aria-label="Close review">
                ×
              </button>
            </div>
            <div className="reviewTabs">
              <button
                type="button"
                className={reviewTab === 'meetings' ? 'active' : ''}
                onClick={() => setReviewTab('meetings')}
              >
                Meetings
              </button>
              <button
                type="button"
                className={reviewTab === 'memories' ? 'active' : ''}
                onClick={() => setReviewTab('memories')}
              >
                Memories
              </button>
            </div>
            {reviewTab === 'meetings' ? (
              <div className="reviewList">
                {Object.values(snapshot.meetings).length ? (
                  Object.values(snapshot.meetings).map((meeting) => (
                    <MeetingCard key={meeting.slug} meeting={meeting} />
                  ))
                ) : (
                  <Empty text="No meetings yet. Tell the coach what you are preparing for." />
                )}
              </div>
            ) : (
              <div className="reviewList">
                {snapshot.learnings.length ? (
                  snapshot.learnings.map((learning) => (
                    <article key={learning}>
                      <small>KEPT</small>
                      <p>{learning}</p>
                    </article>
                  ))
                ) : (
                  <Empty text="Nothing kept yet. Tests are ignored; single hunches wait as candidates; anything sensitive is asked about first." />
                )}
                {snapshot.candidates.length > 0 && (
                  <>
                    <p className="candidatesHeading">Held until repeated</p>
                    {snapshot.candidates.map((candidate) => (
                      <article key={candidate} className="candidate">
                        <small>CANDIDATE</small>
                        <p>{candidate}</p>
                      </article>
                    ))}
                  </>
                )}
              </div>
            )}
          </aside>
        </div>
      )}
    </main>
  );
}

function MeetingCard({ meeting }: { meeting: StoredMeeting }) {
  return (
    <article>
      <small>{meeting.when || 'MEETING'}</small>
      <h3>{meeting.title}</h3>
      {meeting.goal && <p>{meeting.goal}</p>}
      {meeting.notes.length > 0 && (
        <ul>
          {meeting.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      {meeting.rehearsals.map((rehearsal) => (
        <details key={`${meeting.slug}-${rehearsal.take}`} className="rehearsal">
          <summary>
            Take {rehearsal.take} — {rehearsal.date}, {rehearsal.duration}
          </summary>
          <pre>{rehearsal.markdown}</pre>
        </details>
      ))}
    </article>
  );
}

function DemoPanel({ coach }: { coach: ReturnType<typeof useCoach> }) {
  const provider = coach.demo?.provider.current;
  const feedback = coach.demo?.feedback ?? null;
  const clip = feedback?.priority?.clip;
  const live = coach.phase === 'live';

  return (
    <aside className="demoPanel">
      <strong>Demo driver — the same harness, scripted instead of OpenAI</strong>
      <div className="demoButtons">
        <button
          type="button"
          disabled={!live}
          onClick={() => provider?.coachSays('Welcome back. What are you preparing for today?')}
        >
          Coach greets
        </button>
        <button
          type="button"
          disabled={!live}
          onClick={() => {
            provider?.userSays('The Q3 board review — I need the hiring plan approved.');
            provider?.callTool('set_meeting', {
              title: 'Q3 board review',
              goal: 'approve the hiring plan',
            });
          }}
        >
          Set the meeting
        </button>
        <button type="button" disabled={!live || coach.mode === 'rehearsal'} onClick={() => provider?.callTool('begin_rehearsal')}>
          Start a take (talk!)
        </button>
        <button type="button" disabled={!live || coach.mode !== 'rehearsal'} onClick={() => provider?.callTool('end_rehearsal')}>
          Finish the take
        </button>
        <button
          type="button"
          disabled={!live || !clip}
          onClick={() => clip && provider?.callTool('play_excerpt', { start_ms: clip.startMs, end_ms: clip.endMs })}
        >
          Replay the cited moment
        </button>
        <button
          type="button"
          disabled={!live}
          onClick={() => {
            provider?.callTool('remember', {
              statement: 'prefers openers under thirty seconds',
              category: 'preference',
              source: 'explicit_user_statement',
              confidence: 'high',
              evidence: 'said so directly (demo)',
              sensitive: false,
              user_confirmed: false,
            });
            provider?.callTool('remember', {
              statement: 'tends to lead with context before the point',
              category: 'coaching_pattern',
              source: 'inference',
              confidence: 'medium',
              evidence: 'observed once in the demo take',
              sensitive: false,
              user_confirmed: false,
            });
          }}
        >
          Propose two memories
        </button>
      </div>
      <div className="demoLog">
        {(coach.demo?.log ?? []).map((line, index) => (
          <code key={`${line}-${index}`}>{line}</code>
        ))}
      </div>
    </aside>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="emptyState">
      <p>{text}</p>
    </div>
  );
}
