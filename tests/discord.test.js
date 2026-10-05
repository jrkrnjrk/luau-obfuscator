import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openAccounts } from '../server/accounts.js';
import { DISCORD_OWNER_ID, handleDiscordCommand, parseEnv, resolveDiscordConfig } from '../server/discord.js';

test('discord settings come from the .env file, not the shell', () => {
  const env = parseEnv('# comment\nDISCORD_TOKEN="bot-token"\nDISCORD_GUILD_ID=\'123\'\n\nIGNORED\n');
  assert.equal(env.DISCORD_TOKEN, 'bot-token');
  assert.equal(env.DISCORD_GUILD_ID, '123');
  assert.equal('IGNORED' in env, false);
});

test('discord settings fall back to the process environment when .env omits them', () => {
  const fromFile = resolveDiscordConfig({ DISCORD_TOKEN: 'file-token', DISCORD_GUILD_ID: '9' }, { DISCORD_TOKEN: 'shell-token', DISCORD_GUILD_ID: '1' });
  assert.equal(fromFile.token, 'file-token');
  assert.equal(fromFile.guildId, '9');
  const fromProcess = resolveDiscordConfig({}, { DISCORD_TOKEN: 'railway-token', DISCORD_GUILD_ID: '42' });
  assert.equal(fromProcess.token, 'railway-token');
  assert.equal(fromProcess.guildId, '42');
});

test('discord commands are limited to the configured user', async () => {
  const accounts = openAccounts(':memory:');
  accounts.createUser('maya', 'test-pass-1', 3);
  const denied = await handleDiscordCommand(accounts, {
    userId: '1',
    name: 'terminate',
    username: 'maya',
  });
  assert.equal(denied.content, 'This command is not available to you.');
  assert.equal(accounts.findPublic('maya').banned, false);

  const banned = await handleDiscordCommand(accounts, {
    userId: DISCORD_OWNER_ID,
    name: 'terminate',
    username: 'maya',
  });
  assert.match(banned.content, /Banned maya/);
  assert.equal(accounts.findPublic('maya').banned, true);

  const restored = await handleDiscordCommand(accounts, {
    userId: DISCORD_OWNER_ID,
    name: 'unban',
    username: 'maya',
  });
  assert.match(restored.content, /Restored maya/);
  const added = await handleDiscordCommand(accounts, {
    userId: DISCORD_OWNER_ID,
    name: 'addcredit',
    username: 'maya',
    number: 2,
  });
  assert.match(added.content, /5 credits/);
  const removed = await handleDiscordCommand(accounts, {
    userId: DISCORD_OWNER_ID,
    name: 'removrecredit',
    username: 'maya',
    number: 1,
  });
  assert.match(removed.content, /4 credits/);
});

test('discord obfuscate does not require a Veil credit balance', async () => {
  const accounts = openAccounts(':memory:');
  const result = await handleDiscordCommand(accounts, {
    userId: DISCORD_OWNER_ID,
    name: 'obfuscate',
    source: 'return 1',
  });
  assert.match(result.file, /Obfuscated by Veil/);
  assert.equal(result.filename, 'obfuscated.luau');
});
