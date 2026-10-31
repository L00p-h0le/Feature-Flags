import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import {
  auditSchema,
  flagSchema,
  listSchema,
  message,
  okSchema,
  previewSchema,
  request,
  RequestError,
  sessionSchema,
  versionsSchema,
} from './api.js';
import type {
  AuditEvent,
  Draft,
  Flag,
  FlagSummary,
  Preview,
  Session,
  Version,
} from './api.js';
import {
  AuditTable,
  Dialog,
  Diff,
  Notice,
  RuleEditor,
  SignIn,
  Simulation,
} from './components.js';

type Confirmation =
  | { kind: 'publish' }
  | { kind: 'rollback'; version: number }
  | { kind: 'archive'; archived: boolean };

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [environment, setEnvironment] = useState('development');
  const [page, setPage] = useState<'flags' | 'audit'>('flags');
  const [view, setView] = useState<'targeting' | 'versions' | 'audit'>(
    'targeting',
  );
  const [flags, setFlags] = useState<FlagSummary[] | null>(null);
  const [selected, setSelected] = useState('');
  const [flag, setFlag] = useState<Flag | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);

  const membership =
    session?.memberships.find(
      (entry) => entry.environmentKey === environment,
    ) ?? session?.memberships[0];
  const base = membership
    ? `/api/organizations/${membership.organizationId}/environments/${membership.environmentKey}`
    : '';
  const canEdit = membership?.role === 'admin' || membership?.role === 'editor';
  const isAdmin = membership?.role === 'admin';
  const dirty =
    flag !== null &&
    draft !== null &&
    (JSON.stringify(flag.draft) !== JSON.stringify(draft) ||
      name !== flag.name ||
      description !== flag.description);

  const refreshSession = useCallback(async () => {
    setError('');
    try {
      setSession(await request('/api/session', sessionSchema));
    } catch (error) {
      setError(message(error));
    }
  }, []);
  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  const loadList = useCallback(
    async (signal?: AbortSignal) => {
      if (!base || !session?.user) return;
      const result = await request(
        `${base}/flags`,
        listSchema,
        signal ? { signal } : {},
      );
      setFlags(result.flags);
      setSelected((current) =>
        result.flags.some((item) => item.key === current)
          ? current
          : (result.flags.find((item) => !item.archived)?.key ??
            result.flags[0]?.key ??
            ''),
      );
    },
    [base, session?.user],
  );

  useEffect(() => {
    const controller = new AbortController();
    setFlags(null);
    setFlag(null);
    setDraft(null);
    setPreview(null);
    setError('');
    void loadList(controller.signal).catch((error: unknown) => {
      if (!controller.signal.aborted) setError(message(error));
    });
    return () => controller.abort();
  }, [loadList]);

  function installFlag(next: Flag) {
    setFlag(next);
    setDraft(structuredClone(next.draft));
    setName(next.name);
    setDescription(next.description);
    setPreview(null);
    setConflict(false);
  }

  const loadDetail = useCallback(
    async (signal?: AbortSignal) => {
      if (!base || !selected || !session?.user) return;
      const next = await request(
        `${base}/flags/${encodeURIComponent(selected)}`,
        flagSchema,
        signal ? { signal } : {},
      );
      installFlag(next);
    },
    [base, selected, session?.user],
  );
  useEffect(() => {
    const controller = new AbortController();
    setFlag(null);
    setDraft(null);
    setPreview(null);
    void loadDetail(controller.signal).catch((error: unknown) => {
      if (!controller.signal.aborted) setError(message(error));
    });
    return () => controller.abort();
  }, [loadDetail]);

  useEffect(() => {
    if (!base || !session?.user) return;
    const controller = new AbortController();
    if (page === 'audit' || view === 'audit') {
      setEvents(null);
      void request(`${base}/audit`, auditSchema, { signal: controller.signal })
        .then((data) => setEvents(data.events))
        .catch((error: unknown) => {
          if (!controller.signal.aborted) setError(message(error));
        });
    }
    if (page === 'flags' && view === 'versions' && selected) {
      setVersions(null);
      void request(
        `${base}/flags/${encodeURIComponent(selected)}/versions`,
        versionsSchema,
        { signal: controller.signal },
      )
        .then((data) => setVersions(data.versions))
        .catch((error: unknown) => {
          if (!controller.signal.aborted) setError(message(error));
        });
    }
    return () => controller.abort();
  }, [base, page, view, selected, flag?.revision, session?.user]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  async function perform(operation: () => Promise<void>) {
    setBusy(true);
    setError('');
    setSuccess('');
    setConflict(false);
    try {
      await operation();
    } catch (error) {
      setError(message(error));
      setConflict(error instanceof RequestError && error.status === 409);
      if (error instanceof RequestError && error.status === 401)
        await refreshSession();
    } finally {
      setBusy(false);
    }
  }
  function allowDiscard() {
    return (
      !dirty ||
      window.confirm(
        'Discard your unsaved edits and load another flag or environment?',
      )
    );
  }
  async function reload() {
    if (!allowDiscard()) return;
    await perform(async () => {
      await loadList();
      await loadDetail();
      setSuccess('Latest configuration loaded.');
    });
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!flag || !draft) return;
    await perform(async () => {
      const next = await request(
        `${base}/flags/${flag.key}/draft`,
        flagSchema,
        {
          method: 'PUT',
          csrf: session?.csrfToken,
          body: {
            expectedRevision: flag.revision,
            name,
            description,
            config: draft,
          },
        },
      );
      installFlag(next);
      await loadList();
      setSuccess('Draft saved. The active version has not changed.');
    });
  }
  async function confirmAction() {
    if (!flag || !confirmation) return;
    const action = confirmation;
    await perform(async () => {
      const body = {
        expectedRevision: flag.revision,
        ...(action.kind === 'rollback' ? { version: action.version } : {}),
        ...(action.kind === 'archive' ? { archived: action.archived } : {}),
      };
      const next = await request(
        `${base}/flags/${flag.key}/${action.kind}`,
        flagSchema,
        { method: 'POST', csrf: session?.csrfToken, body },
      );
      installFlag(next);
      setConfirmation(null);
      await loadList();
      setSuccess(
        action.kind === 'publish'
          ? `Version ${next.activeVersion} is now active.`
          : action.kind === 'rollback'
            ? `Rolled back to version ${next.activeVersion}. Saved draft preserved.`
            : next.archived
              ? 'Flag archived. Its published history is preserved.'
              : 'Flag restored.',
      );
    });
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await perform(async () => {
      const next = await request(`${base}/flags`, flagSchema, {
        method: 'POST',
        csrf: session?.csrfToken,
        body: {
          key: data.get('key'),
          name: data.get('name'),
          description: data.get('description'),
        },
      });
      await loadList();
      setSelected(next.key);
      installFlag(next);
      setCreating(false);
      setView('targeting');
      setSuccess('Flag created as an unpublished draft.');
    });
  }

  if (!session)
    return (
      <main className="boot">
        <span className="wordmark">w/13</span>
        {error ? (
          <>
            <Notice error>{error}</Notice>
            <button
              onClick={() => {
                void refreshSession();
              }}
            >
              Retry connection
            </button>
          </>
        ) : (
          <p role="status">Connecting to your workspace…</p>
        )}
      </main>
    );
  if (!session.user) return <SignIn session={session} ready={refreshSession} />;
  if (!membership)
    return (
      <main className="boot">
        <span className="wordmark">w/13</span>
        <h1>No workspace access</h1>
        <p>
          Your account has no environment membership. Ask a workspace
          administrator for access.
        </p>
        <button
          onClick={() => {
            void perform(async () => {
              await request('/api/logout', okSchema, {
                method: 'POST',
                csrf: session.csrfToken,
              });
              await refreshSession();
            });
          }}
        >
          Sign out
        </button>
        {error && <Notice error>{error}</Notice>}
      </main>
    );

  const filtered = (flags ?? []).filter(
    (item) =>
      (showArchived || !item.archived) &&
      `${item.name} ${item.key} ${item.description}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const title =
    confirmation?.kind === 'publish'
      ? `Publish version ${flag?.nextVersion}?`
      : confirmation?.kind === 'rollback'
        ? `Roll back to version ${confirmation.version}?`
        : confirmation?.kind === 'archive' && confirmation.archived
          ? 'Archive this flag?'
          : 'Restore this flag?';

  return (
    <div className="app-shell">
      <a className="skip-link" href="#workspace">
        Skip to workspace
      </a>
      <aside className="sidebar">
        <a className="wordmark" href="/" aria-label="W13 home">
          w/13
        </a>
        <div className="workspace-name">
          <span className="avatar">N</span>
          <div>
            <strong>{membership?.organizationName ?? 'Workspace'}</strong>
            <small>Feature management</small>
          </div>
        </div>
        <p className="eyebrow">WORKSPACE</p>
        <nav aria-label="Workspace">
          <button
            aria-current={page === 'flags' ? 'page' : undefined}
            onClick={() => setPage('flags')}
          >
            Feature flags <span>{flags?.length ?? '—'}</span>
          </button>
          <button
            aria-current={page === 'audit' ? 'page' : undefined}
            onClick={() => setPage('audit')}
          >
            Audit history <span>↗</span>
          </button>
        </nav>
        <div className="sidebar-note">
          <span className="section-number">/</span>
          <p>
            Small changes.
            <br />
            Clear decisions.
          </p>
        </div>
        <div className="user-menu">
          <span className="avatar">
            {session.user.name
              .split(' ')
              .map((part) => part[0])
              .join('')}
          </span>
          <div>
            <strong>{session.user.name}</strong>
            <small>{membership?.role ?? 'No membership'}</small>
          </div>
          <button
            aria-label="Sign out"
            disabled={busy}
            onClick={() => {
              if (!allowDiscard()) return;
              void perform(async () => {
                await request('/api/logout', okSchema, {
                  method: 'POST',
                  csrf: session.csrfToken,
                });
                setFlags(null);
                setFlag(null);
                setDraft(null);
                await refreshSession();
              });
            }}
          >
            ↗
          </button>
        </div>
      </aside>
      <main id="workspace" className="workspace">
        <header className="topbar">
          <span className="breadcrumb">
            Workspace <span>/</span>{' '}
            {page === 'flags' ? 'Feature flags' : 'Audit history'}
          </span>
          <div className="environment-control">
            {session.demoUsers.length > 0 && (
              <span className="demo-label">LOCAL DEMO</span>
            )}
            <label>
              Environment
              <select
                value={membership?.environmentKey ?? ''}
                disabled={busy}
                onChange={(event) => {
                  if (allowDiscard()) {
                    setEnvironment(event.target.value);
                    setSelected('');
                    setView('targeting');
                    setSuccess('');
                  }
                }}
              >
                {session.memberships.map((entry) => (
                  <option
                    key={`${entry.organizationId}-${entry.environmentKey}`}
                    value={entry.environmentKey}
                  >
                    {entry.environmentKey}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </header>
        <div className="page-heading">
          <div>
            <p className="eyebrow">
              RELEASE CONTROL / {membership?.environmentKey.toUpperCase()}
            </p>
            <h1>
              {page === 'flags' ? 'Feature flags' : 'Audit history'}
              <span className="heading-dot">.</span>
            </h1>
            <p>
              {page === 'flags'
                ? 'Prepare changes privately. Publish with a clear view of the impact.'
                : 'Every change, permission denial and publish conflict, in order.'}
            </p>
          </div>
          {page === 'flags' && (
            <button
              className="primary"
              disabled={!canEdit || busy}
              onClick={() => {
                if (allowDiscard()) {
                  setCreating(true);
                  setError('');
                }
              }}
            >
              + New flag
            </button>
          )}
        </div>
        {error && (
          <Notice error>
            {error}{' '}
            {conflict && (
              <button
                onClick={() => {
                  void reload();
                }}
                disabled={busy}
              >
                Reload latest
              </button>
            )}
          </Notice>
        )}
        {success && <Notice>{success}</Notice>}
        {page === 'audit' ? (
          <section className="panel global-audit">
            <div className="panel-heading">
              <h2>Environment activity</h2>
              <button
                onClick={() => {
                  void perform(async () => {
                    setEvents(
                      (await request(`${base}/audit`, auditSchema)).events,
                    );
                  });
                }}
                disabled={busy}
              >
                Refresh history
              </button>
            </div>
            {events ? (
              <AuditTable events={events} />
            ) : (
              <p role="status">Loading history…</p>
            )}
          </section>
        ) : (
          <div className="flag-workspace">
            <section
              className="flag-list panel"
              aria-label="Flags in this environment"
            >
              <div className="list-tools">
                <label className="search-label">
                  Find a flag
                  <input
                    type="search"
                    placeholder="Search flags…"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </label>
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={showArchived}
                    onChange={(event) => setShowArchived(event.target.checked)}
                  />
                  Include archived
                </label>
              </div>
              <div className="list-caption">
                <span>FLAG / STATUS</span>
                <span>{filtered.length.toString().padStart(2, '0')}</span>
              </div>
              {flags === null ? (
                <div className="loading-rows" role="status">
                  {error ? 'Flags could not be loaded.' : 'Loading flags…'}
                  <button
                    onClick={() => {
                      void reload();
                    }}
                  >
                    Retry
                  </button>
                </div>
              ) : !filtered.length ? (
                <div className="list-empty">
                  <h3>
                    {flags.length
                      ? 'No matching flags'
                      : 'Your first release starts here'}
                  </h3>
                  <p>
                    {flags.length
                      ? 'Try another name or include archived flags.'
                      : 'Create a flag, then save and preview its rules before publishing.'}
                  </p>
                </div>
              ) : (
                filtered.map((item) => (
                  <button
                    className={`flag-item ${selected === item.key ? 'selected' : ''}`}
                    key={item.key}
                    disabled={busy}
                    aria-pressed={selected === item.key}
                    onClick={() => {
                      if (selected !== item.key && allowDiscard()) {
                        setSelected(item.key);
                        setView('targeting');
                        setError('');
                        setSuccess('');
                      }
                    }}
                  >
                    <span className="flag-item-title">
                      {item.name}
                      <span aria-hidden="true">↗</span>
                    </span>
                    <code>{item.key}</code>
                    <div className="flag-tags">
                      <span
                        className={`tag ${item.hasChanges ? 'pending' : ''}`}
                      >
                        {item.archived
                          ? 'Archived'
                          : item.activeVersion === null
                            ? 'Unpublished'
                            : item.hasChanges
                              ? 'Draft changes'
                              : `Published v${item.activeVersion}`}
                      </span>
                      {item.activeVersion !== null && (
                        <span className="small-meta">
                          {item.killed
                            ? 'Killed'
                            : item.rolloutBps === null
                              ? 'Default rules'
                              : `${item.rolloutBps / 100}% rollout`}
                        </span>
                      )}
                    </div>
                  </button>
                ))
              )}
              <div className="list-bottom">
                Changes stay in draft until published.
              </div>
            </section>
            <section
              className="flag-detail panel"
              aria-label="Flag configuration"
            >
              {!flag || !draft ? (
                <div className="detail-empty">
                  <span className="section-number">{selected ? '…' : '+'}</span>
                  <h2>
                    {selected ? 'Loading configuration' : 'Select a flag'}
                  </h2>
                  <p>
                    {error
                      ? 'The configuration could not be loaded.'
                      : selected
                        ? 'Fetching the draft and active version.'
                        : 'Review targeting, simulate a subject and inspect version history.'}
                  </p>
                  {error && (
                    <button
                      onClick={() => {
                        void reload();
                      }}
                    >
                      Retry configuration
                    </button>
                  )}
                </div>
              ) : (
                <>
                  <div className="detail-heading">
                    <div>
                      <div className="flag-key">
                        <code>{flag.key}</code>
                        <span className="tag">
                          {flag.activeVersion === null
                            ? 'UNPUBLISHED'
                            : `ACTIVE V${flag.activeVersion}`}
                        </span>
                      </div>
                      <h2>{flag.name}</h2>
                      <p>{flag.description}</p>
                    </div>
                    <button
                      className="primary"
                      disabled={
                        !isAdmin ||
                        busy ||
                        dirty ||
                        !flag.changes.length ||
                        flag.archived
                      }
                      onClick={() => {
                        setConfirmation({ kind: 'publish' });
                        setError('');
                      }}
                    >
                      Review &amp; publish
                    </button>
                  </div>
                  <div className="detail-meta">
                    <span>Revision {flag.revision}</span>
                    <span>{dirty ? 'Unsaved edits' : 'Draft saved'}</span>
                    <button
                      className="text-button"
                      onClick={() => {
                        void reload();
                      }}
                      disabled={busy}
                    >
                      Reload latest
                    </button>
                  </div>
                  {flag.archived && (
                    <Notice>
                      This flag is archived. History and rules are preserved.{' '}
                      {isAdmin && (
                        <button
                          disabled={busy}
                          onClick={() =>
                            setConfirmation({
                              kind: 'archive',
                              archived: false,
                            })
                          }
                        >
                          Restore flag
                        </button>
                      )}
                    </Notice>
                  )}
                  {!canEdit && (
                    <Notice>
                      View-only access in this environment. You can inspect and
                      simulate saved rules.
                    </Notice>
                  )}
                  <nav className="detail-nav" aria-label="Flag views">
                    {(['targeting', 'versions', 'audit'] as const).map(
                      (item) => (
                        <button
                          key={item}
                          aria-current={view === item ? 'page' : undefined}
                          onClick={() => setView(item)}
                        >
                          {item === 'targeting'
                            ? 'Targeting'
                            : item === 'versions'
                              ? 'Version history'
                              : 'Audit trail'}
                        </button>
                      ),
                    )}
                  </nav>
                  {view === 'targeting' && (
                    <>
                      <form
                        className="targeting-form"
                        onSubmit={(event) => {
                          void save(event);
                        }}
                      >
                        <div className="metadata-fields">
                          <label>
                            Display name
                            <input
                              value={name}
                              onChange={(event) => setName(event.target.value)}
                              maxLength={120}
                              required
                              disabled={!canEdit || busy || flag.archived}
                            />
                          </label>
                          <label>
                            Description
                            <textarea
                              rows={2}
                              value={description}
                              onChange={(event) =>
                                setDescription(event.target.value)
                              }
                              maxLength={1000}
                              disabled={!canEdit || busy || flag.archived}
                            />
                          </label>
                        </div>
                        <RuleEditor
                          value={draft}
                          change={setDraft}
                          disabled={!canEdit || busy || flag.archived}
                        />
                        <div className="save-bar">
                          <span>
                            {dirty
                              ? 'Save your edits before previewing or publishing.'
                              : 'Saving a draft never changes the active version.'}
                          </span>
                          <button
                            className="primary"
                            disabled={
                              !canEdit || !dirty || busy || flag.archived
                            }
                          >
                            {busy ? 'Working…' : 'Save draft'}
                          </button>
                        </div>
                      </form>
                      <section className="simulator">
                        <div className="section-heading">
                          <div>
                            <p className="eyebrow">CHECK BEFORE YOU RELEASE</p>
                            <h3>Subject simulator</h3>
                            <p>
                              Compare the active version with your saved draft.
                            </p>
                          </div>
                        </div>
                        <form
                          className="simulate-form"
                          onSubmit={(event) => {
                            event.preventDefault();
                            const data = new FormData(event.currentTarget);
                            void perform(async () => {
                              setPreview(
                                await request(
                                  `${base}/flags/${flag.key}/preview`,
                                  previewSchema,
                                  {
                                    method: 'POST',
                                    csrf: session.csrfToken,
                                    body: {
                                      expectedRevision: flag.revision,
                                      subjectKey: data.get('subjectKey'),
                                    },
                                  },
                                ),
                              );
                            });
                          }}
                        >
                          <label>
                            Subject key
                            <input
                              name="subjectKey"
                              placeholder="user-3"
                              maxLength={256}
                              spellCheck={false}
                            />
                          </label>
                          <button disabled={busy || dirty || flag.archived}>
                            Simulate subject
                          </button>
                        </form>
                        {dirty && (
                          <p className="field-hint">
                            Save the draft to simulate these edits.
                          </p>
                        )}
                        {preview && <Simulation preview={preview} />}
                      </section>
                      <Diff flag={flag} />
                      {isAdmin && !flag.archived && (
                        <div className="archive-row">
                          <div>
                            <h3>Archive flag</h3>
                            <p>
                              Keep history and remove it from the default list.
                            </p>
                          </div>
                          <button
                            className="danger-button"
                            disabled={busy || dirty}
                            onClick={() =>
                              setConfirmation({
                                kind: 'archive',
                                archived: true,
                              })
                            }
                          >
                            Archive flag
                          </button>
                        </div>
                      )}
                    </>
                  )}
                  {view === 'versions' && (
                    <div className="versions">
                      {versions === null ? (
                        <p role="status">Loading versions…</p>
                      ) : !versions.length ? (
                        <p className="quiet-box">
                          No published versions yet. Save and publish your first
                          draft.
                        </p>
                      ) : (
                        versions.map((version) => (
                          <article className="version" key={version.version}>
                            <div className="panel-heading">
                              <div>
                                <h3>
                                  Version {version.version}{' '}
                                  {version.version === flag.activeVersion && (
                                    <span className="tag">ACTIVE</span>
                                  )}
                                </h3>
                                <p>
                                  {version.actorName} ·{' '}
                                  {new Date(version.createdAt).toLocaleString()}
                                </p>
                              </div>
                              <button
                                disabled={
                                  !isAdmin ||
                                  busy ||
                                  dirty ||
                                  flag.archived ||
                                  version.version === flag.activeVersion
                                }
                                onClick={() =>
                                  setConfirmation({
                                    kind: 'rollback',
                                    version: version.version,
                                  })
                                }
                              >
                                Activate version {version.version}
                              </button>
                            </div>
                            <details>
                              <summary>View immutable snapshot</summary>
                              <pre>
                                {JSON.stringify(version.config, null, 2)}
                              </pre>
                            </details>
                          </article>
                        ))
                      )}
                    </div>
                  )}
                  {view === 'audit' && (
                    <div className="flag-audit">
                      {events ? (
                        <AuditTable
                          events={events.filter(
                            (event) =>
                              event.flagKey === flag.key ||
                              event.metadata.targetKey === flag.key,
                          )}
                        />
                      ) : (
                        <p role="status">Loading audit trail…</p>
                      )}
                    </div>
                  )}
                </>
              )}
            </section>
          </div>
        )}
        <footer className="workspace-footer">
          <span>W13 / Feature management</span>
          <span>
            Draft changes are private. Published versions are immutable.
          </span>
        </footer>
      </main>
      {creating && (
        <Dialog
          title="Create a feature flag"
          busy={busy}
          close={() => setCreating(false)}
        >
          <p>
            The flag starts as an unpublished draft in{' '}
            {membership?.environmentKey}.
          </p>
          {error && <Notice error>{error}</Notice>}
          <form
            onSubmit={(event) => {
              void create(event);
            }}
          >
            <label>
              Flag key
              <input
                name="key"
                required
                pattern="[A-Za-z][A-Za-z0-9._-]*"
                maxLength={128}
                placeholder="new-checkout"
              />
            </label>
            <label>
              Display name
              <input
                name="name"
                required
                maxLength={120}
                placeholder="New checkout"
              />
            </label>
            <label>
              Description
              <textarea name="description" maxLength={1000} rows={3} />
            </label>
            <button className="primary" disabled={busy}>
              {busy ? 'Creating…' : 'Create flag'}
            </button>
          </form>
        </Dialog>
      )}
      {confirmation && flag && (
        <Dialog title={title} busy={busy} close={() => setConfirmation(null)}>
          {error && <Notice error>{error}</Notice>}
          {confirmation.kind === 'publish' ? (
            <>
              <p>
                This activates the saved draft in{' '}
                <strong>{membership?.environmentKey}</strong>. Existing
                published versions stay unchanged.
              </p>
              <Diff flag={flag} />
            </>
          ) : confirmation.kind === 'rollback' ? (
            <p>
              The selected historical configuration becomes active in{' '}
              <strong>{membership?.environmentKey}</strong>. Your saved draft
              stays unchanged.
            </p>
          ) : (
            <p>
              {confirmation.archived
                ? 'This is reversible. Version and audit history are retained.'
                : 'Restore this flag and its existing active version.'}
            </p>
          )}
          <div className="dialog-actions">
            <button onClick={() => setConfirmation(null)} disabled={busy}>
              Cancel
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() => {
                void confirmAction();
              }}
            >
              {busy
                ? 'Working…'
                : confirmation.kind === 'publish'
                  ? `Publish version ${flag.nextVersion}`
                  : confirmation.kind === 'rollback'
                    ? `Activate version ${confirmation.version}`
                    : confirmation.archived
                      ? 'Confirm archive'
                      : 'Confirm restore'}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
