import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const EXAMPLE = `-- A small Roblox script. Ready for a little mystery?
local Players = game:GetService("Players")
local greeting = "Welcome to the experience!"

local function welcome(player)
    print(greeting, player.Name)
end

Players.PlayerAdded:Connect(welcome)

for _, player in Players:GetPlayers() do
    welcome(player)
end`;

type Options = { virtualize: boolean; renameLocals: boolean; encodeStrings: boolean; minify: boolean };
type Result = {
  code: string;
  warnings: string[];
  stats: {
    inputBytes: number;
    outputBytes: number;
    renamedLocals: number;
    encodedStrings: number;
    durationMs: number;
    virtualized: number;
    functions: number;
    instructions: number;
  };
};
type Account = {
  username: string;
  role: 'admin' | 'user';
  credits: number;
  unlimited: boolean;
  banned: boolean;
  obfuscations: number;
  createdAt: string;
};
type ApiKey = { id: number; name: string; prefix: string; createdAt: string; lastUsedAt: string | null; revoked: boolean };
type IconName = 'bolt' | 'code' | 'copy' | 'download' | 'upload' | 'check' | 'arrow' | 'shield' | 'close';

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, React.ReactNode> = {
    bolt: <path d="m13 2-9 12h7l-1 8 10-13h-7l1-7Z" />,
    code: <><path d="m8 5-6 7 6 7m8-14 6 7-6 7m-3-16-2 20" /></>,
    copy: <><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M16 8V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4" /></>,
    download: <><path d="M12 3v12m-5-5 5 5 5-5M4 15v5h16v-5" /></>,
    upload: <><path d="M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
    shield: <><path d="m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6l9-4Z" /><path d="m8 12 3 3 5-6" /></>,
    close: <path d="m6 6 12 12M6 18 18 6" />,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function formatBytes(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`;
}

async function request(path: string, init?: RequestInit) {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const data: unknown = await response.json().catch(() => null);
  const message = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
    ? data.error : `Request failed (${response.status}).`;
  return { response, data, message };
}

function AuthScreen({ onReady }: { onReady: (user: Account) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const { response, data, message } = await request(mode === 'login' ? '/api/login' : '/api/register', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    setBusy(false);
    if (!response.ok || !data || typeof data !== 'object' || !('user' in data)) {
      setError(message);
      return;
    }
    onReady(data.user as Account);
  }

  return (
    <section className="auth-card" aria-label="Account">
      <div className="eyebrow"><span /> CREDITS REQUIRED</div>
      <h2>{mode === 'login' ? 'Sign in to obfuscate.' : 'Create an account.'}</h2>
      <p>New accounts start with no credits. An admin has to add credits before a script can be transformed. The admin account is unlimited.</p>
      <form onSubmit={event => void submit(event)}>
        <label>Username<input autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} required minLength={3} maxLength={24} /></label>
        <label>Password<input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={event => setPassword(event.target.value)} required minLength={8} maxLength={72} /></label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="run-button" disabled={busy} type="submit"><Icon name="arrow" size={17} />{busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}</button>
      </form>
      <button className="text-button" type="button" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}>{mode === 'login' ? 'Need an account? Register' : 'Already registered? Sign in'}</button>
    </section>
  );
}

function ApiKeys() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [name, setName] = useState('studio');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');

  async function load() {
    const { response, data, message } = await request('/api/keys');
    if (!response.ok || !data || typeof data !== 'object' || !('keys' in data) || !Array.isArray(data.keys)) {
      setError(message);
      return;
    }
    setKeys(data.keys as ApiKey[]);
  }

  useEffect(() => { void load(); }, []);

  return (
    <section className="api-keys" aria-label="API keys">
      <div className="workspace-heading"><div><span className="section-index">04</span><h2>API keys</h2></div></div>
      <p className="settings-description">A key spends this account&apos;s credits. It is shown once. Send it as <code>Authorization: Bearer veil_...</code> or <code>X-Api-Key</code>.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      {secret && <p className="key-secret" role="status">Copy this key now. It will not be shown again: {secret}</p>}
      <form className="admin-create" onSubmit={event => {
        event.preventDefault();
        setError('');
        void request('/api/keys', { method: 'POST', body: JSON.stringify({ name }) }).then(async ({ response, data, message }) => {
          if (!response.ok || !data || typeof data !== 'object' || !('key' in data) || !data.key || typeof data.key !== 'object' || !('key' in data.key) || typeof data.key.key !== 'string') {
            setError(message);
            return;
          }
          setSecret(data.key.key);
          await load();
        });
      }}>
        <label>Key name<input value={name} onChange={event => setName(event.target.value)} required minLength={1} maxLength={40} /></label>
        <button className="secondary-button" type="submit">Generate key</button>
      </form>
      <div className="admin-table">
        {keys.map(item => <div className="admin-row" key={item.id}>
          <div><strong>{item.name}</strong><span>{item.prefix}… · {item.revoked ? 'Revoked' : item.lastUsedAt ? `Last used ${item.lastUsedAt}` : 'Never used'}</span></div>
          {!item.revoked && <button type="button" className="danger-button" onClick={() => void request('/api/keys', { method: 'DELETE', body: JSON.stringify({ id: item.id }) }).then(load)}>Revoke</button>}
        </div>)}
      </div>
    </section>
  );
}

function AdminPanel({ onClose }: { onClose: () => void }) {
  const [users, setUsers] = useState<Account[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState({ username: '', password: '', credits: '5' });
  const [deltas, setDeltas] = useState<Record<string, string>>({});
  const [passwords, setPasswords] = useState<Record<string, string>>({});
  const [keySecret, setKeySecret] = useState('');

  async function load() {
    const { response, data, message } = await request('/api/admin/users');
    if (!response.ok || !data || typeof data !== 'object' || !('users' in data) || !Array.isArray(data.users)) {
      setError(message);
      return;
    }
    setUsers(data.users as Account[]);
  }

  useEffect(() => { void load(); }, []);

  async function act(path: string, body: unknown, success: string, method = 'POST') {
    setError('');
    setNotice('');
    const { response, message } = await request(path, { method, body: JSON.stringify(body) });
    if (!response.ok) {
      setError(message);
      return;
    }
    setNotice(success);
    await load();
  }

  return (
    <section className="admin-panel" aria-label="Admin panel">
      <div className="workspace-heading"><div><span className="section-index">03</span><h2>Admin panel</h2></div><button className="text-button" onClick={onClose}>Back to workspace</button></div>
      <p className="settings-description">Add or remove credits, ban accounts, reset passwords, delete a user, or mint an API key. Banning revokes that account&apos;s keys. The admin account stays unlimited and cannot be banned.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      {notice && <p className="form-note" role="status">{notice}</p>}
      {keySecret && <p className="key-secret" role="status">Copy this key now. It will not be shown again: {keySecret}</p>}
      <form className="admin-create" onSubmit={event => {
        event.preventDefault();
        void act('/api/admin/users', { username: draft.username, password: draft.password, credits: Number(draft.credits) }, 'Account created.');
      }}>
        <label>Username<input value={draft.username} onChange={event => setDraft({ ...draft, username: event.target.value })} required minLength={3} maxLength={24} /></label>
        <label>Password<input type="password" value={draft.password} onChange={event => setDraft({ ...draft, password: event.target.value })} required minLength={8} maxLength={72} /></label>
        <label>Starting credits<input type="number" min={0} max={1000000} value={draft.credits} onChange={event => setDraft({ ...draft, credits: event.target.value })} required /></label>
        <button className="secondary-button" type="submit">Create account</button>
      </form>
      <div className="admin-table" role="table">
        {users.map(account => <div className="admin-row" role="row" key={account.username}>
          <div><strong>{account.username}</strong><span>{account.role === 'admin' ? 'Admin · unlimited' : account.banned ? 'Banned' : `${account.credits} credits`} · {account.obfuscations} runs</span></div>
          {account.role !== 'admin' && <>
            <label>Credits<input type="number" value={deltas[account.username] ?? '1'} onChange={event => setDeltas({ ...deltas, [account.username]: event.target.value })} /></label>
            <button type="button" onClick={() => void act('/api/admin/credits', { username: account.username, delta: Number(deltas[account.username] ?? '1') }, 'Credits updated.')}>Apply</button>
            <button type="button" onClick={() => void act('/api/admin/ban', { username: account.username, banned: !account.banned }, account.banned ? 'Account restored.' : 'Account banned.')}>{account.banned ? 'Unban' : 'Ban'}</button>
            <label>New password<input type="password" value={passwords[account.username] ?? ''} onChange={event => setPasswords({ ...passwords, [account.username]: event.target.value })} /></label>
            <button type="button" onClick={() => void act('/api/admin/password', { username: account.username, password: passwords[account.username] ?? '' }, 'Password reset. Existing sessions were signed out.')}>Reset</button>
            <button type="button" onClick={() => void request('/api/admin/keys', { method: 'POST', body: JSON.stringify({ username: account.username, name: 'admin' }) }).then(({ response, data, message }) => {
              if (!response.ok || !data || typeof data !== 'object' || !('key' in data) || !data.key || typeof data.key !== 'object' || !('key' in data.key) || typeof data.key.key !== 'string') {
                setError(message);
                return;
              }
              setKeySecret(data.key.key);
              setNotice(`API key created for ${account.username}.`);
            })}>API key</button>
            <button type="button" className="danger-button" onClick={() => void act('/api/admin/users', { username: account.username }, 'Account deleted.', 'DELETE')}>Delete</button>
          </>}
        </div>)}
      </div>
    </section>
  );
}

function App() {
  const [source, setSource] = useState(EXAMPLE);
  const [filename, setFilename] = useState('script.luau');
  const [options, setOptions] = useState<Options>({ virtualize: true, renameLocals: true, encodeStrings: true, minify: true });
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [info, setInfo] = useState<'how' | 'limits' | null>(null);
  const [engine, setEngine] = useState<'checking' | 'online' | 'offline'>('checking');
  const [user, setUser] = useState<Account | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [view, setView] = useState<'workspace' | 'admin'>('workspace');
  const fileInput = useRef<HTMLInputElement>(null);
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const versionRef = useRef(0);
  const sourceBytes = new TextEncoder().encode(source).length;
  const tooLarge = sourceBytes > 256 * 1024;
  const lines = source.split('\n').length;

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/health', { signal: controller.signal })
      .then(response => { setEngine(response.ok ? 'online' : 'offline'); })
      .catch((err: unknown) => {
        if (!(err instanceof DOMException && err.name === 'AbortError')) setEngine('offline');
      });
    fetch('/api/me', { signal: controller.signal })
      .then(response => response.ok ? response.json() : null)
      .then((data: unknown) => {
        if (data && typeof data === 'object' && 'user' in data) setUser(data.user as Account);
      })
      .catch(() => undefined)
      .finally(() => setAuthReady(true));
    return () => { controller.abort(); abortRef.current?.abort(); };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 3500);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!info) return;
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setInfo(null);
      if (event.key === 'Tab') {
        event.preventDefault();
        modalRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKey);
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, [info]);

  function invalidate() {
    versionRef.current++;
    abortRef.current?.abort();
    setBusy(false);
    setResult(null);
    setError('');
  }

  function changeSource(value: string) {
    invalidate();
    setSource(value);
  }

  async function logout() {
    await request('/api/logout', { method: 'POST', body: '{}' });
    setUser(null);
    setView('workspace');
    setResult(null);
  }

  async function run() {
    if (busy || !user || !source.trim() || tooLarge || (!user.unlimited && user.credits < 1)) return;
    setBusy(true);
    setError('');
    setResult(null);
    const version = versionRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch('/api/obfuscate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source, options }),
        signal: controller.signal,
      });
      const data: unknown = await response.json();
      if (response.status === 401) setUser(null);
      if (!response.ok) {
        const message = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
          ? data.error : `Request failed (${response.status}).`;
        throw new Error(message);
      }
      if (!isResult(data)) throw new Error('The engine returned an invalid response.');
      if (version !== versionRef.current) return;
      setEngine('online');
      setResult(data);
      const me = await request('/api/me');
      if (me.response.ok && me.data && typeof me.data === 'object' && 'user' in me.data) setUser(me.data.user as Account);
      setToast('Output generated and compiler-validated.');
    } catch (err: unknown) {
      if (version !== versionRef.current) return;
      const message = err instanceof Error
        ? err.name === 'AbortError' ? 'The request timed out. Check the local server and try a smaller script.' : err.message
        : 'Unable to reach the engine.';
      setError(message);
    } finally {
      clearTimeout(timeout);
      if (version === versionRef.current) setBusy(false);
    }
  }

  async function upload(file?: File) {
    if (!file) return;
    if (!/\.(lua|luau|txt)$/i.test(file.name)) {
      setError('Choose a .luau, .lua, or .txt source file.');
      return;
    }
    if (file.size > 256 * 1024) {
      setError('Source exceeds the 256 KiB limit.');
      return;
    }
    const version = versionRef.current;
    try {
      const text = await file.text();
      if (version !== versionRef.current) return;
      changeSource(text);
      setFilename(file.name);
      setToast('Source file loaded.');
    } catch (err: unknown) {
      setError(err instanceof Error ? `Could not read the file: ${err.message}` : 'Could not read the file.');
    }
  }

  async function copy() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.code);
      setToast('Copied to clipboard.');
    } catch {
      setError('Clipboard access was denied. Select the output manually or download it.');
    }
  }

  function download() {
    if (!result) return;
    const url = URL.createObjectURL(new Blob([result.code], { type: 'text/plain;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${filename.replace(/\.(luau|lua|txt)$/i, '')}.obfuscated.luau`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setToast('Download started.');
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Veil home"><span className="brand-mark">V<span /></span>VEIL<span className="brand-separator" /><span className="brand-subtitle">LUAU STUDIO</span></a>
        <nav aria-label="Main navigation">
          <button className={!info ? 'nav-active' : ''} onClick={() => setInfo(null)}>Workspace</button>
          <button onClick={() => setInfo('how')}>How it works</button>
          <button onClick={() => setInfo('limits')}>Compatibility</button>
        </nav>
        <div className="topbar-side">
          {user && <div className="account-chip"><span>{user.username}</span><strong>{user.unlimited ? 'Unlimited' : `${user.credits} credits`}</strong>{user.role === 'admin' && <button onClick={() => setView(view === 'admin' ? 'workspace' : 'admin')}>{view === 'admin' ? 'Workspace' : 'Admin'}</button>}<button onClick={() => void logout()}>Log out</button></div>}
          <div className={`engine-status ${engine}`}><span className="status-dot" />{engine === 'online' ? 'Engine online' : engine === 'checking' ? 'Connecting' : 'Engine offline'}<span className="local-tag">LOCAL</span></div>
        </div>
      </header>

      <main>
        <section className="hero">
          <div>
            <div className="eyebrow"><span /> CUSTOM VM. NOT A SECRET VAULT.</div>
            <h1>Your logic.<br className="mobile-break" /> Under <span>cover.</span></h1>
            <p>Compile Luau into a shuffled, encoded virtual machine.<br />Harder to read. Still reversible. Validated before it leaves.</p>
          </div>
          <div className="hero-art" aria-hidden="true"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="art-symbol">{'{'}<span>v</span>{'}'}</div><span className="art-coordinate">LUAU / CUSTOM VM</span><span className="art-dot" /></div>
        </section>

        {!authReady ? <p className="auth-wait">Checking your session…</p> : !user ? <AuthScreen onReady={account => { setUser(account); setView('workspace'); }} /> : view === 'admin' ? <AdminPanel onClose={() => setView('workspace')} /> : <>
        <div className="workspace-heading"><div><span className="section-index">01</span><h2>Obfuscation workspace</h2><span className="beta-tag">CUSTOM VM</span></div><span className="workspace-hint"><Icon name="shield" size={14} /> Signed in · source is not stored</span></div>

        <div className="workspace">
          <section className="editor-panel" aria-label="Luau source editor">
            <div className="panel-heading"><div><span className="panel-dot mint" /><h3>Source</h3><span className="file-tab">{filename}</span></div><button className="icon-button" title="Upload source file" aria-label="Upload source file" onClick={() => fileInput.current?.click()}><Icon name="upload" size={16} /></button></div>
            <div className="editor-toolbar"><span><Icon name="code" size={13} /> LUAU</span><button onClick={() => { changeSource(EXAMPLE); setFilename('script.luau'); }}>Load example</button><button onClick={() => { changeSource(''); sourceRef.current?.focus(); }}>Clear</button></div>
            <div className="editor-body" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); void upload(e.dataTransfer.files[0]); }}>
              <div className="line-numbers" aria-hidden="true">{Array.from({ length: Math.min(lines, 1000) }, (_, index) => <div key={index}>{index + 1}</div>)}</div>
              <textarea ref={sourceRef} className="source-editor" aria-label="Luau source code" spellCheck={false} autoCapitalize="off" autoCorrect="off" value={source} placeholder="Paste your Luau script here, or drop a file..." onChange={e => changeSource(e.target.value)} onScroll={e => { const gutter = e.currentTarget.previousElementSibling; if (gutter) gutter.scrollTop = e.currentTarget.scrollTop; }} onKeyDown={e => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void run(); }
                if (e.key === 'Tab') {
                  e.preventDefault();
                  const start = e.currentTarget.selectionStart;
                  const end = e.currentTarget.selectionEnd;
                  changeSource(source.slice(0, start) + '    ' + source.slice(end));
                  requestAnimationFrame(() => sourceRef.current?.setSelectionRange(start + 4, start + 4));
                }
              }} />
            </div>
            <div className="panel-footer"><span>{lines} lines<span className="footer-dot">·</span>{formatBytes(sourceBytes)}</span><span className={tooLarge ? 'text-error' : ''}>{tooLarge ? 'Over size limit' : '256 KiB max'}</span></div>
          </section>

          <section className="editor-panel output-panel" aria-label="Obfuscated output">
            <div className="panel-heading"><div><span className="panel-dot lavender" /><h3>Output</h3>{result && <span className="validated-tag"><Icon name="check" size={12} /> VALIDATED</span>}</div><div className="output-actions"><button className="icon-button" title="Copy output" aria-label="Copy output" disabled={!result} onClick={() => void copy()}><Icon name="copy" size={16} /></button><button className="icon-button" title="Download output" aria-label="Download output" disabled={!result} onClick={download}><Icon name="download" size={16} /></button></div></div>
            <div className="editor-toolbar"><span><Icon name="code" size={13} /> {result ? 'OBFUSCATED LUAU' : 'AWAITING TRANSFORMATION'}</span><span className="readonly-label">READ ONLY</span></div>
            <div className="output-body">
              {result ? <textarea className="output-editor" aria-label="Obfuscated Luau code" readOnly spellCheck={false} value={result.code} /> : <div className="empty-output"><div className={`empty-icon ${busy ? 'processing' : ''}`}><Icon name={busy ? 'bolt' : 'shield'} size={28} /></div><h4>{busy ? 'Working under cover…' : 'A little mystery goes a long way.'}</h4><p>{busy ? 'Transforming source and validating with the Luau compiler.' : 'Your transformed script will appear here.'}</p><span className="empty-label">{busy ? 'PLEASE WAIT' : 'READY WHEN YOU ARE'}</span></div>}
            </div>
            <div className="panel-footer"><span>{result ? `${formatBytes(result.stats.outputBytes)} output` : 'Nothing generated yet'}</span><span>{result ? `${result.stats.durationMs} ms` : 'Compiler-checked output'}</span></div>
          </section>

          <aside className="settings-panel">
            <div className="settings-heading"><h3>Transformation</h3><span className="section-index">02</span></div>
            <p className="settings-description">Choose what goes under cover.</p>
            {([
              ['virtualize', 'Virtualize', 'Custom bytecode VM. Source options apply only if this is off or unsupported.'],
              ['renameLocals', 'Rename locals', 'Used when virtualization is off. Scope-aware names.'],
              ['encodeStrings', 'Encode strings', 'Used when virtualization is off. Decimal byte escapes.'],
              ['minify', 'Minify source', 'Used when virtualization is off. Keeps --! directives.'],
            ] as const).map(([key, label, description]) => <label className="option-row" key={key}><div><span>{label}</span><p>{description}</p></div><input type="checkbox" checked={options[key]} onChange={e => { invalidate(); setOptions({ ...options, [key]: e.target.checked }); }} /><span className="switch-track" aria-hidden="true" /></label>)}
            <div className="settings-note"><Icon name="shield" size={16} /><p>{user.unlimited ? 'Admin obfuscation does not spend credits.' : user.credits > 0 ? `This run spends 1 of your ${user.credits} credits.` : 'No credits left. Ask an admin to add more.'}</p></div>
            <div className="run-section"><button className="run-button" disabled={busy || !source.trim() || tooLarge || (!user.unlimited && user.credits < 1)} onClick={() => void run()}><Icon name="bolt" size={17} />{busy ? 'Transforming…' : 'Obfuscate script'}<Icon name="arrow" size={17} /></button><span className="keyboard-hint"><kbd>⌘ / Ctrl</kbd> + <kbd>Enter</kbd> to run</span></div>
            <div className="privacy-note"><span className="status-dot" /><span>Local engine. Your code is not saved.</span></div>
          </aside>
        </div>

        {error && <div className="error-banner" role="alert"><div><strong>Could not complete the request</strong><p>{error}</p></div><button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><Icon name="close" /></button></div>}
        {result && <section className="result-summary" aria-label="Transformation report"><div className="result-stats"><div><strong>{result.stats.virtualized ? result.stats.functions : result.stats.renamedLocals}</strong><span>{result.stats.virtualized ? 'VM functions' : 'locals renamed'}</span></div><div><strong>{result.stats.virtualized ? result.stats.instructions : result.stats.encodedStrings}</strong><span>{result.stats.virtualized ? 'instructions' : 'strings encoded'}</span></div><div><strong><Icon name="check" size={20} /></strong><span>compiler validated</span></div><button className="secondary-button" onClick={download}><Icon name="download" size={15} /> Download .luau</button></div><details><summary>Compatibility notes & protection limits ({result.warnings.length})</summary><ul>{result.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul></details></section>}

        <ApiKeys />
        <section className="trust-strip">
          <div><span className="feature-number">01 /</span><div><h4>Custom Luau VM</h4><p>Shuffled opcodes and an encoded program.</p></div></div>
          <div><span className="feature-number">02 /</span><div><h4>Validation, not execution</h4><p>Your submitted scripts never run.</p></div></div>
          <div><span className="feature-number">03 /</span><div><h4>Honest by design</h4><p>Harder to read, not impossible to reverse.</p></div></div>
        </section>
        </>}
        <footer><span className="footer-brand">VEIL <span> / </span> Make it less obvious.</span><span>Account and credits required · Test in Roblox Studio before publishing.</span><button onClick={() => setInfo('limits')}>Know the limits <Icon name="arrow" size={13} /></button></footer>
      </main>
      <input ref={fileInput} type="file" hidden accept=".lua,.luau,.txt" onChange={e => { void upload(e.target.files?.[0]); e.target.value = ''; }} />
      {toast && <div className="toast" role="status"><Icon name="check" size={17} />{toast}</div>}
      {info && <div className="modal-backdrop" onClick={() => setInfo(null)}><div ref={modalRef} role="dialog" aria-modal="true" aria-labelledby="info-title" className="info-modal" onClick={e => e.stopPropagation()}><button autoFocus className="icon-button modal-close" aria-label="Close information" onClick={() => setInfo(null)}><Icon name="close" /></button><div className="eyebrow">VEIL / ENGINE NOTES</div><h2 id="info-title">{info === 'how' ? 'Less obvious. Not magic.' : 'Know what stays the same.'}</h2>{info === 'how' ? <><p>The local Node server validates your input with the Luau compiler, then compiles supported syntax into a custom bytecode program. The program is XOR-encoded and paired with a generated interpreter whose opcodes are shuffled per build. The output is compiled again before it is returned. Your script is never executed.</p><p>Turn virtualization off to use the source-level path instead: scope-aware local names, decimal byte escapes, and minification that keeps Luau <code>--!</code> directives.</p><p>Your source is sent only to the server hosting this app. This local setup has no storage, analytics, or external code-processing service.</p></> : <><p>This is a custom Luau virtual machine, not Roblox bytecode and not a commercial Luraph protector. The interpreter and encoded program are still delivered to the client, so a determined person can recover the behavior. Do not hide credentials, secrets, or authoritative game logic here.</p><p>Scripts that call getfenv, setfenv, or debug fall back to source-level transforms, because those calls would observe the interpreter. Unsupported syntax also falls back or is rejected explicitly. Type annotations are erased by the VM; they are not runtime checks.</p><p>Compiler validation checks syntax, not equivalence in every Roblox experience. Roblox APIs are not available in the validator. Test the output in Roblox Studio before publishing.</p><p>An account with credits is required. New accounts start at zero credits. The admin account is unlimited and can add credits, ban accounts, reset passwords, and delete users. Source limit: 256 KiB. Processing limit: 15 seconds. At most two transformations run concurrently. Public deployment needs HTTPS and infrastructure hardening. Change the seeded admin password before exposing this app.</p></>}</div></div>}
    </div>
  );
}

function isResult(value: unknown): value is Result {
  if (!value || typeof value !== 'object' || !('code' in value) || typeof value.code !== 'string' ||
    !('warnings' in value) || !Array.isArray(value.warnings) || !value.warnings.every(item => typeof item === 'string') ||
    !('stats' in value) || !value.stats || typeof value.stats !== 'object') return false;
  const stats = value.stats;
  return ['inputBytes', 'outputBytes', 'renamedLocals', 'encodedStrings', 'durationMs', 'virtualized', 'functions', 'instructions'].every(key =>
    key in stats && typeof Reflect.get(stats, key) === 'number' && Number.isFinite(Reflect.get(stats, key)));
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
