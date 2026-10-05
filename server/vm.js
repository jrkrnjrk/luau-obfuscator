import { randomBytes } from 'node:crypto';

export class UnsupportedError extends Error {}

const OP_NAMES = [
  'MOVE', 'LOADK', 'LOADNIL', 'LOADBOOL', 'GETUPVAL', 'SETUPVAL', 'GETGLOBAL', 'SETGLOBAL',
  'GETTABK', 'GETTAB', 'SETTABK', 'SETTAB', 'NEWTABLE', 'ADD', 'SUB', 'MUL', 'DIV', 'IDIV',
  'MOD', 'POW', 'CONCAT', 'UNM', 'NOT', 'LEN', 'EQ', 'LT', 'LE', 'JMP', 'TEST', 'ISNIL',
  'CALL', 'CALLM', 'RETURN', 'RETURNM', 'CLOSURE', 'VARARG', 'TFORINIT', 'SETLISTM', 'BOX',
  'COPYOPEN', 'MAKEOPEN', 'PREPEND', 'NOP',
];

const BINARY = {
  '+': 'ADD', '-': 'SUB', '*': 'MUL', '/': 'DIV', '//': 'IDIV', '%': 'MOD', '^': 'POW', '..': 'CONCAT',
};
const UPDATE = {
  '+=': 'ADD', '-=': 'SUB', '*=': 'MUL', '/=': 'DIV', '//=': 'IDIV', '%=': 'MOD', '^=': 'POW', '..=': 'CONCAT',
};

function shuffleOpcodes() {
  const names = [...OP_NAMES];
  for (let i = names.length - 1; i > 0; i--) {
    const j = randomBytes(1)[0] % (i + 1);
    [names[i], names[j]] = [names[j], names[i]];
  }
  return Object.fromEntries(names.map((name, index) => [name, index + 3]));
}

function id() {
  return `_v${randomBytes(3).toString('hex')}`;
}

function parseNumber(text) {
  const compact = text.replaceAll('_', '');
  if (/^0[bB][01]+$/.test(compact)) return Number.parseInt(compact.slice(2), 2);
  if (/^0[xX]/.test(compact) && /[pP.]/.test(compact.slice(2))) {
    throw new UnsupportedError(`Unsupported numeric literal "${text}"`);
  }
  const value = Number(compact);
  if (!Number.isFinite(value)) throw new UnsupportedError(`Unsupported numeric literal "${text}"`);
  return value;
}

function decodeString(text) {
  if (text[0] === '[') {
    const opening = text.match(/^\[(=*)\[/)[0];
    let content = text.slice(opening.length, -opening.length);
    content = content.replace(/\r\n/g, '\n');
    if (content.startsWith('\n')) content = content.slice(1);
    return Buffer.from(content);
  }
  return decodeEscapes(text.slice(1, -1));
}

function decodeEscapes(content) {
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
      bytes.push(Number.parseInt(content.slice(i, i + 2), 16));
      i += 2;
    } else if (char === 'u') {
      const end = content.indexOf('}', i + 1);
      bytes.push(...Buffer.from(String.fromCodePoint(Number.parseInt(content.slice(i + 1, end), 16))));
      i = end + 1;
    } else if (/[0-9]/.test(char)) {
      const digits = (char + content.slice(i)).match(/^[0-9]{1,3}/)[0];
      bytes.push(Number(digits));
      i += digits.length - 1;
    } else if (char === '\r' || char === '\n') {
      if ((char === '\r' && content[i] === '\n') || (char === '\n' && content[i] === '\r')) i++;
      bytes.push(10);
    } else bytes.push(...Buffer.from(char));
  }
  return Buffer.from(bytes);
}

class Writer {
  constructor() { this.parts = []; }
  u8(value) { this.parts.push(Buffer.from([value & 255])); }
  u32(value) {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(value >>> 0);
    this.parts.push(buf);
  }
  i32(value) {
    const buf = Buffer.alloc(4);
    buf.writeInt32LE(value | 0);
    this.parts.push(buf);
  }
  f64(value) {
    const buf = Buffer.alloc(8);
    buf.writeDoubleLE(value);
    this.parts.push(buf);
  }
  bytes(value) {
    this.u32(value.length);
    this.parts.push(value);
  }
  buffer() { return Buffer.concat(this.parts); }
}

class Scope {
  constructor() { this.vars = new Map(); }
}

class FuncState {
  constructor(parent, ops) {
    this.parent = parent;
    this.ops = ops;
    this.code = [];
    this.constants = [];
    this.constMap = new Map();
    this.subs = [];
    this.updescs = [];
    this.upMap = new Map();
    this.nparams = 0;
    this.vararg = false;
    this.nextReg = 1;
    this.scopeStack = [new Scope()];
    this.loops = [];
  }

  emit(op, a = 0, b = 0, c = 0) {
    this.code.push([op, a | 0, b | 0, c | 0]);
    return this.code.length;
  }

  here() { return this.code.length + 1; }
  patch(at, target) { this.code[at - 1][1] = target; }
  alloc() { return this.nextReg++; }
  pushScope() { this.scopeStack.push(new Scope()); }
  popScope() { this.scopeStack.pop(); }

  addConst(tag, value) {
    const key = tag === 'str' ? `s:${value.toString('base64')}` : `${tag}:${Object.is(value, -0) ? '-0' : String(value)}`;
    if (this.constMap.has(key)) return this.constMap.get(key);
    this.constants.push({ tag, value });
    const index = this.constants.length;
    this.constMap.set(key, index);
    return index;
  }

  bind(name, reg, ids) {
    const binding = { id: ++ids.value, reg };
    this.scopeStack.at(-1).vars.set(name, binding);
    return binding;
  }

  addParam(name, ids) {
    this.nparams++;
    const reg = this.nparams;
    this.nextReg = Math.max(this.nextReg, reg + 1);
    this.bind(name, reg, ids);
  }
}

class Compiler {
  constructor(source, ops) {
    this.source = source;
    this.ops = ops;
    this.ids = { value: 0 };
    this.instructions = 0;
    this.functions = 0;
    this.strings = 0;
    this.locals = 0;
    this.typed = false;
    this.current = null;
  }

  fail(node, detail = '') {
    throw new UnsupportedError(`Unsupported syntax (${node.type}${detail ? `: ${detail}` : ''}) near "${node.text.slice(0, 48).replaceAll('\n', ' ')}"`);
  }

  slice(node) { return this.source.slice(node.startIndex, node.endIndex); }

  compile(root) {
    const main = new FuncState(null, this.ops);
    main.vararg = true;
    this.current = main;
    this.functions++;
    for (const child of root.namedChildren) this.stat(child);
    this.emit(this.ops.RETURN, 0, 0, 0);
    return main;
  }

  emit(op, a, b, c) {
    this.instructions++;
    return this.current.emit(op, a, b, c);
  }

  jumpIf(reg, truthy) {
    this.emit(this.ops.TEST, reg, truthy ? 1 : 0);
    return this.emit(this.ops.JMP, 0);
  }

  lookup(func, name) {
    for (let i = func.scopeStack.length - 1; i >= 0; i--) {
      if (func.scopeStack[i].vars.has(name)) return { kind: 'local', binding: func.scopeStack[i].vars.get(name) };
    }
    if (!func.parent) return { kind: 'global', name };
    const outer = this.lookup(func.parent, name);
    if (outer.kind === 'global') return outer;
    const key = outer.kind === 'local' ? `l${outer.binding.id}` : `u${outer.index}`;
    if (!func.upMap.has(key)) {
      func.updescs.push(outer.kind === 'local' ? [1, outer.binding.reg] : [0, outer.index]);
      func.upMap.set(key, func.updescs.length);
    }
    return { kind: 'upval', index: func.upMap.get(key) };
  }

  load(resolved, dest) {
    if (resolved.kind === 'local') this.emit(this.ops.GETTABK, dest, resolved.binding.reg, this.kNum(1));
    else if (resolved.kind === 'upval') this.emit(this.ops.GETUPVAL, dest, resolved.index);
    else this.emit(this.ops.GETGLOBAL, dest, this.kStr(Buffer.from(resolved.name)));
  }

  store(target, src) {
    if (target.kind === 'local') this.emit(this.ops.SETTABK, target.binding.reg, this.kNum(1), src);
    else if (target.kind === 'upval') this.emit(this.ops.SETUPVAL, src, target.index);
    else if (target.kind === 'global') this.emit(this.ops.SETGLOBAL, src, this.kStr(Buffer.from(target.name)));
    else if (target.kind === 'fieldk') this.emit(this.ops.SETTABK, target.table, this.kStr(Buffer.from(target.key)), src);
    else this.emit(this.ops.SETTAB, target.table, target.key, src);
  }

  kNum(value) { return this.current.addConst('num', value); }
  kBool(value) { return this.current.addConst('bool', value); }
  kStr(value) {
    const before = this.current.constants.length;
    const index = this.current.addConst('str', value);
    if (this.current.constants.length !== before) this.strings++;
    return index;
  }

  box(reg) { this.emit(this.ops.BOX, reg); }

  stat(node) {
    switch (node.type) {
      case 'comment':
      case 'empty_statement':
        return;
      case 'type_definition':
        this.typed = true;
        return;
      case 'variable_declaration':
        this.localDecl(node);
        return;
      case 'function_declaration':
        this.functionDecl(node);
        return;
      case 'assignment_statement':
        this.assign(node.namedChildren[0], node.namedChildren[1]);
        return;
      case 'update_statement':
        this.update(node);
        return;
      case 'do_statement':
        this.current.pushScope();
        this.block(node.childForFieldName('body') || node.namedChildren.find(child => child.type === 'block'));
        this.current.popScope();
        return;
      case 'while_statement':
        this.whileStat(node);
        return;
      case 'repeat_statement':
        this.repeatStat(node);
        return;
      case 'for_statement':
        this.forStat(node);
        return;
      case 'if_statement':
        this.ifStat(node, false, 0);
        return;
      case 'return_statement':
        this.returnStat(node);
        return;
      case 'break_statement':
      case 'continue_statement':
        this.loopJump(node.type === 'break_statement');
        return;
      case 'function_call':
        this.call(node, 0, 0);
        return;
      default:
        this.fail(node);
    }
  }

  block(node) {
    if (!node) return;
    for (const child of node.namedChildren) this.stat(child);
  }

  localDecl(node) {
    const assignment = node.namedChildren[0];
    if (assignment.type === 'function_declaration') {
      this.functionDecl(assignment, true);
      return;
    }
    const list = assignment.type === 'assignment_statement' ? assignment.namedChildren[0] : assignment;
    const values = assignment.type === 'assignment_statement' ? assignment.namedChildren[1] : null;
    const names = [...list.childrenForFieldName('name')];
    if (list.namedChildren.some(child => child.type === 'attribute' || child.type.endsWith('_type') || child.type === 'builtin_type')) this.typed = true;
    // Initializers run in the outer scope; the new names are not visible yet.
    const slots = values ? this.exprList(values.namedChildren, names.length) : [];
    const regs = names.map(name => {
      const reg = this.current.alloc();
      this.current.bind(name.text, reg, this.ids);
      this.locals++;
      return reg;
    });
    regs.forEach((reg, index) => {
      if (slots[index] == null) this.emit(this.ops.LOADNIL, reg, reg);
      else this.emit(this.ops.MOVE, reg, slots[index]);
      this.box(reg);
    });
  }

  functionDecl(node, forceLocal = false) {
    const isLocal = forceLocal || node.children.some(child => !child.isNamed && child.text === 'local');
    const name = node.childForFieldName('name');
    if (isLocal) {
      const reg = this.current.alloc();
      this.current.bind(name.text, reg, this.ids);
      this.locals++;
      this.emit(this.ops.LOADNIL, reg, reg);
      this.box(reg);
      const proto = this.functionProto(node, []);
      const temp = this.current.alloc();
      this.emit(this.ops.CLOSURE, temp, proto);
      this.emit(this.ops.SETTABK, reg, this.kNum(1), temp);
      return;
    }
    if (name.type === 'identifier') {
      const target = this.lookup(this.current, name.text);
      const proto = this.functionProto(node, []);
      const temp = this.current.alloc();
      this.emit(this.ops.CLOSURE, temp, proto);
      this.store(target, temp);
      return;
    }
    if (name.type === 'method_index_expression') {
      const table = this.current.alloc();
      this.expr(name.childForFieldName('table'), table);
      const proto = this.functionProto(node, ['self']);
      const temp = this.current.alloc();
      this.emit(this.ops.CLOSURE, temp, proto);
      this.emit(this.ops.SETTABK, table, this.kStr(Buffer.from(name.childForFieldName('method').text)), temp);
      return;
    }
    if (name.type === 'dot_index_expression') {
      const table = this.current.alloc();
      this.expr(name.childForFieldName('table'), table);
      const proto = this.functionProto(node, []);
      const temp = this.current.alloc();
      this.emit(this.ops.CLOSURE, temp, proto);
      this.emit(this.ops.SETTABK, table, this.kStr(Buffer.from(name.childForFieldName('field').text)), temp);
      return;
    }
    this.fail(name, 'function name');
  }

  functionProto(node, implicit) {
    const outer = this.current;
    const func = new FuncState(outer, this.ops);
    this.functions++;
    this.current = func;
    for (const name of implicit) func.addParam(name, this.ids);
    const parameters = node.childForFieldName('parameters');
    for (const parameter of parameters?.namedChildren ?? []) {
      if (parameter.namedChildren.some(child => child.type !== 'identifier' && child.type !== 'vararg_expression')) this.typed = true;
      const id = parameter.namedChildren.find(child => child.type === 'identifier' || child.type === 'vararg_expression');
      if (!id || id.type === 'vararg_expression') func.vararg = true;
      else func.addParam(id.text, this.ids);
    }
    if (node.namedChildren.some(child => child.type.endsWith('_type') || child.type === 'builtin_type' || child.type === 'generic_type_list')) this.typed = true;
    this.block(node.childForFieldName('body'));
    this.emit(this.ops.RETURN, 0, 0, 0);
    this.current = outer;
    outer.subs.push(func);
    return outer.subs.length;
  }

  assign(varlist, exprlist) {
    const targets = varlist.namedChildren
      .filter(child => !child.type.endsWith('_type') && child.type !== 'attribute' && child.type !== 'builtin_type')
      .map(child => this.target(child));
    const slots = exprlist ? this.exprList(exprlist.namedChildren, targets.length) : [];
    targets.forEach((target, index) => {
      if (slots[index] == null) {
        const nilReg = this.current.alloc();
        this.emit(this.ops.LOADNIL, nilReg, nilReg);
        this.store(target, nilReg);
      } else this.store(target, slots[index]);
    });
  }

  target(node) {
    if (node.type === 'identifier') return this.lookup(this.current, node.text);
    if (node.type === 'dot_index_expression') {
      const table = this.current.alloc();
      this.expr(node.childForFieldName('table'), table);
      return { kind: 'fieldk', table, key: node.childForFieldName('field').text };
    }
    if (node.type === 'bracket_index_expression') {
      const table = this.current.alloc();
      const key = this.current.alloc();
      this.expr(node.childForFieldName('table'), table);
      this.expr(node.childForFieldName('field'), key);
      return { kind: 'field', table, key };
    }
    this.fail(node, 'assignment target');
  }

  update(node) {
    const op = node.children.find(child => !child.isNamed && child.text in UPDATE)?.text;
    if (!op) this.fail(node, 'compound assignment');
    const target = this.target(node.namedChildren[0].namedChildren[0]);
    const current = this.current.alloc();
    if (target.kind === 'local' || target.kind === 'upval' || target.kind === 'global') this.load(target, current);
    else if (target.kind === 'fieldk') this.emit(this.ops.GETTABK, current, target.table, this.kStr(Buffer.from(target.key)));
    else this.emit(this.ops.GETTAB, current, target.table, target.key);
    const value = this.current.alloc();
    this.expr(node.namedChildren[1].namedChildren[0], value);
    this.emit(this.ops[UPDATE[op]], current, current, value);
    this.store(target, current);
  }

  whileStat(node) {
    const loop = { breaks: [], continues: [] };
    this.current.loops.push(loop);
    const start = this.current.here();
    const cond = this.current.alloc();
    this.expr(node.childForFieldName('condition'), cond);
    const exit = this.jumpIf(cond, false);
    this.current.pushScope();
    this.block(node.childForFieldName('body'));
    this.current.popScope();
    this.emit(this.ops.JMP, start);
    const end = this.current.here();
    this.current.patch(exit, end);
    for (const at of loop.continues) this.current.patch(at, start);
    for (const at of loop.breaks) this.current.patch(at, end);
    this.current.loops.pop();
  }

  repeatStat(node) {
    const loop = { breaks: [], continues: [] };
    this.current.loops.push(loop);
    this.current.pushScope();
    const start = this.current.here();
    this.block(node.childForFieldName('body'));
    const check = this.current.here();
    for (const at of loop.continues) this.current.patch(at, check);
    const cond = this.current.alloc();
    this.expr(node.childForFieldName('condition'), cond);
    const back = this.jumpIf(cond, false);
    this.current.patch(back, start);
    const end = this.current.here();
    for (const at of loop.breaks) this.current.patch(at, end);
    this.current.popScope();
    this.current.loops.pop();
  }

  forStat(node) {
    const clause = node.childForFieldName('clause');
    if (clause.type === 'for_numeric_clause') this.numericFor(node, clause);
    else this.genericFor(node, clause);
  }

  numericFor(node, clause) {
    const idx = this.current.alloc();
    const limit = this.current.alloc();
    const step = this.current.alloc();
    this.expr(clause.childForFieldName('start'), idx);
    this.expr(clause.childForFieldName('end'), limit);
    const stepNode = clause.childForFieldName('step');
    if (stepNode) this.expr(stepNode, step);
    else this.emit(this.ops.LOADK, step, this.kNum(1));
    const zero = this.current.alloc();
    this.emit(this.ops.LOADK, zero, this.kNum(0));
    this.emit(this.ops.EQ, 1, step, zero);
    const zeroExit = this.emit(this.ops.JMP, 0);
    const check = this.current.here();
    // Skip the following jump when the step is negative, so that path falls through.
    this.emit(this.ops.LE, 1, zero, step);
    const toPositive = this.emit(this.ops.JMP, 0);
    this.emit(this.ops.LE, 1, limit, idx);
    const enterNeg = this.emit(this.ops.JMP, 0);
    const exitNeg = this.emit(this.ops.JMP, 0);
    const positive = this.current.here();
    this.current.patch(toPositive, positive);
    this.emit(this.ops.LE, 1, idx, limit);
    const enterPos = this.emit(this.ops.JMP, 0);
    const exitPos = this.emit(this.ops.JMP, 0);
    const body = this.current.here();
    this.current.patch(enterPos, body);
    this.current.patch(enterNeg, body);
    this.current.pushScope();
    const visible = this.current.alloc();
    this.current.bind(clause.childForFieldName('name').text, visible, this.ids);
    this.locals++;
    this.emit(this.ops.MOVE, visible, idx);
    this.box(visible);
    const loop = { breaks: [], continues: [] };
    this.current.loops.push(loop);
    this.block(node.childForFieldName('body'));
    const increment = this.current.here();
    for (const at of loop.continues) this.current.patch(at, increment);
    this.emit(this.ops.ADD, idx, idx, step);
    this.emit(this.ops.JMP, check);
    const end = this.current.here();
    this.current.patch(zeroExit, end);
    this.current.patch(exitPos, end);
    this.current.patch(exitNeg, end);
    for (const at of loop.breaks) this.current.patch(at, end);
    this.current.loops.pop();
    this.current.popScope();
  }

  genericFor(node, clause) {
    const base = this.current.alloc();
    this.current.alloc();
    this.current.alloc();
    this.openExprList(clause.namedChildren[1]);
    this.emit(this.ops.TFORINIT, base);
    const names = [...clause.namedChildren[0].childrenForFieldName('name')];
    const loop = { breaks: [], continues: [] };
    this.current.loops.push(loop);
    const start = this.current.here();
    const call = this.current.alloc();
    for (let i = 1; i < Math.max(names.length, 3); i++) this.current.alloc();
    this.emit(this.ops.MOVE, call, base);
    this.emit(this.ops.MOVE, call + 1, base + 1);
    this.emit(this.ops.MOVE, call + 2, base + 2);
    this.emit(this.ops.CALL, call, 2, names.length);
    this.emit(this.ops.ISNIL, call, 1);
    const exit = this.emit(this.ops.JMP, 0);
    this.current.pushScope();
    names.forEach((name, index) => {
      const reg = this.current.alloc();
      this.current.bind(name.text, reg, this.ids);
      this.locals++;
      this.emit(this.ops.MOVE, reg, call + index);
      this.box(reg);
    });
    this.emit(this.ops.MOVE, base + 2, call);
    this.block(node.childForFieldName('body'));
    this.current.popScope();
    this.emit(this.ops.JMP, start);
    const end = this.current.here();
    this.current.patch(exit, end);
    for (const at of loop.continues) this.current.patch(at, start);
    for (const at of loop.breaks) this.current.patch(at, end);
    this.current.loops.pop();
  }

  loopJump(isBreak) {
    const loop = this.current.loops.at(-1);
    if (!loop) throw new UnsupportedError('continue/break could not be placed in a loop');
    const at = this.emit(this.ops.JMP, 0);
    (isBreak ? loop.breaks : loop.continues).push(at);
  }

  ifStat(node, asExpr, dest) {
    const parts = [{
      cond: node.childForFieldName('condition'),
      body: node.childForFieldName('consequence'),
    }];
    for (const alt of node.namedChildren) {
      if (alt.type === 'elseif_statement' || alt.type === 'elseif_clause') {
        parts.push({ cond: alt.childForFieldName('condition'), body: alt.childForFieldName('consequence') });
      } else if (alt.type === 'else_statement' || alt.type === 'else_clause') {
        parts.push({ body: alt.childForFieldName('body') || alt.childForFieldName('consequence'), isElse: true });
      }
    }
    const ends = [];
    parts.forEach((part, index) => {
      let skip = 0;
      if (!part.isElse) {
        const cond = this.current.alloc();
        this.expr(part.cond, cond);
        skip = this.jumpIf(cond, false);
      }
      if (asExpr) {
        if (part.body && part.body.type !== 'block') this.expr(part.body, dest);
        else this.emit(this.ops.LOADNIL, dest, dest);
      } else {
        this.current.pushScope();
        this.block(part.body);
        this.current.popScope();
      }
      const hasElse = parts.some(part => part.isElse);
      if (index !== parts.length - 1 || (asExpr && !hasElse)) ends.push(this.emit(this.ops.JMP, 0));
      if (skip) this.current.patch(skip, this.current.here());
    });
    if (asExpr && !parts.some(part => part.isElse)) this.emit(this.ops.LOADNIL, dest, dest);
    const end = this.current.here();
    for (const at of ends) this.current.patch(at, end);
  }

  returnStat(node) {
    const list = node.namedChildren.find(child => child.type === 'expression_list');
    const exprs = list?.namedChildren ?? [];
    if (!exprs.length) {
      this.emit(this.ops.RETURN, 0, 0, 0);
      return;
    }
    const last = exprs.at(-1);
    const prefix = isMulti(last) ? exprs.slice(0, -1) : exprs;
    const slots = prefix.map(expr => {
      const reg = this.current.alloc();
      this.expr(expr, reg);
      return reg;
    });
    if (isMulti(last)) {
      this.openExpr(last);
      if (!slots.length) {
        this.emit(this.ops.RETURNM, 0, 0);
        return;
      }
      const base = this.current.alloc();
      slots.forEach((slot, index) => this.emit(this.ops.MOVE, base + index, slot));
      this.emit(this.ops.RETURNM, base, slots.length);
      return;
    }
    const base = this.current.alloc();
    slots.forEach((slot, index) => this.emit(this.ops.MOVE, base + index, slot));
    this.emit(this.ops.RETURN, base, slots.length);
  }

  exprList(exprs, needed) {
    const slots = [];
    exprs.forEach((expr, index) => {
      const last = index === exprs.length - 1;
      if (last && isMulti(expr)) {
        this.openExpr(expr);
        const count = Math.max(needed - index, 1);
        for (let i = 0; i < count; i++) {
          const reg = this.current.alloc();
          this.emit(this.ops.COPYOPEN, reg, i + 1);
          slots.push(reg);
        }
      } else {
        const reg = this.current.alloc();
        this.expr(expr, reg);
        slots.push(reg);
      }
    });
    return slots;
  }

  materialize(slots, opcode) {
    const base = slots.length ? this.current.alloc() : 0;
    for (let i = 1; i < slots.length; i++) this.current.alloc();
    slots.forEach((slot, index) => this.emit(this.ops.MOVE, base + index, slot));
    this.emit(opcode, base, slots.length);
  }

  openExprList(list) {
    const exprs = list?.namedChildren ?? [];
    if (!exprs.length) {
      this.emit(this.ops.MAKEOPEN, 0, 0);
      return;
    }
    const last = exprs.at(-1);
    if (exprs.length === 1 && isMulti(last)) {
      this.openExpr(last);
      return;
    }
    if (isMulti(last)) {
      const prefix = this.exprList(exprs.slice(0, -1), exprs.length - 1);
      this.openExpr(last);
      this.materialize(prefix, this.ops.PREPEND);
      return;
    }
    this.materialize(this.exprList(exprs, exprs.length), this.ops.MAKEOPEN);
  }

  openExpr(node) {
    if (node.type === 'vararg_expression') {
      this.emit(this.ops.VARARG, 0, -1);
      return;
    }
    if (node.type === 'parenthesized_expression') {
      const reg = this.current.alloc();
      this.expr(node.namedChildren[0], reg);
      this.emit(this.ops.LOADK, reg + 1, this.kNum(1));
      this.emit(this.ops.NEWTABLE, reg + 2);
      this.emit(this.ops.SETTABK, reg + 2, this.kNum(1), reg);
      this.emit(this.ops.SETTABK, reg + 2, this.kNum(2), this.current.alloc());
      return;
    }
    this.call(node, 0, -1);
  }

  expr(node, dest) {
    switch (node.type) {
      case 'identifier':
        this.load(this.lookup(this.current, node.text), dest);
        return;
      case 'number':
        this.emit(this.ops.LOADK, dest, this.kNum(parseNumber(node.text)));
        return;
      case 'string':
        this.stringExpr(node, dest);
        return;
      case 'true':
      case 'false':
        this.emit(this.ops.LOADK, dest, this.kBool(node.type === 'true'));
        return;
      case 'nil':
        this.emit(this.ops.LOADNIL, dest, dest);
        return;
      case 'parenthesized_expression':
      case 'cast_expression':
        this.expr(node.namedChildren[0], dest);
        return;
      case 'unary_expression':
        this.unary(node, dest);
        return;
      case 'binary_expression':
        this.binary(node, dest);
        return;
      case 'if_expression':
        this.ifStat(node, true, dest);
        return;
      case 'function_call':
        this.call(node, dest, 1);
        return;
      case 'function_definition':
        this.emit(this.ops.CLOSURE, dest, this.functionProto(node, []));
        return;
      case 'table_constructor':
        this.table(node, dest);
        return;
      case 'dot_index_expression':
        this.expr(node.childForFieldName('table'), dest);
        this.emit(this.ops.GETTABK, dest, dest, this.kStr(Buffer.from(node.childForFieldName('field').text)));
        return;
      case 'bracket_index_expression': {
        const key = this.current.alloc();
        this.expr(node.childForFieldName('table'), dest);
        this.expr(node.childForFieldName('field'), key);
        this.emit(this.ops.GETTAB, dest, dest, key);
        return;
      }
      case 'vararg_expression':
        this.emit(this.ops.VARARG, dest, 1);
        return;
      default:
        this.fail(node, 'expression');
    }
  }

  stringExpr(node, dest) {
    if (this.slice(node)[0] === '`') {
      const parts = node.namedChildren;
      if (!parts.length) {
        this.emit(this.ops.LOADK, dest, this.kStr(Buffer.alloc(0)));
        return;
      }
      this.interpolationPiece(parts[0], dest);
      for (const part of parts.slice(1)) {
        const next = this.current.alloc();
        this.interpolationPiece(part, next);
        this.emit(this.ops.CONCAT, dest, dest, next);
      }
      return;
    }
    this.emit(this.ops.LOADK, dest, this.kStr(decodeString(this.slice(node))));
  }

  interpolationPiece(node, dest) {
    if (node.type === 'string_content') {
      this.emit(this.ops.LOADK, dest, this.kStr(decodeEscapes(this.slice(node))));
      return;
    }
    if (node.type === 'escape_sequence') {
      this.emit(this.ops.LOADK, dest, this.kStr(decodeEscapes(this.slice(node))));
      return;
    }
    const value = this.current.alloc();
    this.expr(node.namedChildren[0], value);
    this.emit(this.ops.GETGLOBAL, dest, this.kStr(Buffer.from('tostring')));
    this.emit(this.ops.MOVE, dest + 1, value);
    this.emit(this.ops.CALL, dest, 1, 1);
  }

  unary(node, dest) {
    const op = node.children.find(child => !child.isNamed).text;
    const operand = node.childForFieldName('operand') || node.namedChildren[0];
    this.expr(operand, dest);
    const map = { '-': 'UNM', 'not': 'NOT', '#': 'LEN' };
    if (!map[op]) this.fail(node, op);
    this.emit(this.ops[map[op]], dest, dest);
  }

  binary(node, dest) {
    const op = node.children.find(child => !child.isNamed).text;
    const left = node.childForFieldName('left');
    const right = node.childForFieldName('right');
    if (op === 'and' || op === 'or') {
      this.expr(left, dest);
      const skip = this.jumpIf(dest, op === 'or');
      this.expr(right, dest);
      this.current.patch(skip, this.current.here());
      return;
    }
    const l = this.current.alloc();
    const r = this.current.alloc();
    this.expr(left, l);
    this.expr(right, r);
    if (op in BINARY) {
      this.emit(this.ops[BINARY[op]], dest, l, r);
      return;
    }
    const compare = op === '~=' ? 'EQ' : op === '>' ? 'LT' : op === '>=' ? 'LE' : op === '==' ? 'EQ' : op === '<' ? 'LT' : op === '<=' ? 'LE' : '';
    if (!compare) this.fail(node, op);
    const a = op === '~=' ? r : op === '>' || op === '>=' ? r : l;
    const b = op === '~=' ? l : op === '>' || op === '>=' ? l : r;
    const expect = op === '~=' ? 0 : 1;
    this.emit(this.ops[compare], expect, a, b);
    const whenTrue = this.emit(this.ops.JMP, 0);
    this.emit(this.ops.LOADBOOL, dest, 0);
    const done = this.emit(this.ops.JMP, 0);
    this.current.patch(whenTrue, this.current.here());
    this.emit(this.ops.LOADBOOL, dest, 1);
    this.current.patch(done, this.current.here());
  }

  call(node, dest, nret) {
    const callee = node.childForFieldName('name');
    const args = callArgs(node);
    let funcReg;
    let argTemps = [];
    let leading = [];
    if (callee.type === 'method_index_expression') {
      const obj = this.current.alloc();
      this.expr(callee.childForFieldName('table'), obj);
      funcReg = this.current.alloc();
      this.emit(this.ops.GETTABK, funcReg, obj, this.kStr(Buffer.from(callee.childForFieldName('method').text)));
      leading = [obj];
    } else {
      funcReg = this.current.alloc();
      this.expr(callee, funcReg);
    }
    const last = args.at(-1);
    const fixedArgs = isMulti(last) ? args.slice(0, -1) : args;
    argTemps = fixedArgs.map(arg => {
      const reg = this.current.alloc();
      this.expr(arg, reg);
      return reg;
    });
    if (isMulti(last)) this.openExpr(last);
    const base = this.current.alloc();
    this.emit(this.ops.MOVE, base, funcReg);
    [...leading, ...argTemps].forEach((slot, index) => this.emit(this.ops.MOVE, base + 1 + index, slot));
    const argc = leading.length + argTemps.length;
    this.emit(isMulti(last) ? this.ops.CALLM : this.ops.CALL, base, argc, nret);
    if (nret === 1 && dest && dest !== base) this.emit(this.ops.MOVE, dest, base);
  }

  table(node, dest) {
    this.emit(this.ops.NEWTABLE, dest);
    let index = 1;
    const fields = node.namedChildren.filter(child => child.type === 'field');
    fields.forEach((field, fieldIndex) => {
      const keyNode = field.childForFieldName('name');
      const valueNode = field.childForFieldName('value');
      if (!keyNode) {
        if (fieldIndex === fields.length - 1 && isMulti(valueNode)) {
          this.openExpr(valueNode);
          this.emit(this.ops.SETLISTM, dest, index);
        } else {
          const value = this.current.alloc();
          this.expr(valueNode, value);
          this.emit(this.ops.SETTABK, dest, this.kNum(index), value);
        }
        index++;
        return;
      }
      const value = this.current.alloc();
      this.expr(valueNode, value);
      if (field.children[0].type === '[') {
        const key = this.current.alloc();
        this.expr(keyNode, key);
        this.emit(this.ops.SETTAB, dest, key, value);
      } else {
        this.emit(this.ops.SETTABK, dest, this.kStr(Buffer.from(keyNode.text)), value);
      }
    });
  }
}

function isMulti(node) {
  return node && ['function_call', 'vararg_expression'].includes(node.type);
}

function callArgs(node) {
  const args = node.childForFieldName('arguments');
  if (!args) return [];
  return args.type === 'arguments' ? args.namedChildren : [args];
}

function encodeProto(proto, writer) {
  writer.u8(proto.vararg ? 1 : 0);
  writer.u32(proto.nparams);
  writer.u32(Math.max(proto.nextReg - 1, proto.nparams, 1));
  writer.u32(proto.code.length);
  for (const inst of proto.code) for (const part of inst) writer.i32(part);
  writer.u32(proto.constants.length);
  for (const constant of proto.constants) {
    if (constant.tag === 'bool') {
      writer.u8(1);
      writer.u8(constant.value ? 1 : 0);
    } else if (constant.tag === 'num') {
      writer.u8(2);
      writer.f64(constant.value);
    } else {
      writer.u8(3);
      writer.bytes(constant.value);
    }
  }
  writer.u32(proto.subs.length);
  for (const sub of proto.subs) encodeProto(sub, writer);
  writer.u32(proto.updescs.length);
  for (const [inStack, index] of proto.updescs) {
    writer.u8(inStack);
    writer.u32(index);
  }
}

function encrypt(buffer) {
  const seed = randomBytes(4).readUInt32LE();
  let key = seed;
  for (let i = 0; i < buffer.length; i++) {
    buffer[i] ^= key & 255;
    key = (key * 1664525 + 1013904223) >>> 0;
  }
  return { seed, hex: buffer.toString('hex') };
}

function emitProgram(ops, seed, hex) {
  const n = Object.fromEntries(OP_NAMES.map(name => [name, id()]));
  const locals = Object.fromEntries(['run', 'env', 'blob', 'pos', 'op', 'a', 'b', 'c', 'pc', 'open', 'regs', 'packed', 'args', 'sub', 'uv', 'k', 'code', 'raw', 'key'].map(name => [name, id()]));
  const bodies = {
    MOVE: `${locals.regs}[${locals.a}]=${locals.regs}[${locals.b}]`,
    LOADK: `${locals.regs}[${locals.a}]=${locals.k}[${locals.b}]`,
    LOADNIL: `for ${id()}=${locals.a},${locals.b} do ${locals.regs}[${id()}]=nil end`.replaceAll(/(const )?[a-z]/, ''),
    LOADBOOL: `${locals.regs}[${locals.a}]=${locals.b}~=0`,
    GETUPVAL: `${locals.regs}[${locals.a}]=${locals.uv}[${locals.b}][1]`,
    SETUPVAL: `${locals.uv}[${locals.b}][1]=${locals.regs}[${locals.a}]`,
    GETGLOBAL: `${locals.regs}[${locals.a}]=${locals.env}[${locals.k}[${locals.b}]]`,
    SETGLOBAL: `${locals.env}[${locals.k}[${locals.b}]]=${locals.regs}[${locals.a}]`,
    GETTABK: `${locals.regs}[${locals.a}]=${locals.regs}[${locals.b}][${locals.k}[${locals.c}]]`,
    GETTAB: `${locals.regs}[${locals.a}]=${locals.regs}[${locals.b}][${locals.regs}[${locals.c}]]`,
    SETTABK: `${locals.regs}[${locals.a}][${locals.k}[${locals.b}]]=${locals.regs}[${locals.c}]`,
    SETTAB: `${locals.regs}[${locals.a}][${locals.regs}[${locals.b}]]=${locals.regs}[${locals.c}]`,
    NEWTABLE: `${locals.regs}[${locals.a}]={}`,
    ADD: `${locals.regs}[${locals.a}]=${locals.regs}[${locals.b}]+${locals.regs}[${locals.c}]`,
    SUB: `${locals.regs}[${locals.a}]=${locals.regs}[${locals.b}]-${locals.regs}[${locals.c}]`,
    MUL: `${locals.regs}[${locals.a}]=${locals.regs}[${locals.b}]*${locals.regs}[${locals.c}]`,
    DIV: `${locals.regs}[${locals.a}]=${locals.regs}[${locals.b}]/${locals.regs}[${locals.c}]`,
    IDIV: `${locals.regs}[${locals.a}]=${locals.regs}[${locals.b}]//${locals.regs}[${locals.c}]`,
    MOD: `${locals.regs}[${locals.a}]=${locals.regs}[${locals.b}]%${locals.regs}[${locals.c}]`,
    POW: `${locals.regs}[${locals.a}]=${locals.regs}[${locals.b}]^${locals.regs}[${locals.c}]`,
    CONCAT: `${locals.regs}[${locals.a}]=${locals.regs}[${locals.b}]..${locals.regs}[${locals.c}]`,
    UNM: `${locals.regs}[${locals.a}]=-${locals.regs}[${locals.b}]`,
    NOT: `${locals.regs}[${locals.a}]=not ${locals.regs}[${locals.b}]`,
    LEN: `${locals.regs}[${locals.a}]=#${locals.regs}[${locals.b}]`,
    EQ: `if (${locals.regs}[${locals.b}]==${locals.regs}[${locals.c}])~=(${locals.a}~=0) then ${locals.pc}=${locals.pc}+1 end`,
    LT: `if (${locals.regs}[${locals.b}]<${locals.regs}[${locals.c}])~=(${locals.a}~=0) then ${locals.pc}=${locals.pc}+1 end`,
    LE: `if (${locals.regs}[${locals.b}]<=${locals.regs}[${locals.c}])~=(${locals.a}~=0) then ${locals.pc}=${locals.pc}+1 end`,
    JMP: `${locals.pc}=${locals.a}`,
    TEST: `if ((${locals.regs}[${locals.a}]~=nil and ${locals.regs}[${locals.a}]~=false)~=(${locals.b}~=0)) then ${locals.pc}=${locals.pc}+1 end`,
    ISNIL: `if (${locals.regs}[${locals.a}]==nil)~=(${locals.b}~=0) then ${locals.pc}=${locals.pc}+1 end`,
    CALL: `${locals.packed}=${locals.npack}(${locals.regs}[${locals.a}](${locals.nunpack}(${locals.args},1,${locals.b})))`,
    RETURN: `do local ${id()}=${locals.a}>0 and ${locals.b} or 0 return ${locals.nunpack}(${locals.regs},${locals.a},${locals.a}+${locals.b}-1) end`,
    CLOSURE: `${locals.sub}=${locals.proto}.s[${locals.b}] ${locals.uv}={} for ${id()}=1,#${locals.sub}.u do local ${id()}=${locals.sub}.u[${id()}] if ${id()}[1]==1 then ${locals.uv}[${id()}]=${locals.regs}[${id()}[2]] else ${locals.uv}[${id()}]=${locals.ups}[${id()}[2]] end end ${locals.regs}[${locals.a}]=function(...) return ${locals.run}(${locals.sub},${locals.uv},...) end`,
    VARARG: `${locals.open}={n=math.max(${locals.all}.n-${locals.proto}.p,0)} for ${id()}=1,${locals.open}.n do ${locals.open}[${id()}]=${locals.all}[${locals.proto}.p+${id()}] end if ${locals.b}<0 then else for ${id()}=1,${locals.b} do ${locals.regs}[${locals.a}+${id()}-1]=${locals.open}[${id()}] end end`,
    BOX: `${locals.regs}[${locals.a}]={${locals.regs}[${locals.a}]}`,
    COPYOPEN: `${locals.regs}[${locals.a}]=${locals.open}[${locals.b}]`,
    NOP: ``,
  };
  // The hand-written dispatch below is the actual interpreter. The map above is intentionally
  // not interpolated into broken one-liners; it documents the opcode contract.
  void bodies;
  void n;
  return interpreterSource(ops, locals, seed, hex);
}

function interpreterSource(ops, L, seed, hex) {
  const op = name => ops[name];
  return `local ${L.env}=getfenv()
local ${L.nselect}, ${L.nunpack}, ${L.nbyte}, ${L.nsub}, ${L.nunpackd}, ${L.nband}, ${L.nbxor}, ${L.nchar}, ${L.nnext}, ${L.ntype}, ${L.ngetmt}, ${L.npcall}=select,unpack,string.byte,string.sub,string.unpack,bit32.band,bit32.bxor,string.char,next,type,getmetatable,pcall
local function ${L.npack}(...) return {n=${L.nselect}("#",...),...} end
local function ${L.u8}(${L.blob},${L.pos}) return ${L.nbyte}(${L.blob},${L.pos}), ${L.pos}+1 end
local function ${L.u32}(${L.blob},${L.pos}) local a,b,c,d ${L.pos}=${L.pos} a=${L.nbyte}(${L.blob},${L.pos}) b=${L.nbyte}(${L.blob},${L.pos}+1) c=${L.nbyte}(${L.blob},${L.pos}+2) d=${L.nbyte}(${L.blob},${L.pos}+3) return a+b*256+c*65536+d*16777216, ${L.pos}+4 end
local function ${L.i32}(${L.blob},${L.pos}) local n n,${L.pos}=${L.u32}(${L.blob},${L.pos}) if n>=2147483648 then n=n-4294967296 end return n,${L.pos} end
local function ${L.read}(${L.blob},${L.pos})
 local vararg,nparams,maxstack,ncode,code,nk,constants,nsubs,subs,nups,ups,tag,value,len
 vararg,${L.pos}=${L.u8}(${L.blob},${L.pos})
 nparams,${L.pos}=${L.u32}(${L.blob},${L.pos})
 maxstack,${L.pos}=${L.u32}(${L.blob},${L.pos})
 ncode,${L.pos}=${L.u32}(${L.blob},${L.pos})
 code={}
 for i=1,ncode do local o,a,b,c o,${L.pos}=${L.i32}(${L.blob},${L.pos}) a,${L.pos}=${L.i32}(${L.blob},${L.pos}) b,${L.pos}=${L.i32}(${L.blob},${L.pos}) c,${L.pos}=${L.i32}(${L.blob},${L.pos}) code[i]={o,a,b,c} end
 nk,${L.pos}=${L.u32}(${L.blob},${L.pos})
 constants={}
 for i=1,nk do tag,${L.pos}=${L.u8}(${L.blob},${L.pos}) if tag==1 then value,${L.pos}=${L.u8}(${L.blob},${L.pos}) constants[i]=value~=0 elseif tag==2 then constants[i]=${L.nunpackd}("<d",${L.nsub}(${L.blob},${L.pos},${L.pos}+7)) ${L.pos}=${L.pos}+8 else len,${L.pos}=${L.u32}(${L.blob},${L.pos}) constants[i]=${L.nsub}(${L.blob},${L.pos},${L.pos}+len-1) ${L.pos}=${L.pos}+len end end
 nsubs,${L.pos}=${L.u32}(${L.blob},${L.pos})
 subs={}
 for i=1,nsubs do subs[i],${L.pos}=${L.read}(${L.blob},${L.pos}) end
 nups,${L.pos}=${L.u32}(${L.blob},${L.pos})
 ups={}
 for i=1,nups do local s,x s,${L.pos}=${L.u8}(${L.blob},${L.pos}) x,${L.pos}=${L.u32}(${L.blob},${L.pos}) ups[i]={s,x} end
 return {v=vararg==1,p=nparams,m=maxstack,c=code,k=constants,s=subs,u=ups},${L.pos}
end
local ${L.hex}=[${'='.repeat(4)}[${hex}]${'='.repeat(4)}]
local ${L.raw}={}
for ${L.i}=1,#${L.hex},2 do ${L.raw}[(${L.i}+1)/2]=${L.nchar}(tonumber(${L.nsub}(${L.hex},${L.i},${L.i}+1),16)) end
local ${L.key}=${seed}
local ${L.decoded}={}
for ${L.i}=1,#${L.raw} do ${L.decoded}[${L.i}]=${L.nchar}(${L.nbxor}(${L.nbyte}(${L.raw}[${L.i}]),${L.nband}(${L.key},255))) ${L.key}=${L.nband}(${L.key}*1664525+1013904223,4294967295) end
local ${L.blob}=table.concat(${L.decoded})
local ${L.proto}=${L.read}(${L.blob},1)
local function ${L.run}(${L.proto},${L.ups},...)
 local ${L.all}=${L.npack}(...)
 local ${L.regs}={}
 local ${L.open}={n=0}
 local ${L.k}=${L.proto}.k
 local ${L.code}=${L.proto}.c
 for ${L.i}=1,${L.proto}.p do ${L.regs}[${L.i}]={${L.all}[${L.i}]} end
 local ${L.pc}=1
 while true do
  local ${L.ins}=${L.code}[${L.pc}]
  if ${L.ins}==nil then return end
  ${L.pc}=${L.pc}+1
  local ${L.op},${L.a},${L.b},${L.c}=${L.ins}[1],${L.ins}[2],${L.ins}[3],${L.ins}[4]
  if ${L.op}==${op('NOP')} then
  elseif ${L.op}==${op('MOVE')} then ${L.regs}[${L.a}]=${L.regs}[${L.b}]
  elseif ${L.op}==${op('LOADK')} then ${L.regs}[${L.a}]=${L.k}[${L.b}]
  elseif ${L.op}==${op('LOADNIL')} then for ${L.i}=${L.a},${L.b} do ${L.regs}[${L.i}]=nil end
  elseif ${L.op}==${op('LOADBOOL')} then ${L.regs}[${L.a}]=${L.b}~=0
  elseif ${L.op}==${op('GETUPVAL')} then ${L.regs}[${L.a}]=${L.ups}[${L.b}][1]
  elseif ${L.op}==${op('SETUPVAL')} then ${L.ups}[${L.b}][1]=${L.regs}[${L.a}]
  elseif ${L.op}==${op('GETGLOBAL')} then ${L.regs}[${L.a}]=${L.env}[${L.k}[${L.b}]]
  elseif ${L.op}==${op('SETGLOBAL')} then ${L.env}[${L.k}[${L.b}]]=${L.regs}[${L.a}]
  elseif ${L.op}==${op('GETTABK')} then ${L.regs}[${L.a}]=${L.regs}[${L.b}][${L.k}[${L.c}]]
  elseif ${L.op}==${op('GETTAB')} then ${L.regs}[${L.a}]=${L.regs}[${L.b}][${L.regs}[${L.c}]]
  elseif ${L.op}==${op('SETTABK')} then ${L.regs}[${L.a}][${L.k}[${L.b}]]=${L.regs}[${L.c}]
  elseif ${L.op}==${op('SETTAB')} then ${L.regs}[${L.a}][${L.regs}[${L.b}]]=${L.regs}[${L.c}]
  elseif ${L.op}==${op('NEWTABLE')} then ${L.regs}[${L.a}]={}
  elseif ${L.op}==${op('ADD')} then ${L.regs}[${L.a}]=${L.regs}[${L.b}]+${L.regs}[${L.c}]
  elseif ${L.op}==${op('SUB')} then ${L.regs}[${L.a}]=${L.regs}[${L.b}]-${L.regs}[${L.c}]
  elseif ${L.op}==${op('MUL')} then ${L.regs}[${L.a}]=${L.regs}[${L.b}]*${L.regs}[${L.c}]
  elseif ${L.op}==${op('DIV')} then ${L.regs}[${L.a}]=${L.regs}[${L.b}]/${L.regs}[${L.c}]
  elseif ${L.op}==${op('IDIV')} then ${L.regs}[${L.a}]=${L.regs}[${L.b}]//${L.regs}[${L.c}]
  elseif ${L.op}==${op('MOD')} then ${L.regs}[${L.a}]=${L.regs}[${L.b}]%${L.regs}[${L.c}]
  elseif ${L.op}==${op('POW')} then ${L.regs}[${L.a}]=${L.regs}[${L.b}]^${L.regs}[${L.c}]
  elseif ${L.op}==${op('CONCAT')} then ${L.regs}[${L.a}]=${L.regs}[${L.b}]..${L.regs}[${L.c}]
  elseif ${L.op}==${op('UNM')} then ${L.regs}[${L.a}]=-${L.regs}[${L.b}]
  elseif ${L.op}==${op('NOT')} then ${L.regs}[${L.a}]=not ${L.regs}[${L.b}]
  elseif ${L.op}==${op('LEN')} then ${L.regs}[${L.a}]=#${L.regs}[${L.b}]
  elseif ${L.op}==${op('EQ')} then if (${L.regs}[${L.b}]==${L.regs}[${L.c}])~=(${L.a}~=0) then ${L.pc}=${L.pc}+1 end
  elseif ${L.op}==${op('LT')} then if (${L.regs}[${L.b}]<${L.regs}[${L.c}])~=(${L.a}~=0) then ${L.pc}=${L.pc}+1 end
  elseif ${L.op}==${op('LE')} then if (${L.regs}[${L.b}]<=${L.regs}[${L.c}])~=(${L.a}~=0) then ${L.pc}=${L.pc}+1 end
  elseif ${L.op}==${op('JMP')} then ${L.pc}=${L.a}
  elseif ${L.op}==${op('TEST')} then if ((${L.regs}[${L.a}]~=nil and ${L.regs}[${L.a}]~=false)~=(${L.b}~=0)) then ${L.pc}=${L.pc}+1 end
  elseif ${L.op}==${op('ISNIL')} then if (${L.regs}[${L.a}]==nil)~=(${L.b}~=0) then ${L.pc}=${L.pc}+1 end
  elseif ${L.op}==${op('BOX')} then ${L.regs}[${L.a}]={${L.regs}[${L.a}]}
  elseif ${L.op}==${op('COPYOPEN')} then ${L.regs}[${L.a}]=${L.open}[${L.b}]
  elseif ${L.op}==${op('VARARG')} then ${L.open}={n=math.max(${L.all}.n-${L.proto}.p,0)} for ${L.i}=1,${L.open}.n do ${L.open}[${L.i}]=${L.all}[${L.proto}.p+${L.i}] end if ${L.b}>=0 then for ${L.i}=1,${L.b} do ${L.regs}[${L.a}+${L.i}-1]=${L.open}[${L.i}] end end
  elseif ${L.op}==${op('CALL')} or ${L.op}==${op('CALLM')} then
   local ${L.args}={}
   for ${L.i}=1,${L.b} do ${L.args}[${L.i}]=${L.regs}[${L.a}+${L.i}] end
   local ${L.argc}=${L.b}
   if ${L.op}==${op('CALLM')} then for ${L.i}=1,${L.open}.n do ${L.argc}=${L.argc}+1 ${L.args}[${L.argc}]=${L.open}[${L.i}] end end
   local ${L.packed}=${L.npack}(${L.regs}[${L.a}](${L.nunpack}(${L.args},1,${L.argc})))
   if ${L.c}<0 then ${L.open}=${L.packed} ${L.regs}[${L.a}]=${L.packed}[1] else for ${L.i}=1,${L.c} do ${L.regs}[${L.a}+${L.i}-1]=${L.packed}[${L.i}] end end
  elseif ${L.op}==${op('RETURN')} then local ${L.t}={} for ${L.i}=1,${L.b} do ${L.t}[${L.i}]=${L.regs}[${L.a}+${L.i}-1] end return ${L.nunpack}(${L.t},1,${L.b})
  elseif ${L.op}==${op('RETURNM')} then local ${L.t}={} for ${L.i}=1,${L.b} do ${L.t}[${L.i}]=${L.regs}[${L.a}+${L.i}-1] end for ${L.i}=1,${L.open}.n do ${L.t}[${L.b}+${L.i}]=${L.open}[${L.i}] end return ${L.nunpack}(${L.t},1,${L.b}+${L.open}.n)
  elseif ${L.op}==${op('CLOSURE')} then
   local ${L.sub}=${L.proto}.s[${L.b}]
   local ${L.uv}={}
   for ${L.i}=1,#${L.sub}.u do if ${L.sub}.u[${L.i}][1]==1 then ${L.uv}[${L.i}]=${L.regs}[${L.sub}.u[${L.i}][2]] else ${L.uv}[${L.i}]=${L.ups}[${L.sub}.u[${L.i}][2]] end end
   ${L.regs}[${L.a}]=function(...) return ${L.run}(${L.sub},${L.uv},...) end
  elseif ${L.op}==${op('TFORINIT')} then
   local ${L.f},${L.s},${L.v}=${L.open}[1],${L.open}[2],${L.open}[3]
   if ${L.open}.n==1 then
    local ${L.obj}=${L.f}
    local ${L.mt}
    ${L.npcall}(function() ${L.mt}=${L.ngetmt}(${L.obj}) end)
    if ${L.ntype}(${L.mt})=="table" and ${L.mt}.__iter~=nil then local ${L.packed}=${L.npack}(${L.mt}.__iter(${L.obj})) ${L.f},${L.s},${L.v}=${L.packed}[1],${L.packed}[2],${L.packed}[3]
    elseif ${L.ntype}(${L.obj})=="table" then ${L.f},${L.s},${L.v}=${L.nnext},${L.obj},nil end
   end
   ${L.regs}[${L.a}],${L.regs}[${L.a}+1],${L.regs}[${L.a}+2]=${L.f},${L.s},${L.v}
  elseif ${L.op}==${op('SETLISTM')} then for ${L.i}=1,${L.open}.n do ${L.regs}[${L.a}][${L.b}+${L.i}-1]=${L.open}[${L.i}] end
  elseif ${L.op}==${op('MAKEOPEN')} then ${L.open}={n=${L.b}} for ${L.i}=1,${L.b} do ${L.open}[${L.i}]=${L.regs}[${L.a}+${L.i}-1] end
  elseif ${L.op}==${op('PREPEND')} then local ${L.old}=${L.open} ${L.open}={n=${L.b}+${L.old}.n} for ${L.i}=1,${L.b} do ${L.open}[${L.i}]=${L.regs}[${L.a}+${L.i}-1] end for ${L.j}=1,${L.old}.n do ${L.open}[${L.b}+${L.j}]=${L.old}[${L.j}] end
  else error("bad op") end
 end
end
return ${L.run}(${L.proto},{})
`;
}

// Placeholder identifiers used by interpreterSource. They are created here so the template
// does not depend on emitProgram's unused sketch.
function interpreterBindings() {
  return Object.fromEntries(['env', 'nselect', 'nunpack', 'nbyte', 'nsub', 'nunpackd', 'nband', 'nbxor', 'nchar', 'nnext', 'ntype', 'ngetmt', 'npcall', 'npack', 'u8', 'u32', 'i32', 'read', 'blob', 'pos', 'hex', 'raw', 'key', 'decoded', 'proto', 'run', 'ups', 'all', 'regs', 'open', 'k', 'code', 'pc', 'ins', 'op', 'a', 'b', 'c', 'i', 'j', 'args', 'argc', 'packed', 't', 'sub', 'uv', 'f', 's', 'v', 'obj', 'mt', 'old'].map(name => [name, id()]));
}

export function virtualize(root, source) {
  const ops = shuffleOpcodes();
  const compiler = new Compiler(source, ops);
  const main = compiler.compile(root);
  const writer = new Writer();
  encodeProto(main, writer);
  const { seed, hex } = encrypt(writer.buffer());
  const bindings = interpreterBindings();
  const program = build(ops, bindings, seed, hex);
  const warnings = [
    'Virtualization removes local names and literal bytes from the readable script, but it is not irreversible. The interpreter and encoded program are still on the client. Do not hide secrets or authoritative game logic here.',
    'This is a custom Luau VM, not Roblox bytecode and not a commercial Luraph-equivalent protector. Anti-tamper, anti-debug, and “impossible to reverse” claims would be false. Test in Roblox Studio before publishing.',
  ];
  if (compiler.typed) warnings.push('Type annotations and aliases were erased. They are compile-time information, not runtime checks.');
  return {
    code: program,
    warnings,
    stats: {
      virtualized: true,
      functions: compiler.functions,
      instructions: compiler.instructions,
      renamedLocals: compiler.locals,
      encodedStrings: compiler.strings,
    },
  };
}

function build(ops, L, seed, hex) {
  return interpreterSource(ops, L, seed, hex);
}
