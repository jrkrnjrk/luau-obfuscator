import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AccountError } from './accounts.js';
import { obfuscate, MAX_SOURCE_BYTES } from './obfuscator.js';

export const DISCORD_OWNER_ID = '1495205868973719552';

const COMMANDS = [
  { name: 'terminate', description: 'Ban a Veil account', options: [{ name: 'username', description: 'Veil username', required: true }] },
  { name: 'addcredit', description: 'Add credits to a Veil account', options: [
    { name: 'number', description: 'Credits to add', type: 'integer', required: true, min: 1, max: 1_000_000 },
    { name: 'username', description: 'Veil username', required: true },
  ] },
  { name: 'removrecredit', description: 'Remove credits from a Veil account', options: [
    { name: 'number', description: 'Credits to remove', type: 'integer', required: true, min: 1, max: 1_000_000 },
    { name: 'username', description: 'Veil username', required: true },
  ] },
  { name: 'removecredit', description: 'Remove credits from a Veil account', options: [
    { name: 'number', description: 'Credits to remove', type: 'integer', required: true, min: 1, max: 1_000_000 },
    { name: 'username', description: 'Veil username', required: true },
  ] },
  { name: 'unban', description: 'Restore a banned Veil account', options: [{ name: 'username', description: 'Veil username', required: true }] },
  { name: 'obfuscate', description: 'Obfuscate Luau without spending credits', options: [
    { name: 'code', description: 'Luau source. Attach a file for longer scripts.', required: false },
    { name: 'file', description: 'A .luau, .lua, or .txt file', type: 'attachment', required: false },
  ] },
];

export async function handleDiscordCommand(accounts, command) {
  if (command.userId !== DISCORD_OWNER_ID) {
    return { ephemeral: true, content: 'This command is not available to you.' };
  }
  try {
    switch (command.name) {
      case 'terminate': {
        const user = accounts.setBanned(command.username, true);
        return { content: `Banned ${user.username}. Sessions were signed out and API keys were revoked.` };
      }
      case 'unban': {
        const user = accounts.setBanned(command.username, false);
        return { content: `Restored ${user.username}. They need a new API key if the old one was revoked.` };
      }
      case 'addcredit':
      case 'removrecredit':
      case 'removecredit': {
        const amount = command.number;
        if (!Number.isInteger(amount) || amount < 1) return { content: 'Enter a whole number of credits.' };
        const delta = command.name === 'addcredit' ? amount : -amount;
        const user = accounts.adjustCredits(command.username, delta);
        return { content: `${user.username} now has ${user.credits} credits.` };
      }
      case 'obfuscate': {
        const source = typeof command.source === 'string' ? command.source : '';
        if (!source.trim()) return { content: 'Paste code or attach a .luau file.' };
        if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) return { content: 'That file exceeds the 256 KiB limit.' };
        const result = await obfuscate(source, { virtualize: true });
        return {
          content: `Obfuscated ${result.stats.inputBytes} bytes into ${result.stats.outputBytes} bytes. Test it in Roblox Studio.`,
          filename: 'obfuscated.luau',
          file: result.code,
        };
      }
      default:
        return { content: 'Unknown command.' };
    }
  } catch (error) {
    if (error instanceof AccountError) return { content: error.message };
    console.error('Discord command failed:', error instanceof Error ? error.message : error);
    return { content: 'The command failed. No account was changed.' };
  }
}

export function parseEnv(text) {
  const values = {};
  for (const line of String(text).split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export function loadProjectEnv(path = fileURLToPath(new URL('../.env', import.meta.url))) {
  if (!existsSync(path)) return {};
  return parseEnv(readFileSync(path, 'utf8'));
}

export function resolveDiscordConfig(fileEnv = loadProjectEnv(), processEnv = process.env) {
  return {
    token: fileEnv.DISCORD_TOKEN || processEnv.DISCORD_TOKEN || '',
    guildId: fileEnv.DISCORD_GUILD_ID || processEnv.DISCORD_GUILD_ID || '',
  };
}

export async function startDiscordBot(accounts) {
  const env = resolveDiscordConfig();
  const token = env.token;
  if (!token) {
    console.log('Discord bot skipped: set DISCORD_TOKEN in .env or the process environment.');
    return null;
  }
  let discord;
  try {
    discord = await import('discord.js');
  } catch (error) {
    console.error('Discord bot skipped: discord.js is not installed.', error instanceof Error ? error.message : error);
    return null;
  }
  const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = discord;
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  client.once('ready', async () => {
    try {
      const rest = new REST({ version: '10' }).setToken(token);
      const body = COMMANDS.map(command => {
        const builder = new SlashCommandBuilder().setName(command.name).setDescription(command.description);
        for (const option of command.options) {
          if (option.type === 'integer') builder.addIntegerOption(entry => entry.setName(option.name).setDescription(option.description).setRequired(option.required).setMinValue(option.min).setMaxValue(option.max));
          else if (option.type === 'attachment') builder.addAttachmentOption(entry => entry.setName(option.name).setDescription(option.description).setRequired(Boolean(option.required)));
          else builder.addStringOption(entry => entry.setName(option.name).setDescription(option.description).setRequired(Boolean(option.required)).setMaxLength(6000));
        }
        return builder.toJSON();
      });
      const guildId = env.guildId;
      if (guildId) await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body });
      else await rest.put(Routes.applicationCommands(client.user.id), { body });
      console.log(`Discord bot ready as ${client.user.tag}. Commands are limited to one user.`);
    } catch (error) {
      console.error('Discord command registration failed:', error instanceof Error ? error.message : error);
    }
  });
  client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    const allowed = interaction.user.id === DISCORD_OWNER_ID;
    if (!allowed) {
      await interaction.reply({ content: 'This command is not available to you.', ephemeral: true }).catch(() => {});
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    try {
      const file = interaction.options.getAttachment('file');
      const source = file ? await readDiscordFile(file) : interaction.options.getString('code') ?? '';
      const result = await handleDiscordCommand(accounts, {
        userId: interaction.user.id,
        name: interaction.commandName,
        username: interaction.options.getString('username') ?? '',
        number: interaction.options.getInteger('number'),
        source,
      });
      await interaction.editReply({
        content: result.content.slice(0, 1900),
        files: result.file ? [{ attachment: Buffer.from(result.file, 'utf8'), name: result.filename ?? 'obfuscated.luau' }] : [],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The command failed.';
      await interaction.editReply({ content: message.slice(0, 1900) }).catch(() => {});
    }
  });
  await client.login(token);
  return client;
}

async function readDiscordFile(file) {
  if (file.size > MAX_SOURCE_BYTES) throw new Error('That file exceeds the 256 KiB limit.');
  const url = new URL(file.url);
  if (url.protocol !== 'https:' || !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)) {
    throw new Error('Only Discord file attachments can be obfuscated.');
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error('Could not download that attachment.');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_SOURCE_BYTES) throw new Error('That file exceeds the 256 KiB limit.');
  if (bytes.includes(0)) throw new Error('Attach a text .luau file, not a binary file.');
  return bytes.toString('utf8');
}
