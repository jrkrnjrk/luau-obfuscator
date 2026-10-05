# Veil - Luau Studio

A local web application that compiles Roblox/Luau into a **custom bytecode virtual
machine**. It is not Luraph, not Roblox bytecode, and not irreversible. Client
scripts remain recoverable by someone willing to read the generated interpreter.

## Run

Requires Node.js 22 or newer and npm. The tree-sitter dependencies include native
bindings; platforms without prebuilt binaries need a C/C++ build toolchain.

```sh
npm install
npm run dev
```

Open **http://127.0.0.1:5173**. The API runs on port 3001, with a Vite development
proxy. Both servers bind to loopback by default.

For a production build served locally:

```sh
npm run build
npm start
```

Open **http://127.0.0.1:3001**. `HOST` and `PORT` configure the API/production
server. Locally the server binds to loopback. The API requires same-origin
requests. Railway terminates HTTPS and forwards the original host, which the
origin check already accepts.

## Railway

The repo includes a [Dockerfile](Dockerfile) and [railway.toml](railway.toml).
Railway injects `PORT`; the container listens on `0.0.0.0`. Node 22 is required
because accounts use `node:sqlite`.

1. Create a Railway service from this directory. The Dockerfile is the builder.
2. Generate a public domain. Do not set `PORT` yourself.
3. Add a volume mounted at `/data`. Accounts are stored in SQLite. Without a
   volume, every deploy wipes users, sessions, and API keys. If `/data` exists
   the server uses `/data/veil.sqlite`. Override with `DATABASE_PATH`.
4. Set `DISCORD_TOKEN` and, optionally, `DISCORD_GUILD_ID` as service variables.
   A project `.env` file still wins when it is present. Railway has no `.env`
   file, so the process environment is used.
5. Keep the service at one replica. SQLite and the Discord bot are not safe to
   run on more than one instance.

`GET /api/health` is the deploy health check.

## Features

- Luau compiler validation of input **and** transformed output using `luau-web`.
  Submitted scripts are compiled but **never executed**.
- Default **virtualization**: supported Luau is compiled to a custom instruction
  set, shuffled per build, XOR-encoded, and emitted with a generated interpreter.
  Locals become register boxes. String bytes live in the encoded program, not as
  readable literals. Every result starts with `-- Obfuscated by Veil --`, after
  any leading `--!` directives.
- Automatic fallback to source-level transforms when virtualization is turned
  off, when `getfenv` / `setfenv` / `debug` is detected, or when a construct is
  not supported by the compiler.
- Source-level path: scope-aware random local names, decimal byte-escape strings,
  and minification that preserves Luau `--!` directives.
- Accounts and credits. Obfuscation requires a signed-in account with at least
  one credit. New accounts start at zero. The seeded admin account has unlimited
  obfuscation and an admin panel for creating accounts, adding or removing
  credits, banning, resetting passwords, and deleting users.
- File upload and drag/drop, editable source, read-only output, copy/download,
  keyboard shortcut (Cmd/Ctrl+Enter), statistics, and explicit error reporting.
- No database, code persistence, analytics, external fonts, or external
  code-processing service. Source is sent to the server hosting this app; a
  remotely deployed server would receive it.

## Compatibility and protection limits

- **Virtualization is not encryption and not anti-tamper.** The interpreter and
  encoded program ship with the script. Opcode shuffling and XOR raise the cost
  of casual reading; they do not make reversal impossible. Keep secrets and
  authoritative game logic on the server.
- References to `getfenv`, `setfenv`, or `debug` skip virtualization. Those
  calls would see the interpreter environment rather than the original script
  environment. The source-level path also skips local renaming in that case.
- The VM erases type annotations, aliases, and casts. They are compile-time
  information, not runtime checks. On the source-level path, typed code skips
  local renaming so type references stay intact.
- Valid Luau syntax unsupported by the installed parser is rejected explicitly.
  Syntax the VM compiler does not implement falls back to source-level transforms
  with an explicit warning.
- Roblox services are not available in the compiler validator. Run output in
  **Roblox Studio** before publishing. Compilation is not proof of runtime
  equivalence in every experience.
- Virtualized output is larger than the input because it includes an interpreter.
  The UI reports the actual byte count. Source-level minification usually reduces
  formatting overhead when virtualization is off.
- Source limit: **256 KiB UTF-8**. Request limit: **2 MiB** (JSON escaping can
  expand source). Maximum **two** concurrent worker jobs with a **15-second**
  transformation deadline. Workers isolate expensive parsing from the HTTP
  event loop and are terminated after completion, timeout, or disconnection.

## Verification

```sh
npm test
npm run check
npm run build
```

Tests execute only trusted repository fixtures to compare original and
transformed behavior, including a small mocked Roblox service. API tests verify
that even an infinite-loop submission is only compiled, never executed.

## API

`GET /api/health` returns engine status.

`POST /api/register` and `POST /api/login` create an HttpOnly session cookie.
`GET /api/me` returns the signed-in account. `POST /api/obfuscate` requires that
cookie or an API key. Users without credits receive `402`. Banned or anonymous
requests are rejected. A successful obfuscation spends one credit, except for
the admin account. Admin routes live under `/api/admin/` and require the admin
session.

Signed-in users create keys at `POST /api/keys` with `{ "name": "studio" }`.
The raw key is returned once and only its hash is stored. List metadata with
`GET /api/keys` and revoke with `DELETE /api/keys` and `{ "id": 1 }`. Admins can
mint a key for another account at `POST /api/admin/keys`. Banning an account
revokes its keys. Send the key as `Authorization: Bearer veil_...` or
`X-Api-Key`. Key requests may omit the browser Origin header; cookie requests
remain same-origin only. A key cannot call admin routes or mint more keys.

## Discord bot

Copy `.env.example` to `.env` and set `DISCORD_TOKEN` there. Values in that file
override the process environment. If the file is missing or a key is empty, the
bot uses `DISCORD_TOKEN` and `DISCORD_GUILD_ID` from the environment, which is
how Railway supplies them. Optional `DISCORD_GUILD_ID`
registers slash commands in one server immediately; without it, global commands
can take up to an hour. Invite the bot with the `applications.commands` scope.
Every command answers only Discord user `1495205868973719552`.

- `/terminate username` bans the Veil account and revokes its keys
- `/addcredit number username` adds credits
- `/removrecredit number username` removes credits (`/removecredit` is the same)
- `/unban username` restores the account
- `/obfuscate` accepts a short `code` option or a text file attachment and
  returns `obfuscated.luau`. It does not spend credits.

The API still starts if `.env` is missing or `DISCORD_TOKEN` is empty.

`POST /api/obfuscate` accepts JSON:

```json
{
  "source": "local message = \"hello\"; print(message)",
  "options": {
    "virtualize": true,
    "renameLocals": true,
    "encodeStrings": true,
    "minify": true
  }
}
```

All options default to `true`. `renameLocals`, `encodeStrings`, and `minify`
apply only when virtualization is off or was skipped. Success returns `code`,
`warnings`, and `stats` (`inputBytes`, `outputBytes`, `renamedLocals`,
`encodedStrings`, `durationMs`, `virtualized`, `functions`, `instructions`).
Failures return `{ "error": "..." }` with an appropriate non-2xx status and no
output. Source content is not logged.
