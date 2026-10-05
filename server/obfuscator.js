import { randomBytes } from 'node:crypto';
import Parser from 'tree-sitter';
import Luau from 'tree-sitter-luau';
import { CompileError, LuauState } from 'luau-web';
import { UnsupportedError, virtualize } from './vm.js';

export const MAX_SOURCE_BYTES = 256 * 1024;
export const DEFAULT_OPTIONS = {
  virtualize: true,
  renameLocals: true,
  encodeStrings: true,
  minify: true,
};

export class InputError extends Error {}

const WATERMARK = '-- Obfuscated by Veil --';

function stamp(code) {
  const lines = code.split('\n');
  let index = 0;
  while (index < lines.length && lines[index].startsWith('--!')) index++;
  lines.splice(index, 0, WATERMARK);
  return lines.join('\n');
}

function walk(node, callback) {
  callback(node);
  for (const child of node.namedChildren) walk(child, callback);
}

function isTyped(node) {
  return node.type.endsWith('_type') ||
    ['type_definition', 'generic_type_list', 'cast_expression'].includes(node.type) ||
    (['variable_list', 'parameter', 'function_declaration', 'function_definition'].includes(node.type) &&
      node.children.some(child => child.type === ':'));
}

function renameLocals(root, replacements) {
  const reserved = new Set();
  walk(root, node => {
    if (node.type === 'identifier') reserved.add(node.text);
  });
  let renamed = 0;
  const scope = parent => ({ parent, bindings: new Map() });
  function bind(node, current) {
    let name;
    do name = `_v${randomBytes(4).toString('hex')}`;
    while (reserved.has(name));
    reserved.add(name);
    current.bindings.set(node.text, name);
    replacements.set(node.startIndex, { end: node.endIndex, text: name });
    renamed++;
  }
  function reference(node, current) {
    for (let s = current; s; s = s.parent) {
      if (s.bindings.has(node.text)) {
        const name = s.bindings.get(node.text);
        if (name) replacements.set(node.startIndex, { end: node.endIndex, text: name });
        return;
      }
    }
  }
  function body(node, current) {
    if (node) for (const child of node.namedChildren) visit(child, current);
  }
  function visit(node, current) {
    const children = node.namedChildren;
    switch (node.type) {
      case 'identifier':
        reference(node, current);
        return;
      case 'variable_declaration': {
        const declaration = children[0];
        const list = declaration.type === 'assignment_statement'
          ? declaration.namedChildren[0] : declaration;
        if (declaration.type === 'assignment_statement') {
          for (const value of declaration.namedChildren.slice(1)) visit(value, current);
        }
        for (const name of list.childrenForFieldName('name')) bind(name, current);
        return;
      }
      case 'function_declaration':
      case 'function_definition': {
        const name = node.childForFieldName('name');
        if (name) {
          if (node.children[0].type === 'local') bind(name, current);
          else visit(name, current);
        }
        const inner = scope(current);
        if (name?.type === 'method_index_expression') inner.bindings.set('self', null);
        const parameters = node.childForFieldName('parameters');
        for (const parameter of parameters?.namedChildren ?? []) {
          const identifier = parameter.namedChildren.find(child => child.type === 'identifier');
          if (identifier) bind(identifier, inner);
        }
        body(node.childForFieldName('body'), inner);
        return;
      }
      case 'for_statement': {
        const clause = node.childForFieldName('clause');
        const inner = scope(current);
        if (clause.type === 'for_numeric_clause') {
          for (const child of clause.namedChildren) {
            if (child.id !== clause.childForFieldName('name').id) visit(child, current);
          }
          bind(clause.childForFieldName('name'), inner);
        } else {
          for (const child of clause.namedChildren.slice(1)) visit(child, current);
          for (const name of clause.namedChildren[0].childrenForFieldName('name')) bind(name, inner);
        }
        body(node.childForFieldName('body'), inner);
        return;
      }
      case 'repeat_statement': {
        const inner = scope(current);
        body(node.childForFieldName('body'), inner);
        visit(node.childForFieldName('condition'), inner);
        return;
      }
      case 'block':
        body(node, scope(current));
        return;
      case 'dot_index_expression':
      case 'method_index_expression':
        visit(node.childForFieldName('table'), current);
        return;
      case 'field':
        if (node.children[0].type === '[') {
          visit(node.childForFieldName('name'), current);
        }
        visit(node.childForFieldName('value'), current);
        return;
      case 'comment':
      case 'string_content':
      case 'escape_sequence':
        return;
      default:
        for (const child of children) visit(child, current);
    }
  }
  body(root, scope(null));
  return renamed;
}

function decodeString(text) {
  if (text[0] === '[') {
    const opening = text.match(/^\[(=*)\[/)[0];
    let content = text.slice(opening.length, -opening.length);
    content = content.replace(/\r\n/g, '\n');
    if (content.startsWith('\n')) content = content.slice(1);
    return Buffer.from(content);
  }
  const content = text.slice(1, -1);
  const bytes = [];
  const simple = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11 };
  for (let i = 0; i < content.length;) {
    if (content[i] !== '\\') {
      const point = content.codePointAt(i);
      bytes.push(...Buffer.from(String.fromCodePoint(point)));
      i += point > 0xffff ? 2 : 1;
      continue;
    }
    i++;
    const char = content[i++];
    if (char in simple) bytes.push(simple[char]);
    else if (char === 'z') {
      while (i < content.length && /[ \t\r\n\v\f]/.test(content[i])) i++;
    } else if (char === 'x') {
      bytes.push(parseInt(content.slice(i, i + 2), 16));
      i += 2;
    } else if (char === 'u') {
      const end = content.indexOf('}', i + 1);
      bytes.push(...Buffer.from(String.fromCodePoint(parseInt(content.slice(i + 1, end), 16))));
      i = end + 1;
    } else if (/[0-9]/.test(char)) {
      const digits = (char + content.slice(i)).match(/^[0-9]{1,3}/)[0];
      bytes.push(Number(digits));
      i += digits.length - 1;
    } else if (char === '\r' || char === '\n') {
      if ((char === '\r' && content[i] === '\n') || (char === '\n' && content[i] === '\r')) i++;
      bytes.push(10);
    } else {
      bytes.push(...Buffer.from(char));
    }
  }
  return Buffer.from(bytes);
}

function applyRange(source, start, end, replacements) {
  let output = '';
  let cursor = start;
  let low = 0;
  let high = replacements.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (replacements[middle][0] < start) low = middle + 1;
    else high = middle;
  }
  for (let index = low; index < replacements.length; index++) {
    const [position, replacement] = replacements[index];
    if (position >= end) break;
    output += source.slice(cursor, position) + replacement.text;
    cursor = replacement.end;
  }
  return output + source.slice(cursor, end);
}

export async function obfuscate(source, suppliedOptions = {}) {
  const started = performance.now();
  if (typeof source !== 'string' || !source.trim()) throw new InputError('Enter some Luau source code first.');
  if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) throw new InputError('Source exceeds the 256 KiB limit.');
  if (!suppliedOptions || typeof suppliedOptions !== 'object' || Array.isArray(suppliedOptions)) {
    throw new InputError('Options must be an object.');
  }
  for (const [key, value] of Object.entries(suppliedOptions)) {
    if (!Object.hasOwn(DEFAULT_OPTIONS, key) || typeof value !== 'boolean') throw new InputError(`Invalid option: ${key}`);
  }
  const options = { ...DEFAULT_OPTIONS, ...suppliedOptions };
  const state = await LuauState.createAsync();
  const parser = new Parser();
  let tree;
  try {
    try {
      state.loadstring(source, 'input', true);
    } catch (error) {
      if (error instanceof CompileError) throw new InputError(`Luau syntax error: ${error.message}`);
      throw error;
    }
    parser.setLanguage(Luau);
    // Keep offsets stable while accommodating the grammar's escaped CRLF limitation.
    tree = parser.parse(source.replace(/\r\n/g, '\n ').replace(/\r/g, '\n'));
    if (tree.rootNode.hasError) {
      throw new InputError('This valid Luau script uses syntax not supported by the transformation parser. No output was generated.');
    }
    const warnings = [
      'Source-level obfuscation is reversible, not encryption or VM virtualization. Never put secrets in client scripts.',
      'Local renaming changes debug-visible names; minification changes line numbers. Test in Roblox Studio before publishing.',
    ];
    const replacements = new Map();
    let typed = false;
    let introspection = false;
    walk(tree.rootNode, node => {
      if (isTyped(node)) typed = true;
      if (node.type === 'identifier' && ['getfenv', 'setfenv', 'debug'].includes(node.text)) introspection = true;
    });
    let renamed = 0;
    if (options.renameLocals && !typed && !introspection) renamed = renameLocals(tree.rootNode, replacements);
    if (options.renameLocals && typed) warnings.push('Local renaming was skipped for typed code to preserve type references and typeof expressions.');
    if (options.renameLocals && introspection) warnings.push('Local renaming was skipped because environment/debug introspection was detected.');
    if (options.virtualize && introspection) {
      warnings.push('Virtualization was skipped because getfenv, setfenv, or debug was detected. Those calls would see the interpreter, not the original script environment.');
    } else if (options.virtualize) {
      try {
        const vm = virtualize(tree.rootNode, source);
        const code = stamp(vm.code);
        try {
          state.loadstring(code, 'output', true);
        } catch (error) {
          if (error instanceof CompileError) throw new Error(`Output validation failed. No output was returned: ${error.message}`);
          throw error;
        }
        return {
          code,
          warnings: vm.warnings,
          stats: {
            inputBytes: Buffer.byteLength(source),
            outputBytes: Buffer.byteLength(code),
            renamedLocals: vm.stats.renamedLocals,
            encodedStrings: vm.stats.encodedStrings,
            durationMs: Math.round(performance.now() - started),
            virtualized: 1,
            functions: vm.stats.functions,
            instructions: vm.stats.instructions,
          },
        };
      } catch (error) {
        if (!(error instanceof UnsupportedError)) throw error;
        warnings.push(`Virtualization was skipped (${error.message}). Source-level transforms were used instead.`);
      }
    }

    let encoded = 0;
    let interpolated = 0;
    if (options.encodeStrings) {
      walk(tree.rootNode, node => {
        if (node.type !== 'string') return;
        if (node.text[0] === '`') {
          interpolated++;
          return;
        }
        const bytes = decodeString(source.slice(node.startIndex, node.endIndex));
        replacements.set(node.startIndex, {
          end: node.endIndex,
          text: `"${Array.from(bytes, byte => `\\${String(byte).padStart(3, '0')}`).join('')}"`,
        });
        encoded++;
      });
    }
    if (interpolated) warnings.push('Interpolated string text is preserved; local references inside interpolations are still renamed when enabled.');
    const sorted = [...replacements].sort((a, b) => a[0] - b[0]);
    let code;
    if (options.minify) {
      const tokens = [];
      function emit(node) {
        if (node.type === 'comment') {
          if (node.text.startsWith('--!')) tokens.push({ text: source.slice(node.startIndex, node.endIndex), directive: true });
          return;
        }
        if (['string', 'number', 'identifier'].includes(node.type) || !node.childCount) {
          tokens.push({ text: applyRange(source, node.startIndex, node.endIndex, sorted), directive: false, number: node.type === 'number' });
          return;
        }
        for (const child of node.children) emit(child);
      }
      emit(tree.rootNode);
      code = '';
      let previous;
      const word = /[\p{L}\p{N}_]/u;
      const mergedOperators = new Set(['--', '[[', '[=', '..', '//', '==', '~=', '<=', '>=', '::', '->', '+=', '-=', '*=', '/=', '%=', '^=']);
      for (const token of tokens) {
        if (token.directive) {
          code += `${code && !code.endsWith('\n') ? '\n' : ''}${token.text}\n`;
          previous = undefined;
          continue;
        }
        if (previous) {
          const last = previous.text.at(-1);
          const first = token.text[0];
          if ((word.test(last) && word.test(first)) ||
            (previous.number && first === '.') ||
            (last === '.' && /^[0-9]/.test(first)) ||
            mergedOperators.has(last + first)) code += ' ';
        }
        code += token.text;
        previous = token;
      }
      code = code.trim();
    } else {
      code = applyRange(source, 0, source.length, sorted);
    }
    code = stamp(code);
    try {
      state.loadstring(code, 'output', true);
    } catch (error) {
      if (error instanceof CompileError) throw new Error(`Output validation failed. No output was returned: ${error.message}`);
      throw error;
    }
    return {
      code,
      warnings,
      stats: {
        inputBytes: Buffer.byteLength(source),
        outputBytes: Buffer.byteLength(code),
        renamedLocals: renamed,
        encodedStrings: encoded,
        durationMs: Math.round(performance.now() - started),
        virtualized: 0,
        functions: 0,
        instructions: 0,
      },
    };
  } finally {
    state.destroy();
  }
}
