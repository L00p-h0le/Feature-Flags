import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { AuditEvent, Draft, Flag, Preview, Session } from './api.js';
import { message, okSchema, request } from './api.js';

export function Notice({
  error,
  children,
}: {
  error?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={`notice ${error ? 'error' : ''}`}
      role={error ? 'alert' : 'status'}
    >
      {children}
    </div>
  );
}

export function Dialog({
  title,
  children,
  close,
  busy,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  busy: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.showModal();
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby="dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
    >
      <div className="dialog-heading">
        <h2 id="dialog-title">{title}</h2>
        <button
          type="button"
          onClick={close}
          disabled={busy}
          aria-label="Close dialog"
        >
          Close
        </button>
      </div>
      {children}
    </dialog>
  );
}

export function SignIn({
  session,
  ready,
}: {
  session: Session;
  ready: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function login(body: unknown, demo: boolean) {
    setBusy(true);
    setError('');
    try {
      await request(demo ? '/api/demo-session' : '/api/session', okSchema, {
        method: 'POST',
        body,
      });
      await ready();
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void login(
      { email: data.get('email'), password: data.get('password') },
      false,
    );
  }
  return (
    <main className="signin">
      <div className="signin-story">
        <span className="wordmark">w/13</span>
        <p className="eyebrow">FEATURE FLAG CONTROL PLANE</p>
        <h1>
          Release with
          <br />a clear way back.
        </h1>
        <p>
          Prepare a change. See who it affects.
          <br />
          Publish when you’re ready.
        </p>
        <div className="signin-foot">Draft → Preview → Publish → Roll back</div>
      </div>
      <section className="signin-form">
        <p className="eyebrow">WORKSPACE ACCESS</p>
        <h2>Welcome back.</h2>
        <p>Sign in to manage your environment.</p>
        {error && <Notice error>{error}</Notice>}
        {session.demoUsers.length > 0 && (
          <div className="demo-access">
            <span className="tag">LOCAL DEMO</span>
            <h3>Explore Northstar Studio</h3>
            <p>Synthetic accounts. No external sign-in required.</p>
            {session.demoUsers.map((user) => (
              <button
                key={user.id}
                disabled={busy}
                onClick={() => {
                  void login({ userId: user.id }, true);
                }}
              >
                <span>{user.name}</span>
                <span className="role-label">{user.role} →</span>
              </button>
            ))}
          </div>
        )}
        <form onSubmit={submit}>
          <label>
            Email
            <input name="email" type="email" autoComplete="username" required />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={1024}
            />
          </label>
          <button className="primary" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </section>
    </main>
  );
}

export function RuleEditor({
  value,
  change,
  disabled,
}: {
  value: Draft;
  change: (draft: Draft) => void;
  disabled: boolean;
}) {
  function updateRule(
    index: number,
    patch: Partial<Draft['exactRules'][number]>,
  ) {
    change({
      ...value,
      exactRules: value.exactRules.map((rule, i) =>
        i === index ? { ...rule, ...patch } : rule,
      ),
    });
  }
  function move(index: number, delta: number) {
    const rules = [...value.exactRules];
    const rule = rules[index];
    const other = rules[index + delta];
    if (!rule || !other) return;
    rules[index] = other;
    rules[index + delta] = rule;
    change({ ...value, exactRules: rules });
  }
  return (
    <fieldset disabled={disabled} className="rules-fieldset">
      <legend className="sr-only">Targeting rules</legend>
      <section className="editor-section">
        <div className="section-heading">
          <span className="section-number">01</span>
          <div>
            <h3>Emergency stop</h3>
            <p>Overrides every targeting rule and returns false.</p>
          </div>
          <label className="check-label">
            <input
              type="checkbox"
              checked={value.killSwitch}
              onChange={(event) =>
                change({ ...value, killSwitch: event.target.checked })
              }
            />
            Kill switch
          </label>
        </div>
      </section>
      <section className="editor-section">
        <div className="section-heading">
          <span className="section-number">02</span>
          <div>
            <h3>Exact subject rules</h3>
            <p>First match wins. Keep the highest priority first.</p>
          </div>
        </div>
        {!value.exactRules.length && (
          <p className="quiet-box">
            No exact overrides. Subjects continue to percentage rollout.
          </p>
        )}
        {value.exactRules.map((rule, index) => (
          <div className="rule" key={index}>
            <div className="rule-order">
              <strong>Rule {index + 1}</strong>
              <div className="button-row">
                <button
                  type="button"
                  disabled={disabled || index === 0}
                  onClick={() => move(index, -1)}
                  aria-label={`Move rule ${index + 1} up`}
                >
                  ↑
                </button>
                <button
                  type="button"
                  disabled={disabled || index === value.exactRules.length - 1}
                  onClick={() => move(index, 1)}
                  aria-label={`Move rule ${index + 1} down`}
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() =>
                    change({
                      ...value,
                      exactRules: value.exactRules.filter(
                        (_, i) => i !== index,
                      ),
                    })
                  }
                >
                  Remove rule {index + 1}
                </button>
              </div>
            </div>
            <div className="two-fields">
              <label>
                Rule ID
                <input
                  value={rule.id}
                  required
                  maxLength={128}
                  onChange={(event) =>
                    updateRule(index, { id: event.target.value })
                  }
                />
              </label>
              <label>
                Return value
                <select
                  value={String(rule.value)}
                  onChange={(event) =>
                    updateRule(index, { value: event.target.value === 'true' })
                  }
                >
                  <option value="true">true — allow</option>
                  <option value="false">false — deny</option>
                </select>
              </label>
            </div>
            <label>
              Subject keys · one per line
              <textarea
                value={rule.subjectKeys.join('\n')}
                rows={3}
                spellCheck={false}
                onChange={(event) =>
                  updateRule(index, {
                    subjectKeys: event.target.value.split('\n'),
                  })
                }
              />
            </label>
            <p className="field-hint">
              Case and spaces are preserved. Remove empty lines before saving.
            </p>
          </div>
        ))}
        <button
          type="button"
          className="text-button"
          onClick={() => {
            let n = value.exactRules.length + 1;
            while (value.exactRules.some((rule) => rule.id === `rule-${n}`))
              n += 1;
            change({
              ...value,
              exactRules: [
                ...value.exactRules,
                { id: `rule-${n}`, subjectKeys: [''], value: true },
              ],
            });
          }}
        >
          + Add exact rule
        </button>
      </section>
      <section className="editor-section">
        <div className="section-heading">
          <span className="section-number">03</span>
          <div>
            <h3>Percentage rollout</h3>
            <p>The same subject keeps the same bucket across versions.</p>
          </div>
          <label className="check-label">
            <input
              type="checkbox"
              checked={value.rollout !== undefined}
              onChange={(event) => {
                const next = structuredClone(value);
                if (event.target.checked) next.rollout = { percentageBps: 0 };
                else delete next.rollout;
                change(next);
              }}
            />
            Enable rollout
          </label>
        </div>
        {value.rollout && (
          <div className="rollout-control">
            <div className="rollout-number">
              <label>
                Selected subjects (%)
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={0.01}
                  value={value.rollout.percentageBps / 100}
                  onChange={(event) =>
                    change({
                      ...value,
                      rollout: {
                        percentageBps: Math.round(
                          Number(event.target.value) * 100,
                        ),
                      },
                    })
                  }
                />
              </label>
              <span className="rollout-display">
                {value.rollout.percentageBps / 100}
                <small>%</small>
              </span>
            </div>
            <input
              aria-label="Rollout percentage slider"
              type="range"
              min={0}
              max={10_000}
              step={100}
              value={value.rollout.percentageBps}
              onChange={(event) =>
                change({
                  ...value,
                  rollout: { percentageBps: Number(event.target.value) },
                })
              }
            />
            <div className="range-labels">
              <span>0% · no subjects</span>
              <span>100% · all subjects</span>
            </div>
          </div>
        )}
      </section>
      <section className="editor-section">
        <div className="section-heading">
          <span className="section-number">04</span>
          <div>
            <h3>Default value</h3>
            <p>Used when no rule selects a subject or identity is missing.</p>
          </div>
          <label className="sr-label">
            Default value
            <select
              aria-label="Default value"
              value={String(value.defaultValue)}
              onChange={(event) =>
                change({
                  ...value,
                  defaultValue: event.target.value === 'true',
                })
              }
            >
              <option value="false">false</option>
              <option value="true">true</option>
            </select>
          </label>
        </div>
      </section>
    </fieldset>
  );
}

export function Diff({ flag }: { flag: Flag }) {
  return (
    <div className="diff">
      <div className="section-heading">
        <div>
          <h3>Publish preview</h3>
          <p>
            Saved draft compared with{' '}
            {flag.activeVersion
              ? `active v${flag.activeVersion}`
              : 'an unpublished flag'}
            .
          </p>
        </div>
        <span className="tag">{flag.changes.length} fields</span>
      </div>
      {!flag.changes.length ? (
        <p className="quiet-box">The saved draft matches the active version.</p>
      ) : (
        <div className="diff-rows">
          {flag.changes.map((change) => (
            <div className="diff-row" key={change.field}>
              <code>{change.field}</code>
              <div>
                <span className="field-hint">ACTIVE</span>
                <pre>{JSON.stringify(change.before, null, 2) ?? 'Not set'}</pre>
              </div>
              <div>
                <span className="field-hint">SAVED DRAFT</span>
                <pre>{JSON.stringify(change.after, null, 2) ?? 'Not set'}</pre>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Simulation({ preview }: { preview: Preview }) {
  return (
    <div className="simulation-results">
      {(['active', 'draft'] as const).map((source) => {
        const result = preview[source];
        return (
          <div key={source}>
            <p className="eyebrow">
              {source === 'active' ? 'ACTIVE' : 'SAVED DRAFT'}
            </p>
            {result ? (
              <>
                <strong className={`decision ${result.value ? 'on' : ''}`}>
                  {String(result.value)}
                </strong>
                <dl>
                  <dt>Reason</dt>
                  <dd>{result.reason}</dd>
                  <dt>Version</dt>
                  <dd>
                    {result.version}
                    {source === 'draft' ? ' · candidate' : ''}
                  </dd>
                  <dt>Matched rule</dt>
                  <dd>{result.matchedRuleId ?? 'None'}</dd>
                  <dt>Bucket</dt>
                  <dd>{result.bucket ?? 'Not evaluated'}</dd>
                </dl>
              </>
            ) : (
              <p>Not published yet.</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function AuditTable({ events }: { events: AuditEvent[] }) {
  if (!events.length)
    return <p className="quiet-box">No audit events in this view yet.</p>;
  return (
    <div className="audit-list">
      {events.map((event) => (
        <article className="audit-event" key={event.id}>
          <span className={`event-dot ${event.outcome}`} aria-hidden="true" />
          <div>
            <strong>
              {event.action.replaceAll('.', ' ').replaceAll('_', ' ')}
            </strong>
            <p>
              {event.actorName ?? 'Unknown actor'} ·{' '}
              {event.flagKey ?? String(event.metadata.targetKey ?? 'Workspace')}
            </p>
            <details>
              <summary>Event details</summary>
              <pre>{JSON.stringify(event.metadata, null, 2)}</pre>
            </details>
          </div>
          <div className="event-time">
            <span
              className={`tag ${event.outcome === 'allowed' ? '' : 'danger'}`}
            >
              {event.outcome}
            </span>
            <time dateTime={event.createdAt}>
              {new Date(event.createdAt).toLocaleString()}
            </time>
          </div>
        </article>
      ))}
    </div>
  );
}
