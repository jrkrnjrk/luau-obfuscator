import express from 'express';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { AccountError, openAccounts } from './accounts.js';
import { MAX_SOURCE_BYTES } from './obfuscator.js';

const COOKIE = 'veil_session';

export function createApp(options = {}) {
  const accounts = options.accounts ?? openAccounts(options.database);
  const app = express();
  let active = 0;
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', (req, res, next) => {
    const origin = req.get('origin');
    const keyed = (req.get('authorization') ?? '').startsWith('Bearer ') || Boolean(req.get('x-api-key'));
    if (!keyed && origin && origin !== `http://${req.get('host')}` && origin !== `https://${req.get('host')}`) {
      return res.status(403).json({ error: 'Cross-origin API requests are not allowed.' });
    }
    next();
  });
  app.use(express.json({ limit: '2mb' }));
  app.get('/api/health', (_req, res) => res.json({ status: 'ok', engine: 'Luau + tree-sitter' }));
  app.post('/api/register', (req, res) => {
    if (!req.is('application/json')) return res.status(415).json({ error: 'Use application/json.' });
    const { username, password } = req.body ?? {};
    const result = accounts.register(username, password);
    setSession(res, req, result.token);
    res.status(201).json({ user: clientUser(result.user) });
  });
  app.post('/api/login', (req, res) => {
    if (!req.is('application/json')) return res.status(415).json({ error: 'Use application/json.' });
    const { username, password } = req.body ?? {};
    const result = accounts.login(username, password);
    setSession(res, req, result.token);
    res.json({ user: clientUser(result.user) });
  });
  app.post('/api/logout', (req, res) => {
    accounts.logout(readToken(req));
    clearSession(res);
    res.json({ ok: true });
  });
  app.get('/api/me', (req, res) => {
    const user = accounts.userFromToken(readToken(req));
    if (!user) return res.status(401).json({ error: 'Sign in to continue.' });
    res.json({ user: clientUser(user) });
  });
  app.get('/api/admin/users', requireAdmin, (_req, res) => {
    res.json({ users: accounts.listUsers().map(clientUser) });
  });
  app.post('/api/admin/users', requireAdmin, (req, res) => {
    const { username, password, credits } = req.body ?? {};
    const user = accounts.createUser(username, password, credits ?? 0);
    res.status(201).json({ user: clientUser(user) });
  });
  app.post('/api/admin/credits', requireAdmin, (req, res) => {
    const { username, delta } = req.body ?? {};
    res.json({ user: clientUser(accounts.adjustCredits(username, delta)) });
  });
  app.post('/api/admin/ban', requireAdmin, (req, res) => {
    const { username, banned } = req.body ?? {};
    if (typeof banned !== 'boolean') throw new AccountError('Ban status must be true or false.');
    res.json({ user: clientUser(accounts.setBanned(username, banned)) });
  });
  app.post('/api/admin/password', requireAdmin, (req, res) => {
    const { username, password } = req.body ?? {};
    accounts.resetPassword(username, password);
    res.json({ ok: true });
  });
  app.delete('/api/admin/users', requireAdmin, (req, res) => {
    const { username } = req.body ?? {};
    accounts.deleteUser(username);
    res.json({ ok: true });
  });
  app.get('/api/keys', requireSession, (req, res) => {
    res.json({ keys: accounts.listApiKeys(req.account.username) });
  });
  app.post('/api/keys', requireSession, (req, res) => {
    const { name } = req.body ?? {};
    res.status(201).json({ key: accounts.createApiKey(req.account.username, name ?? 'default') });
  });
  app.delete('/api/keys', requireSession, (req, res) => {
    const { id } = req.body ?? {};
    accounts.revokeApiKey(req.account.username, id);
    res.json({ ok: true });
  });
  app.post('/api/admin/keys', requireAdmin, (req, res) => {
    const { username, name } = req.body ?? {};
    res.status(201).json({ key: accounts.createApiKey(username, name ?? 'admin') });
  });
  app.get('/api/admin/keys', requireAdmin, (req, res) => {
    const username = req.query.username;
    if (typeof username !== 'string' || !username) throw new AccountError('Username is required.');
    res.json({ keys: accounts.listApiKeys(username) });
  });
  app.delete('/api/admin/keys', requireAdmin, (req, res) => {
    const { id } = req.body ?? {};
    accounts.revokeApiKeyById(id);
    res.json({ ok: true });
  });
  app.post('/api/obfuscate', (req, res) => {
    if (!req.is('application/json')) return res.status(415).json({ error: 'Use application/json.' });
    const user = requestUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in to obfuscate.' });
    if (user.banned) return res.status(403).json({ error: 'This account is banned.' });
    if (!user.unlimited && user.credits < 1) {
      return res.status(402).json({ error: 'You need credits to obfuscate. An admin can add credits to this account.' });
    }
    const { source, options } = req.body ?? {};
    if (typeof source !== 'string' || !source.trim()) return res.status(400).json({ error: 'Enter some Luau source code first.' });
    if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) return res.status(413).json({ error: 'Source exceeds the 256 KiB limit.' });
    if (active >= 2) return res.status(429).json({ error: 'The engine is busy. Try again in a moment.' });
    active++;
    const worker = new Worker(new URL('./worker.js', import.meta.url), { workerData: { source, options } });
    let finished = false;
    function finish(status, body) {
      if (finished) return;
      finished = true;
      active--;
      clearTimeout(timer);
      void worker.terminate();
      if (!res.destroyed) res.status(status).json(body);
    }
    const timer = setTimeout(() => finish(408, { error: 'Transformation exceeded the 15-second limit. Try a smaller script.' }), 15_000);
    worker.on('message', message => {
      if (message?.type !== 'veil:result') return;
      if (message.ok && !accounts.consumeCredit(user.id)) {
        finish(402, { error: 'You need credits to obfuscate. An admin can add credits to this account.' });
        return;
      }
      finish(message.ok ? 200 : message.status, message.ok ? message.result : { error: message.error });
    });
    worker.once('error', error => {
      console.error('Obfuscation worker failed:', error.message);
      finish(500, { error: 'The engine failed unexpectedly. No output was generated.' });
    });
    worker.once('exit', code => {
      if (!finished) {
        console.error(`Obfuscation worker exited before returning a result (${code}).`);
        finish(500, { error: 'The engine stopped before completing. No output was generated.' });
      }
    });
    res.once('close', () => {
      if (!finished) finish(499, { error: 'Request closed.' });
    });
  });
  const dist = fileURLToPath(new URL('../dist', import.meta.url));
  app.use(express.static(dist));
  app.get('/', (_req, res) => res.sendFile(`${dist}/index.html`));
  app.use((error, _req, res, _next) => {
    if (error instanceof AccountError) return res.status(error.status).json({ error: error.message });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large.' });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON request.' });
    console.error('Request failed:', error.message);
    res.status(500).json({ error: 'Unexpected server error.' });
  });
  return app;

  function requireSession(req, res, next) {
    const user = accounts.userFromToken(readToken(req));
    if (!user) return res.status(401).json({ error: 'Sign in to continue.' });
    req.account = user;
    next();
  }

  function requireAdmin(req, res, next) {
    requireSession(req, res, () => {
      if (req.account.role !== 'admin') return res.status(403).json({ error: 'Admin access is required.' });
      next();
    });
  }

  function requestUser(req) {
    const header = req.get('authorization') ?? '';
    if (header.startsWith('Bearer ') || req.get('x-api-key')) {
      const token = header.startsWith('Bearer ') ? header.slice(7).trim() : req.get('x-api-key').trim();
      return accounts.userFromApiKey(token);
    }
    return accounts.userFromToken(readToken(req));
  }
}

function clientUser(user) {
  return {
    username: user.username,
    role: user.role,
    credits: user.credits,
    unlimited: user.unlimited,
    banned: user.banned,
    obfuscations: user.obfuscations,
    createdAt: user.createdAt,
  };
}

function readToken(req) {
  const header = req.get('cookie') ?? '';
  const match = header.match(/(?:^|;\s*)veil_session=([^;]+)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function setSession(res, req, token) {
  const secure = req.secure || req.get('x-forwarded-proto') === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secure}`);
}

function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}
