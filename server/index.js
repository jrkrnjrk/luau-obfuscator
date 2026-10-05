import { existsSync } from 'node:fs';
import { openAccounts } from './accounts.js';
import { createApp } from './app.js';
import { startDiscordBot } from './discord.js';

const onRailway = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);
const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? (onRailway ? '0.0.0.0' : '127.0.0.1');

function databasePath() {
  if (process.env.DATABASE_PATH) return process.env.DATABASE_PATH;
  if (onRailway && existsSync('/data')) return '/data/veil.sqlite';
  return undefined;
}

const dbPath = databasePath();
if (onRailway && !process.env.DATABASE_PATH && !existsSync('/data')) {
  console.warn('Railway disk is ephemeral. Mount a volume at /data or set DATABASE_PATH so accounts survive deploys.');
}

const accounts = openAccounts(dbPath);
const app = createApp({ accounts });
if (onRailway || process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

const server = app.listen(port, host, () => {
  console.log(`Veil API / production app: http://${host}:${port}`);
});
// Railway's proxy reuses connections longer than Node's default 5s keep-alive.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
void startDiscordBot(accounts);
