/**
 * mini-dom.mjs —— 零依赖极简 DOM 垫片,用于在 Node 中真实执行 public/*.js 页面脚本。
 *
 * 不是完整 DOM,只实现三个工作台脚本用到的 API:
 *  - document.getElementById/querySelector/querySelectorAll/createElement/body
 *  - 元素 innerHTML 解析(提取 <select id>、<button id>/onclick)、value、dataset、classList、addEventListener
 *  - localStorage、fetch(转发到正在运行的服务)、window===globalThis、alert/confirm 等
 * 目的:像浏览器一样按 HTML 顺序加载 common.js + 页面脚本,验证
 *   1) 跨脚本不再有全局词法冲突(旧缺陷:Identifier 'api' has already been declared);
 *   2) 页面初始化异步渲染后,下拉框由后端数据填充、按钮事件已绑定;
 *   3) 点击按钮等价的事件处理器真的调用后端并再次按后端状态渲染。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const VOID_TAGS = new Set(['input', 'br', 'meta', 'link', 'img', 'hr']);

/** 把元素子树序列化回 HTML(供 innerHTML getter 使用) */
function serializeChildren(el) {
  const self = (node) => {
    if (node.tag === '#text') return node._text || '';
    const attrs = Object.entries(node.attrs || {})
      .map(([k, v]) => (v === '' ? k : `${k}="${String(v).replace(/"/g, '&quot;')}"`))
      .join(' ');
    const head = `<${node.tag}${attrs ? ' ' + attrs : ''}>`;
    if (VOID_TAGS.has(node.tag)) return head;
    const inner = (node._text || '') + node.children.map(self).join('');
    return head + inner + `</${node.tag}>`;
  };
  return el.children.map(self).join('');
}

/** 把 innerHTML 字符串解析成可查询的元素树(只实现页面脚本依赖的查询能力) */
// 起始标签:属性值内允许出现 > 字符;属性支持双引号/单引号/无引号
const TAG_RE = /<\s*(\/?)([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
function parseHTML(ownerDoc, html, parent) {
  const frag = { tag: '#fragment', children: [], attrs: {}, parent, ownerDoc, _text: '' };
  const stack = [frag];
  let last = 0;
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(html))) {
    if (m.index > last) stack[stack.length - 1]._text += html.slice(last, m.index);
    last = TAG_RE.lastIndex;
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const selfClose = m[4] === '/' || VOID_TAGS.has(tag);
    if (closing) {
      for (let k = stack.length - 1; k > 0; k--) if (stack[k].tag === tag) { stack.length = k; break; }
      continue;
    }
    const attrs = {};
    const attrRe = /([\w:-]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let am;
    while ((am = attrRe.exec(m[3] || ''))) attrs[am[1]] = am[3] ?? am[4] ?? am[5] ?? '';
    const el = makeElement(ownerDoc, tag, attrs, stack[stack.length - 1]);
    stack[stack.length - 1].children.push(el);
    if (!selfClose) stack.push(el);
  }
  if (last < html.length) frag._text += html.slice(last);
  return frag;
}

function makeElement(ownerDoc, tag, attrs = {}, parent = null) {
  const el = {
    tag, attrs, parent, ownerDoc,
    children: [], _text: '', dataset: {}, style: {},
    _html: '', _value: attrs.value ?? '',
    listeners: {},
    classList: {
      _set: new Set((attrs.class || '').split(/\s+/).filter(Boolean)),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); }
    },
    get textContent() {
      return this.children.length
        ? this.children.map((c) => c.textContent).join('')
        : this._text;
    },
    set textContent(v) { this._text = String(v); this.children = []; this._html = ''; },
    get innerHTML() { return serializeChildren(this); },
    set innerHTML(v) {
      this._html = String(v ?? '');
      this.children = [];
      this._text = '';
      const frag = parseHTML(this.ownerDoc, this._html, this);
      for (const c of frag.children) { c.parent = this; this.children.push(c); }
      // 浏览器表模型:直接落在 <table> 下的 <tr> 会被隐式 <tbody> 包裹
      if (tag === 'table') {
        const loose = this.children.filter((c) => c.tag === 'tr');
        if (loose.length) {
          const tbody = makeElement(this.ownerDoc, 'tbody', {}, this);
          for (const tr of loose) {
            this.children = this.children.filter((x) => x !== tr);
            tbody.appendChild(tr);
          }
          this.children.push(tbody);
        }
      }
      // <select> 填充后,默认选中第一项(与浏览器一致)
      if (tag === 'select' && this._value === '' && this.querySelector('option[value]')) {
        const first = this.querySelector('option[value]');
        this._value = first ? first.attrs.value : '';
      }
    },
    get value() {
      if (tag === 'select') {
        const opts = queryAll(this, 'option', false);
        const values = opts.map((o) => o.attrs.value ?? '');
        if (values.length && !values.includes(this._value)) return values[0] ?? '';
      }
      return this._value;
    },
    set value(v) { this._value = String(v); },
    appendChild(c) { this.children.push(c); c.parent = this; return c; },
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); },
    addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); },
    removeEventListener(ev, fn) {
      this.listeners[ev] = (this.listeners[ev] || []).filter((f) => f !== fn);
    },
    set onclick(fn) { this.listeners.click = [fn]; },
    get onclick() { return this.listeners.click?.[0] || null; },
    querySelector(sel) { return queryAll(this, sel, true); },
    querySelectorAll(sel) { return queryAll(this, sel, false); }
  };
  return el;
}

/** 极简选择器,支持以空格分隔的后代组合:tag、#id、.class、tag[attr=v] */
function matchToken(el, token) {
  const m = token.match(/^([\w-]*)?(?:#([\w-]+))?(?:\.([\w-]+))?\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]$/);
  let tag = null, id = null, cls = null, attr = null, val;
  if (m) [, tag, id, cls, attr, val] = m;
  else {
    tag = token.match(/^[\w-]+/)?.[0] || null;
    id = token.match(/#([\w-]+)/)?.[1] || null;
    cls = token.match(/\.([\w-]+)/)?.[1] || null;
  }
  if (tag && el.tag !== tag) return false;
  if (id && el.attrs.id !== id) return false;
  if (cls && !el.classList._set.has(cls)) return false;
  if (attr) {
    if (!(attr in el.attrs)) return false;
    if (val !== undefined && el.attrs[attr] !== val) return false;
  }
  return true;
}
/**
 * 后代选择器匹配:tokens 最右为目标元素令牌,其左侧依次为更外层祖先令牌。
 * ancestors 为「直接父(内)→ … → 查询根(外)」的链(元素作用域查询时链首含根自身)。
 */
function matchGroup(el, tokens, ancestors = []) {
  if (tokens.length === 1) return matchToken(el, tokens[0]);
  if (!matchToken(el, tokens[tokens.length - 1])) return false;
  let ci = 0;
  for (let k = tokens.length - 2; k >= 0; k--) {
    while (ci < ancestors.length && !matchToken(ancestors[ci], tokens[k])) ci++;
    if (ci >= ancestors.length) return false;
    ci++; // 每个祖先令牌消费不同节点,继续向外
  }
  return true;
}
function queryAll(root, selector, firstOnly) {
  const groups = selector.split(',').map((s) => s.trim().split(/\s+/).filter(Boolean)).filter((g) => g.length);
  const out = [];
  const ancestorChainOf = (node) => {
    // 元素作用域查询时,祖先链截到查询根(含根本身,浏览器 querySelector 语义)
    const chain = [];
    let cur = node.parent;
    while (cur) {
      chain.push(cur);
      if (cur === root) break;
      cur = cur.parent;
    }
    return chain; // 直接父(内)→ … → 查询根(外)
  };
  const walk = (node) => {
    for (const c of node.children) {
      const ancestors = ancestorChainOf(c);
      for (const g of groups) {
        if (matchGroup(c, g, ancestors)) { out.push(c); if (firstOnly) return; }
      }
      walk(c);
    }
  };
  walk(root);
  return firstOnly ? out[0] || null : out;
}

/** 模拟点击:onclick 属性内联处理器优先(它需要全局作用域),其次 addEventListener/onclick */
function clickEl(sandbox, el, eventLike = {}) {
  const inline = el.attrs.onclick;
  if (inline) {
    const fn = vm.runInContext(`(function(event){ ${inline} })`, sandbox, { filename: 'inline-onclick.js' });
    return fn.call(el, { target: el, ...eventLike });
  }
  const fns = el.listeners.click || [];
  return fns.reduce((p, f) => p.then(() => f.call(el, { target: el, ...eventLike })), Promise.resolve());
}

export function createBrowser(baseUrl) {
  const knownById = new Map();
  const findById = (id, root = document.body) => {
    for (const c of root.children) {
      if (c.attrs.id === id) return c;
      const hit = findById(id, c);
      if (hit) return hit;
    }
    return null;
  };
  const document = {
    _known: knownById,
    getElementById(id) {
      const hit = findById(id);
      if (hit) return hit;
      if (!knownById.has(id)) {
        const el = makeElement(this, 'div', { id });
        knownById.set(id, el);
        this.body.appendChild(el); // 浏览器中 document.getElementById 惰性创建的元素仍挂在 document 下
      }
      return knownById.get(id);
    },
    createElement(tag) { return makeElement(this, tag); },
    querySelector(sel) { return this.body.querySelector(sel); },
    querySelectorAll(sel) { return this.body.querySelectorAll(sel); },
    addEventListener() {},
    body: null
  };
  document.body = makeElement(document, 'body');
  // HTML 骨架中静态存在的元素(tag 用于 querySelector('tbody'))
  const TABLES = ['tbl-receipts', 'tbl-ib', 'tbl-dl', 'tbl-rl', 'tbl-steps', 'tbl-pledges',
    'tbl-sup', 'tbl-batch', 'tbl-ops', 'tbl', 'tbl-events'];
  const SELECTS = ['f-loc', 'f-grade', 'f-holder', 'p-fin', 'p-receipt', 'p-batch',
    'race-receipt', 'stale-pledge', 'replay-pledge', 'op-outcome', 'op-action'];
  const INPUTS = ['f-qty', 'f-start', 'p-amount', 'vb-note', 'filter',
    'op-receipt', 'op-pledge', 'op-actor', 'op-session'];
  const BUTTONS = ['btn-register', 'btn-merge', 'btn-merge-clear', 'btn-refresh', 'btn-reset', 'btn-lock'];
  const tagFor = (id) =>
    TABLES.includes(id) ? 'table' : SELECTS.includes(id) ? 'select' :
    INPUTS.includes(id) ? 'input' : BUTTONS.includes(id) ? 'button' : 'div';
  const htmlStatic = [...TABLES, ...SELECTS, ...INPUTS, ...BUTTONS,
    'topbar', 'stats', 'merge-sel',
    'claim-banner', 'session-card', 'session-box', 'step-filters',
    'chain-banner', 'chain-box', 'toast-host', 'modal-mask',
    'audit-overlap', 'audit-double', 'audit-claim'];
  for (const id of htmlStatic) {
    const el = makeElement(document, tagFor(id), { id });
    knownById.set(id, el);
    document.body.appendChild(el);
  }
  // 浏览器解析 <table> 时会隐式补一个空 <tbody>,页面脚本依赖它存在
  for (const id of TABLES) {
    const tb = makeElement(document, 'tbody', {});
    knownById.get(id).appendChild(tb);
  }

  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear()
  };

  const fetchImpl = (urlPath, opts = {}) => new Promise((resolve, reject) => {
    const u = new URL(urlPath, baseUrl);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: opts.method || 'GET', headers: opts.headers || {} },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          json: async () => JSON.parse(raw),
          text: async () => raw
        }));
      }
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });

  const sandbox = {
    document, localStorage, fetch: fetchImpl, console,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    Math, Date, JSON, URL, URLSearchParams, Promise, RegExp, Number, String, Boolean, Array, Object,
    navigator: { clipboard: { writeText: async () => {} } },
    confirm: () => true, alert: () => {}
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  return {
    sandbox, document, localStorage: store,
    byId: (id) => document.getElementById(id),
    walk(root, fn) {
      for (const c of root.children) { fn(c); this.walk(c, fn); }
    },
    find(pred, root = document.body) {
      let found = null;
      this.walk(root, (c) => { if (!found && pred(c)) found = c; });
      return found;
    },
    findAll(pred, root = document.body) {
      const all = [];
      this.walk(root, (c) => { if (pred(c)) all.push(c); });
      return all;
    },
    load(script) {
      const code = fs.readFileSync(path.join(PUBLIC_DIR, script), 'utf8');
      vm.runInContext(code, sandbox, { filename: script });
    },
    click(el, ev) { return clickEl(sandbox, el, ev); },
    flush(ms = 50) { return new Promise((r) => setTimeout(r, ms)); },
    evalInPage(code) { return vm.runInContext(code, sandbox); },
    /** 执行页面内异步表达式并等待其完成(跨 realm 的 Promise 需经微任务转出) */
    async evalAsync(code) {
      const p = vm.runInContext(`Promise.resolve().then(() => ${code})`, sandbox);
      return new Promise((resolve, reject) => {
        p.then(
          (v) => resolve(v),
          (e) => reject(e && typeof e === 'object'
            ? Object.assign(new Error(e.message), { code: e.code, extra: e.extra, name: e.name })
            : new Error(String(e)))
        );
      });
    }
  };
}
