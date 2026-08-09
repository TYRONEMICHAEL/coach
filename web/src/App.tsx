import { useMemo, useState } from 'react';
import type { StoredMeeting } from './adapters/local-memory';
import WaveLine from './WaveLine';
import type { Presence } from './useCoach';
import { COACH_NAME, DEBUG_MODE, MOCK_MODE, memory, useCoach } from './useCoach';

const NAME = COACH_NAME.replace(' (demo)', '');

const stateCopy: Record<Presence, string> = {
  idle: 'ready when you are',
  connecting: 'joining you…',
  listening: 'listening',
  speaking: `${NAME} is speaking`,
  recording: 'the room is yours',
  thinking: 'listening back…',
  error: 'couldn’t join',
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
  const lastCoachLine = [...coach.transcript].reverse().find((line) => line.role === 'coach');

  const status = coach.replaying
    ? 'your take — listen'
    : coach.muted
      ? 'microphone muted'
      : coach.capture === 'finalizing'
        ? 'keeping that take…'
        : coach.presence === 'thinking' && coach.progressMessage
          ? coach.progressMessage.toLowerCase()
          : stateCopy[coach.presence];

  return (
    <main className={`coachShell${coach.capture === 'recording' ? ' coachShell--rehearsal' : ''}`}>
      <audio ref={coach.remoteAudioRef} autoPlay playsInline className="hiddenAudio" />
      <audio ref={coach.clipAudioRef} playsInline preload="metadata" className="hiddenAudio" />

      <header className="topBar">
        <span className="wordmark">{MOCK_MODE ? 'COACH · DEMO' : 'COACH'}</span>
        <div className="topActions">
          {!MOCK_MODE && coach.serverStatus && !(coach.serverStatus.openai && coach.serverStatus.openrouter) && (
            <span className="warnPill">
              {coach.serverStatus.openai ? 'no analyzer key' : 'relay keys missing'}
            </span>
          )}
          <button className="reviewLink" type="button" onClick={() => setReviewOpen(true)}>
            Review
          </button>
        </div>
      </header>

      <section className="stage" aria-live="polite">
        <h1 className="coachName">{NAME}</h1>

        <WaveLine state={coach.presence} replaying={coach.replaying} />

        <p className="coachSays">
          {lastCoachLine && coach.capture !== 'recording' ? lastCoachLine.text : ' '}
        </p>

        <p className="statusLine">
          {coach.capture === 'recording' && <span className="recDot" aria-hidden="true" />}
          {coach.capture === 'recording' ? 'recording — the room is yours' : status}
          {coach.capture === 'recording' && <span className="takeTimer"> · {formatElapsed(coach.elapsed)}</span>}
        </p>

        {coach.error && <p className="errorLine">{coach.error}</p>}

        {coach.tapPending && (
          <div className="tapCard" role="status">
            <p>Your phone wants one tap before it plays you back.</p>
            <button type="button" onClick={coach.playPendingExcerpt}>
              Play the moment
            </button>
          </div>
        )}

        {!active ? (
          <div className="controls">
            <button className="textButton primary" type="button" onClick={() => void coach.begin()}>
              {coach.phase === 'error' ? 'Try again' : 'Begin'}
            </button>
          </div>
        ) : (
          <div className="controls">
            <button className="textButton" type="button" onClick={coach.toggleMute} aria-pressed={coach.muted}>
              {coach.muted ? 'unmute' : 'mute'}
            </button>
            {coach.capture === 'idle' && coach.mode === 'coaching' && (
              <button className="textButton accent" type="button" onClick={coach.startTake}>
                start a take
              </button>
            )}
            {coach.capture === 'recording' && (
              <button className="textButton accent" type="button" onClick={coach.finishTake}>
                I’m done
              </button>
            )}
            <button className="textButton" type="button" onClick={() => void coach.end()}>
              end
            </button>
          </div>
        )}

        {coach.takes.length > 0 && coach.capture !== 'recording' && (
          <div className="takesList">
            {coach.takes.map((take) => (
              <details key={take.id} className={`takeRow takeRow--${take.status}`}>
                <summary>
                  <span className="takeGlyph" aria-hidden="true" />
                  take {take.takeNumber} · {formatElapsed(Math.round(take.seconds))}
                  <span className="takeState">
                    {take.status === 'analyzing'
                      ? coach.progressMessage || 'listening back…'
                      : take.status === 'ready'
                        ? 'read'
                        : 'failed'}
                  </span>
                </summary>
                <div className="takeDetail">
                  {take.status === 'ready' && take.feedback && (
                    <>
                      {take.feedback.progress && (
                        <p>
                          <em>progress</em>
                          {take.feedback.progress.verdict} — {take.feedback.progress.note}
                        </p>
                      )}
                      <p>
                        <em>keep</em>
                        {take.feedback.strength}
                      </p>
                      {take.feedback.priority ? (
                        <p>
                          <em>fix</em>
                          {take.feedback.priority.title} — {take.feedback.priority.correction}
                        </p>
                      ) : (
                        <p>
                          {take.feedback.assessment.kind} — {take.feedback.assessment.reason}
                        </p>
                      )}
                    </>
                  )}
                  {take.status === 'failed' && (
                    <>
                      <p className="takeError">{take.error}</p>
                      <button type="button" onClick={() => coach.retryTake(take.id)}>
                        send it again
                      </button>
                    </>
                  )}
                  {take.status === 'analyzing' && (
                    <p>attempt {take.attempt} — {coach.progressMessage || 'working…'}</p>
                  )}
                </div>
              </details>
            ))}
          </div>
        )}

        <p className="privacyLine">
          Takes stay in this tab and are sent once, only to be analyzed. Notes and kept memories live on this
          device — the coach proposes, the harness decides.
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
                <p className="eyebrow">WHAT {NAME.toUpperCase()} HOLDS</p>
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
          onClick={() => provider?.coachSays('Good to have you back. What are you working on?')}
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
