import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const USERNAME = /^[A-Za-z0-9_]{3,24}$/;
// Seeded admin "leo". Only the scrypt hash is stored; the password is not kept in source.
const ADMIN_USERNAME = 'leo';
const ADMIN_PASSWORD_HASH = 'aTIy+ryYX3nNm1yP3TbA1Q==.gprJccTEAuP61pOaopBpWlJJ1NZuur+C/1DyZde/yb4=';

export class AccountError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function defaultDatabasePath() {
  return fileURLToPath(new URL('../data/veil.sqlite', import.meta.url));
}

export function openAccounts(databasePath = defaultDatabasePath()) {
  if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
      credits INTEGER NOT NULL DEFAULT 0,
      banned INTEGER NOT NULL DEFAULT 0,
      obfuscations INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      prefix TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      revoked INTEGER NOT NULL DEFAULT 0
    );
  `);
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(ADMIN_USERNAME);
  if (!existing) {
    db.prepare(`
      INSERT INTO users (username, password_hash, role, credits, banned, obfuscations, created_at)
      VALUES (?, ?, 'admin', 0, 0, 0, ?)
    `).run(ADMIN_USERNAME, ADMIN_PASSWORD_HASH, new Date().toISOString());
  }

  function publicUser(row) {
    if (!row) return null;
    return {
      id: row.id,
      username: row.username,
      role: row.role,
      credits: row.credits,
      unlimited: row.role === 'admin',
      banned: Boolean(row.banned),
      obfuscations: row.obfuscations,
      createdAt: row.created_at,
    };
  }

  function findByUsername(username) {
    return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  }

  function validateUsername(username) {
    if (typeof username !== 'string' || !USERNAME.test(username)) {
      throw new AccountError('Username must be 3–24 letters, numbers, or underscores.');
    }
  }

  function validatePassword(password) {
    if (typeof password !== 'string' || password.length < 8 || password.length > 72) {
      throw new AccountError('Password must be 8–72 characters.');
    }
  }

  function validateCredits(credits) {
    if (!Number.isInteger(credits) || credits < 0 || credits > 1_000_000) {
      throw new AccountError('Credits must be a whole number from 0 to 1000000.');
    }
  }

  function hashPassword(password) {
    const salt = randomBytes(16);
    const hash = scryptSync(password, salt, 32);
    return `${salt.toString('base64')}.${hash.toString('base64')}`;
  }

  function verifyPassword(password, stored) {
    const [salt, hash] = String(stored).split('.');
    if (!salt || !hash) return false;
    const expected = Buffer.from(hash, 'base64');
    const actual = scryptSync(password, Buffer.from(salt, 'base64'), 32);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  function createSession(userId) {
    const token = randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(tokenHash(token), userId, Date.now() + SESSION_MS);
    return token;
  }

  function userFromToken(token) {
    if (typeof token !== 'string' || token.length < 20) return null;
    const row = db.prepare(`
      SELECT users.* FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ? AND sessions.expires_at > ?
    `).get(tokenHash(token), Date.now());
    if (!row || row.banned) return null;
    db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?')
      .run(Date.now() + SESSION_MS, tokenHash(token));
    return publicUser(row);
  }

  function logout(token) {
    if (typeof token === 'string') db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
  }

  function register(username, password) {
    validateUsername(username);
    validatePassword(password);
    if (findByUsername(username)) throw new AccountError('That username is already taken.');
    const result = db.prepare(`
      INSERT INTO users (username, password_hash, role, credits, banned, obfuscations, created_at)
      VALUES (?, ?, 'user', 0, 0, 0, ?)
    `).run(username, hashPassword(password), new Date().toISOString());
    const user = publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(Number(result.lastInsertRowid)));
    return { user, token: createSession(user.id) };
  }

  function login(username, password) {
    const row = typeof username === 'string' ? findByUsername(username) : undefined;
    const matches = row ? verifyPassword(String(password ?? ''), row.password_hash) : verifyPassword(String(password ?? ''), ADMIN_PASSWORD_HASH);
    if (!row || !matches) throw new AccountError('Invalid username or password.', 401);
    if (row.banned) throw new AccountError('This account is banned.', 403);
    return { user: publicUser(row), token: createSession(row.id) };
  }

  function requireUser(username) {
    const row = findByUsername(username);
    if (!row) throw new AccountError('Account not found.', 404);
    return row;
  }

  function listUsers() {
    return db.prepare('SELECT * FROM users ORDER BY role DESC, username COLLATE NOCASE').all().map(publicUser);
  }

  function createUser(username, password, credits = 0) {
    validateUsername(username);
    validatePassword(password);
    validateCredits(credits);
    if (findByUsername(username)) throw new AccountError('That username is already taken.');
    db.prepare(`
      INSERT INTO users (username, password_hash, role, credits, banned, obfuscations, created_at)
      VALUES (?, ?, 'user', ?, 0, 0, ?)
    `).run(username, hashPassword(password), credits, new Date().toISOString());
    return publicUser(findByUsername(username));
  }

  function adjustCredits(username, delta) {
    if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 1_000_000) {
      throw new AccountError('Enter a whole number of credits to add or remove, other than zero.');
    }
    const row = requireUser(username);
    if (row.role === 'admin') throw new AccountError('The admin account has unlimited obfuscation. Credits do not apply.');
    const next = row.credits + delta;
    if (next < 0 || next > 1_000_000) throw new AccountError('That change would put credits outside 0–1000000.');
    db.prepare('UPDATE users SET credits = ? WHERE id = ?').run(next, row.id);
    return publicUser(findByUsername(row.username));
  }

  function setBanned(username, banned) {
    const row = requireUser(username);
    if (row.role === 'admin') throw new AccountError('The admin account cannot be banned.');
    db.prepare('UPDATE users SET banned = ? WHERE id = ?').run(banned ? 1 : 0, row.id);
    if (banned) {
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
      db.prepare('UPDATE api_keys SET revoked = 1 WHERE user_id = ? AND revoked = 0').run(row.id);
    }
    return publicUser(findByUsername(row.username));
  }

  function resetPassword(username, password) {
    validatePassword(password);
    const row = requireUser(username);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), row.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
    return publicUser(row);
  }

  function deleteUser(username) {
    const row = requireUser(username);
    if (row.role === 'admin') throw new AccountError('The admin account cannot be deleted.');
    db.prepare('DELETE FROM users WHERE id = ?').run(row.id);
    return true;
  }

  function consumeCredit(userId) {
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!row || row.banned) return false;
    if (row.role === 'admin') {
      db.prepare('UPDATE users SET obfuscations = obfuscations + 1 WHERE id = ?').run(userId);
      return true;
    }
    const result = db.prepare(`
      UPDATE users SET credits = credits - 1, obfuscations = obfuscations + 1
      WHERE id = ? AND banned = 0 AND credits > 0
    `).run(userId);
    return result.changes === 1;
  }

  function publicKey(row) {
    return {
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      revoked: Boolean(row.revoked),
      username: row.username,
    };
  }

  function createApiKey(username, name = 'default') {
    const row = requireUser(username);
    if (row.banned) throw new AccountError('Banned accounts cannot create API keys.', 403);
    const label = typeof name === 'string' ? name.trim() : '';
    if (label.length < 1 || label.length > 40 || /[\r\n]/.test(label)) {
      throw new AccountError('Key name must be 1–40 characters.');
    }
    const active = db.prepare('SELECT COUNT(*) AS count FROM api_keys WHERE user_id = ? AND revoked = 0').get(row.id).count;
    if (active >= 10) throw new AccountError('This account already has 10 active API keys. Revoke one first.');
    const secret = `veil_${randomBytes(24).toString('base64url')}`;
    const createdAt = new Date().toISOString();
    const result = db.prepare(`
      INSERT INTO api_keys (user_id, name, key_hash, prefix, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(row.id, label, tokenHash(secret), secret.slice(0, 12), createdAt);
    return { id: Number(result.lastInsertRowid), name: label, prefix: secret.slice(0, 12), key: secret, createdAt, username: row.username };
  }

  function listApiKeys(username) {
    const row = requireUser(username);
    return db.prepare(`
      SELECT api_keys.*, users.username
      FROM api_keys JOIN users ON users.id = api_keys.user_id
      WHERE api_keys.user_id = ?
      ORDER BY api_keys.id DESC
    `).all(row.id).map(publicKey);
  }

  function revokeApiKey(username, id) {
    const row = requireUser(username);
    const keyId = Number(id);
    if (!Number.isInteger(keyId)) throw new AccountError('API key not found.', 404);
    const result = db.prepare('UPDATE api_keys SET revoked = 1 WHERE id = ? AND user_id = ? AND revoked = 0').run(keyId, row.id);
    if (result.changes !== 1) throw new AccountError('API key not found.', 404);
    return true;
  }

  function revokeApiKeyById(id) {
    const keyId = Number(id);
    const key = Number.isInteger(keyId)
      ? db.prepare('SELECT api_keys.id, users.username FROM api_keys JOIN users ON users.id = api_keys.user_id WHERE api_keys.id = ?').get(keyId)
      : undefined;
    if (!key) throw new AccountError('API key not found.', 404);
    return revokeApiKey(key.username, key.id);
  }

  function userFromApiKey(token) {
    if (typeof token !== 'string' || !token.startsWith('veil_') || token.length > 80) return null;
    const row = db.prepare(`
      SELECT users.* FROM api_keys
      JOIN users ON users.id = api_keys.user_id
      WHERE api_keys.key_hash = ? AND api_keys.revoked = 0
    `).get(tokenHash(token));
    if (!row || row.banned) return null;
    db.prepare('UPDATE api_keys SET last_used_at = ? WHERE key_hash = ?').run(new Date().toISOString(), tokenHash(token));
    return publicUser(row);
  }

  return {
    register,
    login,
    logout,
    userFromToken,
    userFromApiKey,
    createApiKey,
    listApiKeys,
    revokeApiKey,
    revokeApiKeyById,
    listUsers,
    createUser,
    adjustCredits,
    setBanned,
    resetPassword,
    deleteUser,
    consumeCredit,
    issueSession(username) {
      const row = findByUsername(username);
      if (!row || row.banned) throw new AccountError('Account not found.', 404);
      return createSession(row.id);
    },
    findPublic(username) {
      return publicUser(findByUsername(username));
    },
  };
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest('base64url');
}
