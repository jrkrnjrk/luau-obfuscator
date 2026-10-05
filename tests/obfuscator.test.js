import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { LuauState } from 'luau-web';
import { InputError, MAX_SOURCE_BYTES, obfuscate } from '../server/obfuscator.js';

const runtime = await LuauState.createAsync();
after(() => runtime.destroy());

async function execute(source) {
  const fn = runtime.loadstring(source, 'trusted-test-fixture', true);
  return await fn();
}

const fixtures = [
  ['shadowing and initializer visibility', `
    local x = 10
    do
      local x, y = x + 2, x
      x += y
      assert(x == 22)
    end
    local x = x + 5
    return x
  `],
  ['recursive functions, closures, varargs, and multiple returns', `
    local function factorial(n)
      if n <= 1 then return 1 end
      return n * factorial(n - 1)
    end
    local x = 5
    local fn = function(y, ...) return x+y, ... end
    local a,b,c = fn(4, 10, 20)
    return factorial(x),a,b,c
  `],
  ['closures before a later declaration', `
    local x = 7
    local function get() return x end
    local x = 100
    return get(),x
  `],
  ['uninitialized locals and function assignment to an existing local', `
    local f
    function f(n) if n > 0 then return f(n-1)+1 end return 0 end
    return f(4)
  `],
  ['numeric and generic loops, continue, repeat condition scope', `
    local total = 0
    local i = 3
    for i=i,5 do if i==4 then continue end total += i end
    for key,value in {a=2,b=5} do total += value end
    repeat local done = total > 5; total += 1 until done
    return total,i
  `],
  ['branch and while scopes', `
    local value = 3
    if value == 3 then local value=8; assert(value==8)
    elseif value == 4 then local value=9
    else local value=10 end
    while value < 6 do local step=1; value += step end
    return value
  `],
  ['methods, implicit self, property keys, computed keys', `
    local self = 90
    local value = 7
    local object = {value=value, [value]=11, 3}
    function object:add(value) return self.value+value end
    function object.nested(value) return value*2 end
    return object:add(5), object.nested(4), object[value], self, object[1]
  `],
  ['nested methods and shadowed self parameters', `
    local self=80
    local object={value=9}
    function object:get()
      local f=function() return self.value end
      local g=function(self) return self end
      return f()+g(2)
    end
    return object:get(),self
  `],
  ['Unicode and binary bytes in quoted strings', String.raw`
    local a = "héllo 🦋 \000\255\12\x00\xFF"
    local b = "\u{1f600}\n\t\a\b\f\r\v\"\\\'"
    local c = "abc\z
      def"
    return #a,#b,#c,a== "héllo 🦋 \000\255\12\x00\xFF",c=="abcdef"
  `],
  ['long brackets and nested-looking comments', `
    --[==[ this "comment" has [=[nested]=] text ]==]
    local s=[=[
hello
"world" ]==] 🦋
]=]
    return s,#s
  `],
  ['interpolations with expressions and nested strings', 'local x=4; return `value {x}, {string.upper("hello")}, {`inner {x+1}`}`'],
  ['if expressions, compound arithmetic, and operator boundaries', `
    local x=4
    local value=if x>3 then 5 elseif x>0 then 2 else 0
    local text=1 .. "x"
    local y=10 // 3
    x -= -2
    return value,text,y,x,2^3,- -4
  `],
  ['Luau numeric formats', 'local n=0xA+0b11+1_000+.5+1e-2; return n'],
  ['typed declarations and type queries', `
    --!strict
    local value: number=3
    type Value=typeof(value)
    local function identity<T>(x: T): T return x end
    return identity(value)
  `],
];

for (const [name, source] of fixtures) {
  test(`preserves behavior: ${name}`, async () => {
    const result = await obfuscate(source);
    assert.deepEqual(await execute(result.code), await execute(source));
    assert.ok(result.stats.inputBytes > 0);
    assert.equal(result.stats.outputBytes, Buffer.byteLength(result.code));
  });
}

test('preserves directives and removes ordinary comments', async () => {
  const result = await obfuscate('--!strict\n--!optimize 2\n-- ordinary\nlocal x = 2 -- trailing\nreturn x', { virtualize: false });
  assert.ok(result.code.startsWith('--!strict\n--!optimize 2\n-- Obfuscated by Veil --\n'));
  assert.ok(!result.code.includes('ordinary'));
  assert.ok(!result.code.includes('trailing'));
});

test('all options off returns the exact original source', async () => {
  const source = '-- comment\r\nlocal name = "abc"\r\nreturn name\n';
  const result = await obfuscate(source, { virtualize: false, renameLocals: false, encodeStrings: false, minify: false });
  assert.equal(result.code, `-- Obfuscated by Veil --\n${source}`);
  assert.equal(result.stats.renamedLocals, 0);
  assert.equal(result.stats.encodedStrings, 0);
});

test('renaming without minification preserves comments and whitespace', async () => {
  const result = await obfuscate('-- comment\nlocal value = 1\nreturn value\n', { virtualize: false, minify: false });
  assert.match(result.code, /^-- Obfuscated by Veil --\n-- comment\nlocal _v[0-9a-f]+ = 1\nreturn _v[0-9a-f]+\n$/);
});

test('minification actually shrinks whitespace-heavy code', async () => {
  const source = '-- explanation\n\nlocal value = 1\n\n    return value + 2\n';
  const result = await obfuscate(source, { virtualize: false, renameLocals: false, encodeStrings: false });
  assert.equal(result.code, '-- Obfuscated by Veil --\nlocal value=1 return value+2');
  assert.ok(result.stats.outputBytes < result.stats.inputBytes);
});

test('keeps globals and Roblox property names while renaming local service variables', async () => {
  const source = `
    local Players=game:GetService("Players")
    local function welcome(player) print(player.Name) end
    Players.PlayerAdded:Connect(welcome)
  `;
  const result = await obfuscate(source, { virtualize: false });
  assert.match(result.code, /game:GetService/);
  assert.match(result.code, /\.PlayerAdded:Connect/);
  assert.match(result.code, /\.Name/);
  const mock = `
    local received
    local game = {}
    function game:GetService(name)
      assert(name == "Players")
      return {PlayerAdded = {Connect = function(_, callback) callback({Name="Ada"}) end}}
    end
    local print = function(name) received = name end
  `;
  assert.deepEqual(await execute(mock + source + '\nreturn received'), ['Ada']);
  assert.deepEqual(await execute(mock + result.code + '\nreturn received'), ['Ada']);
  const virtualized = await obfuscate(source);
  assert.equal(virtualized.stats.virtualized, 1);
  assert.ok(!virtualized.code.includes('PlayerAdded'));
  const vmMock = `
    received = nil
    game = {}
    function game:GetService(name)
      assert(name == "Players")
      return {PlayerAdded = {Connect = function(_, callback) callback({Name="Ada"}) end}}
    end
    print = function(name) received = name end
    local function chunk()
      ${virtualized.code}
    end
    chunk()
    return received
  `;
  assert.deepEqual(await execute(vmMock), ['Ada']);
});

test('typed scripts explicitly report conservative renaming', async () => {
  const result = await obfuscate('local value: number=1; return value', { virtualize: false });
  assert.equal(result.stats.renamedLocals, 0);
  assert.ok(result.warnings.some(warning => warning.includes('typed code')));
});

test('environment introspection explicitly disables renaming', async () => {
  const result = await obfuscate('local value=1; return getfenv(),value');
  assert.equal(result.stats.renamedLocals, 0);
  assert.ok(result.warnings.some(warning => warning.includes('introspection')));
});

test('rejects invalid input and unknown options', async () => {
  for (const input of ['', ' ', null, 5, 'local = ???']) {
    await assert.rejects(obfuscate(input), InputError);
  }
  await assert.rejects(obfuscate('return 1', { unsupported: true }), /Invalid option/);
  await assert.rejects(obfuscate('return 1', { toString: true }), /Invalid option/);
  await assert.rejects(obfuscate('return 1', { minify: 'yes' }), /Invalid option/);
  await assert.rejects(obfuscate('return 1', null), /Options must be an object/);
  await assert.rejects(obfuscate('--' + 'a'.repeat(MAX_SOURCE_BYTES)), /256 KiB/);
});

test('fresh names are randomized and do not capture globals', async () => {
  const source = 'local value=1; return value, _v00000000';
  const first = await obfuscate(source, { virtualize: false });
  const second = await obfuscate(source, { virtualize: false });
  assert.notEqual(first.code, second.code);
  assert.ok(first.code.includes('_v00000000'));
  assert.equal(first.stats.renamedLocals, 1);
});

test('escaped physical newlines and long-string line endings preserve bytes', async () => {
  for (const source of ['return "a\\\r\nb"', 'return "a\\\rb"', 'return [=[\r\na\r\nb\rc\n]=]', 'return [=[\na\n\rb]=]', 'return [=[\ra\rb]=]']) {
    const result = await obfuscate(source);
    assert.deepEqual(await execute(result.code), await execute(source));
  }
});

test('every option combination preserves fixture behavior', async () => {
  const source = 'local name="hello"; local function f(n) return name,n*2 end return f(3)';
  const expected = await execute(source);
  for (let mask = 0; mask < 8; mask++) {
    const options = { virtualize: false, renameLocals: Boolean(mask & 1), encodeStrings: Boolean(mask & 2), minify: Boolean(mask & 4) };
    const result = await obfuscate(source, options);
    assert.deepEqual(await execute(result.code), expected, JSON.stringify(options));
  }
});

test('the exact 256 KiB source limit is accepted', async () => {
  const source = 'return 1\n--' + 'x'.repeat(MAX_SOURCE_BYTES - Buffer.byteLength('return 1\n--'));
  const result = await obfuscate(source, { virtualize: false });
  assert.equal(result.stats.inputBytes, MAX_SOURCE_BYTES);
  assert.equal(result.code, '-- Obfuscated by Veil --\nreturn 1');
  const virtualized = await obfuscate(source);
  assert.equal(virtualized.stats.virtualized, 1);
  assert.deepEqual(await execute(virtualized.code), [1]);
});

test('virtualization is the default and removes readable source', async () => {
  const source = 'local secret = "visible-secret"; return secret';
  const result = await obfuscate(source);
  assert.equal(result.stats.virtualized, 1);
  assert.ok(result.stats.functions >= 1);
  assert.ok(result.stats.instructions > 0);
  assert.ok(result.code.startsWith('-- Obfuscated by Veil --\n'));
  assert.ok(!result.code.includes('visible-secret'));
  assert.ok(!result.code.includes('local secret'));
  assert.ok(result.warnings.some(warning => warning.includes('not irreversible')));
  assert.deepEqual(await execute(result.code), ['visible-secret']);
});

test('large scripts remain transformable within the worker deadline', async () => {
  const source = 'local total=0\n' + 'total += 1\n'.repeat(12_000) + 'return total';
  const start = performance.now();
  const result = await obfuscate(source, { virtualize: false });
  assert.ok(performance.now() - start < 15_000);
  assert.deepEqual(await execute(result.code), [12_000]);
  const virtualStart = performance.now();
  const virtualized = await obfuscate(source);
  assert.ok(performance.now() - virtualStart < 15_000);
  assert.equal(virtualized.stats.virtualized, 1);
  const small = 'local total=0\n' + 'total += 1\n'.repeat(40) + 'return total';
  assert.deepEqual(await execute((await obfuscate(small)).code), [40]);
});
