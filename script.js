/* ============================================================
   script.js  —  separated JavaScript file (all app logic)
   • Safe math engine (tokenizer → shunting-yard → evaluator)
   • Calculator UI + keyboard support
   • History with localStorage persistence
   • "Nova" — built-in AI math assistant
   ============================================================ */
'use strict';

/* ---------------- helpers ---------------- */
const $  = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

function escapeHTML(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function formatNumber(n) {
  if (typeof n === 'bigint') return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (typeof n !== 'number' || !isFinite(n)) return 'Error';
  if (n !== 0 && (Math.abs(n) >= 1e15 || Math.abs(n) < 1e-9)) {
    return n.toExponential(6).replace(/\.?0+e/, 'e');
  }
  const rounded = parseFloat(n.toPrecision(12));
  return rounded.toLocaleString('en-US', { maximumFractionDigits: 10 });
}

const closeParens = s =>
  s + ')'.repeat(Math.max(0, (s.match(/\(/g) || []).length - (s.match(/\)/g) || []).length));

/* ============================================================
   MATH ENGINE
   ============================================================ */
const FUNCS = {
  sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs,
  sin: x => Math.sin(x * Math.PI / 180),
  cos: x => Math.cos(x * Math.PI / 180),
  tan: x => Math.tan(x * Math.PI / 180),
  log: Math.log10, ln: Math.log,
};

function tokenize(raw) {
  const src = raw.replace(/\s+/g, '').replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-');
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const numStr = src.slice(i, j);
      if ((numStr.match(/\./g) || []).length > 1) throw new Error('Bad number');
      tokens.push({ t: 'num', v: parseFloat(numStr) });
      i = j;
    } else if (/[a-z]/i.test(ch)) {
      let j = i;
      while (j < src.length && /[a-z]/i.test(src[j])) j++;
      const name = src.slice(i, j).toLowerCase();
      if (!FUNCS[name]) throw new Error('Unknown function: ' + name);
      tokens.push({ t: 'func', name });
      i = j;
    } else if ('+-*/^%()'.includes(ch)) {
      tokens.push(ch === '%' ? { t: 'pct' } : { t: ch });
      i++;
    } else {
      throw new Error('Invalid character');
    }
  }
  return tokens;
}

function insertImplicitMul(tokens) {
  const out = [];
  for (const tk of tokens) {
    const prev = out[out.length - 1];
    if (prev) {
      const prevIsValue = prev.t === 'num' || prev.t === ')' || prev.t === 'pct';
      const curStartsValue = tk.t === 'num' || tk.t === '(' || tk.t === 'func';
      if (prevIsValue && curStartsValue) out.push({ t: '*' });
    }
    out.push(tk);
  }
  return out;
}

function toRPN(tokens) {
  const out = [], ops = [];
  const prec  = { '+': 1, '-': 1, '*': 2, '/': 2, '^': 4, 'neg': 3, 'pct': 5, 'func': 6 };
  const right = new Set(['^', 'neg']);
  let prev = null;
  const isValue = t => t && (t.t === 'num' || t.t === ')' || t.t === 'pct');

  const pushOp = op => {
    while (ops.length) {
      const top = ops[ops.length - 1];
      if (top.t === '(') break;
      const tp = prec[top.t] ?? 0, cp = prec[op];
      if (tp > cp || (tp === cp && !right.has(op))) out.push(ops.pop());
      else break;
    }
    ops.push({ t: op });
  };

  for (const tk of tokens) {
    if (tk.t === 'num') { out.push(tk); prev = tk; }
    else if (tk.t === 'func') { ops.push(tk); prev = tk; }
    else if (tk.t === '(') { ops.push(tk); prev = tk; }
    else if (tk.t === ')') {
      while (ops.length && ops[ops.length - 1].t !== '(') out.push(ops.pop());
      if (!ops.length) throw new Error('Unbalanced parentheses');
      ops.pop();
      if (ops.length && ops[ops.length - 1].t === 'func') out.push(ops.pop());
      prev = { t: ')' };
    }
    else if (tk.t === 'pct') { pushOp('pct'); prev = tk; }
    else { // binary + - * / ^
      if (!isValue(prev)) {
        if (tk.t === '-') { pushOp('neg'); prev = { t: 'op' }; continue; }
        if (tk.t === '+') continue; // unary plus — ignore
        throw new Error('Unexpected operator');
      }
      pushOp(tk.t);
      prev = { t: 'op' };
    }
  }
  while (ops.length) {
    const top = ops.pop();
    if (top.t === '(') throw new Error('Unbalanced parentheses');
    out.push(top);
  }
  return out;
}

function evalRPN(rpn) {
  const st = [];
  for (const tk of rpn) {
    if (tk.t === 'num') st.push(tk.v);
    else if (tk.t === 'neg') { if (!st.length) throw new Error('Invalid'); st.push(-st.pop()); }
    else if (tk.t === 'pct') { if (!st.length) throw new Error('Invalid'); st.push(st.pop() / 100); }
    else if (tk.t === 'func') { if (!st.length) throw new Error('Invalid'); st.push(FUNCS[tk.name](st.pop())); }
    else {
      if (st.length < 2) throw new Error('Invalid expression');
      const b = st.pop(), a = st.pop();
      let r;
      switch (tk.t) {
        case '+': r = a + b; break;
        case '-': r = a - b; break;
        case '*': r = a * b; break;
        case '/': r = b === 0 ? NaN : a / b; break;
        case '^': r = Math.pow(a, b); break;
        default: throw new Error('Unknown operator');
      }
      st.push(r);
    }
  }
  if (st.length !== 1) throw new Error('Invalid expression');
  return st[0];
}

function calculate(raw) {
  return evalRPN(toRPN(insertImplicitMul(tokenize(raw))));
}

/* ============================================================
   CALCULATOR UI
   ============================================================ */
const exprEl  = $('#smallExpr');
const mainEl  = $('#mainDisplay');
const keypad  = $('#keypad');
const toastEl = $('#toast');

const calc = { expr: '', justEvaluated: false, lastExpr: null };
let errorFlag = false;
let toastTimer = null;

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1900);
}

function livePreview() {
  if (!calc.expr) return null;
  let e = calc.expr.replace(/[+\-×÷^(]+$/, '');
  if (!e) return null;
  e = closeParens(e);
  try {
    const v = calculate(e);
    return isFinite(v) ? v : null;
  } catch { return null; }
}

function render() {
  // small line
  let small = '\u00A0';
  if (calc.justEvaluated && calc.lastExpr) small = calc.lastExpr + ' =';
  else if (calc.expr && /[+\-×÷^%()]/.test(calc.expr)) small = calc.expr;
  exprEl.textContent = small;
  exprEl.parentElement && (exprEl.scrollLeft = exprEl.scrollWidth);

  // main line
  let main = '0';
  if (errorFlag) main = 'Error';
  else if (calc.expr) {
    const v = livePreview();
    main = v !== null ? formatNumber(v) : '0';
  }
  mainEl.textContent = main;
  mainEl.classList.toggle('shrink', main.length > 14 && main.length <= 24);
  mainEl.classList.toggle('tiny', main.length > 24);
}

function clearError() {
  if (errorFlag) { errorFlag = false; mainEl.classList.remove('error'); }
}

function flashError() {
  errorFlag = true;
  mainEl.classList.remove('error');
  void mainEl.offsetWidth;
  mainEl.classList.add('error');
  render();
}

function toggleSign() {
  let e = calc.expr;
  let m = e.match(/(^|[+\-×÷^%(])\(-(\d*\.?\d+)\)$/);
  if (m) { calc.expr = e.slice(0, m.index) + m[1] + m[2]; calc.justEvaluated = false; render(); return; }
  m = e.match(/(^|[+\-×÷^%(])(-?)(\d*\.?\d*)$/);
  if (!m || m[3] === '') return;
  let ins;
  if (m[2] === '-') ins = m[1] + m[3];
  else ins = (m[1] === '' || m[1] === '(') ? '-' + m[3] : m[1] + '(-' + m[3] + ')';
  calc.expr = e.slice(0, m.index) + ins;
  calc.justEvaluated = false;
  render();
}

function equals() {
  let e = calc.expr.replace(/[+\-×÷^(]+$/, '');
  if (!e) return;
  e = closeParens(e);
  let v;
  try { v = calculate(e); } catch { flashError(); return; }
  if (!isFinite(v)) { flashError(); return; }
  addHistory(e, v);
  calc.lastExpr = e;
  calc.expr = String(parseFloat(v.toPrecision(12)));
  calc.justEvaluated = true;
  render();
  mainEl.classList.remove('pop');
  void mainEl.offsetWidth;
  mainEl.classList.add('pop');
}

function press(key) {
  clearError();

  if (key === 'C') {
    calc.expr = ''; calc.justEvaluated = false; calc.lastExpr = null;
    render(); return;
  }
  if (key === 'back') {
    if (calc.justEvaluated) { calc.expr = ''; calc.justEvaluated = false; calc.lastExpr = null; }
    else calc.expr = calc.expr.slice(0, -1);
    render(); return;
  }
  if (key === '=') { equals(); return; }
  if (key === 'neg') { toggleSign(); return; }

  if (calc.justEvaluated) {
    if (/[0-9.]/.test(key) || key === '(') { calc.expr = ''; }
    calc.justEvaluated = false;
    calc.lastExpr = null;
  }

  const e = calc.expr;
  const last = e.slice(-1);

  if (/[0-9]/.test(key)) {
    const tail = e.match(/(\d*\.?\d*)$/)[1];
    if (tail === '0')       calc.expr = e.slice(0, -1) + key;
    else if (tail === '-0') calc.expr = e.slice(0, -2) + '-' + key;
    else                    calc.expr += key;
  }
  else if (key === '.') {
    const tail = e.match(/(\d*\.?\d*)$/)[1];
    if (tail.includes('.')) { render(); return; }
    calc.expr += (tail === '' ? '0.' : '.');
  }
  else if ('+-×÷^'.includes(key)) {
    if (e === '')       { if (key === '-') calc.expr = '-'; render(); return; }
    if (last === '(')   { if (key === '-') calc.expr += '-'; render(); return; }
    if ('+-×÷^'.includes(last)) { calc.expr = e.slice(0, -1) + key; render(); return; }
    if (/[0-9.)%]$/.test(e)) calc.expr += key;
  }
  else if (key === '%') {
    if (/[0-9)]$/.test(e)) calc.expr += '%';
  }
  else if (key === '(') {
    if (e === '' || '+-×÷^('.includes(last)) calc.expr += '(';
    else if (/[0-9)%]$/.test(last)) calc.expr += '×(';
  }
  else if (key === ')') {
    const open = (e.match(/\(/g) || []).length;
    const cls  = (e.match(/\)/g) || []).length;
    if (open > cls && /[0-9)%]$/.test(last)) calc.expr += ')';
  }
  render();
}

/* keypad clicks */
keypad.addEventListener('click', ev => {
  const btn = ev.target.closest('.key');
  if (!btn) return;
  press(btn.dataset.key);
});

/* keyboard */
document.addEventListener('keydown', ev => {
  if (ev.target === aiInput) return;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const k = ev.key;
  let mapped = null;
  if (/^[0-9]$/.test(k)) mapped = k;
  else if (k === '.') mapped = '.';
  else if (k === '+') mapped = '+';
  else if (k === '-') mapped = '-';
  else if (k === '*') mapped = '×';
  else if (k === '/') { mapped = '÷'; ev.preventDefault(); }
  else if (k === '%') mapped = '%';
  else if (k === '(') mapped = '(';
  else if (k === ')') mapped = ')';
  else if (k === '^') mapped = '^';
  else if (k === 'Enter' || k === '=') { mapped = '='; ev.preventDefault(); }
  else if (k === 'Backspace') mapped = 'back';
  else if (k === 'Escape') mapped = 'C';
  if (!mapped) return;
  press(mapped);
  const btn = keypad.querySelector(`[data-key="${CSS.escape(mapped)}"]`);
  if (btn) {
    btn.classList.add('pressed');
    setTimeout(() => btn.classList.remove('pressed'), 130);
  }
});

/* copy result */
$('#copyResult').addEventListener('click', () => {
  const v = livePreview();
  if (v === null && !calc.justEvaluated) { toast('Nothing to copy yet'); return; }
  const val = v !== null ? v : 0;
  navigator.clipboard.writeText(String(parseFloat(Number(val).toPrecision(12))))
    .then(() => toast('Result copied ✓'))
    .catch(() => toast('Copy failed'));
});

/* ============================================================
   HISTORY (localStorage)
   ============================================================ */
const HIST_KEY = 'calcmind.history.v1';
const historyList  = $('#historyList');
const historyEmpty = $('#historyEmpty');
const histCount    = $('#histCount');
let history = [];

try { history = JSON.parse(localStorage.getItem(HIST_KEY)) || []; } catch { history = []; }

function saveHistory() {
  try { localStorage.setItem(HIST_KEY, JSON.stringify(history)); } catch {}
}

function addHistory(expr, value) {
  history.unshift({
    id: Date.now() + Math.random().toString(16).slice(2),
    expr,
    result: formatNumber(value),
    raw: String(parseFloat(value.toPrecision(12))),
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  });
  if (history.length > 60) history.length = 60;
  saveHistory();
  renderHistory();
}

function renderHistory() {
  histCount.textContent = history.length;
  historyEmpty.style.display = history.length ? 'none' : 'flex';
  historyList.innerHTML = history.map(item => `
    <li class="hist-item">
      <button class="hist-use" data-raw="${escapeHTML(item.raw)}" title="Insert into calculator">
        <span class="hist-expr">${escapeHTML(item.expr)} =</span>
        <span class="hist-result">${escapeHTML(item.result)}</span>
      </button>
      <span class="hist-time">${item.time}</span>
      <button class="hist-copy" data-copy="${escapeHTML(item.result)}" title="Copy result">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>
      </button>
      <button class="hist-del" data-del="${item.id}" title="Delete">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
      </button>
    </li>`).join('');
}

historyList.addEventListener('click', ev => {
  const copyBtn = ev.target.closest('[data-copy]');
  if (copyBtn) {
    navigator.clipboard.writeText(copyBtn.dataset.copy.replace(/,/g, ''))
      .then(() => toast('Copied ✓'));
    return;
  }
  const delBtn = ev.target.closest('[data-del]');
  if (delBtn) {
    history = history.filter(h => String(h.id) !== delBtn.dataset.del);
    saveHistory(); renderHistory(); toast('Entry deleted');
    return;
  }
  const useBtn = ev.target.closest('[data-raw]');
  if (useBtn) insertIntoCalc(useBtn.dataset.raw);
});

$('#clearHistory').addEventListener('click', () => {
  if (!history.length) { toast('History is already empty'); return; }
  history = [];
  saveHistory(); renderHistory(); toast('History cleared');
});

function insertIntoCalc(str) {
  clearError();
  const s = String(parseFloat(Number(str).toPrecision(12)));
  if (calc.justEvaluated || calc.expr === '') calc.expr = s;
  else {
    const last = calc.expr.slice(-1);
    calc.expr += ('+-×÷^%('.includes(last)) ? s : '+' + s;
  }
  calc.justEvaluated = false;
  render();
  toast('Added to calculator ✓');
}

/* ============================================================
   NOVA — AI ASSISTANT (runs fully offline)
   ============================================================ */
const wrap = (html, value = null) =>
  ({ html, value: (typeof value === 'number' && isFinite(value)) ? value : null });

function mathAnswer(main, steps, value) {
  return wrap(
    `<div class="ai-answer">${main}</div>` +
    (steps ? `<div class="ai-steps">${steps}</div>` : ''),
    value
  );
}

/* ---- linear equation solver ---- */
function coef(s) {
  if (s === '' || s === '+') return 1;
  if (s === '-') return -1;
  return parseFloat(s);
}
function trySolve(q) {
  let t = q.toLowerCase()
    .replace(/solve|equation|please|find|value|for|the/g, '')
    .replace(/\s+/g, '').replace(/[×✕]/g, '*').replace(/÷/g, '/');
  if (!t.includes('x') || !t.includes('=')) return null;
  let m = t.match(/^(-?\d*\.?\d*)\*?x([+-]\d*\.?\d*)?=(-?\d*\.?\d*)$/);
  if (!m) {
    m = t.match(/^([+-]?\d+\.?\d*)([+-])(\d*\.?\d*)\*?x=(-?\d+\.?\d*)$/);
    if (!m) return null;
    const b = parseFloat(m[1]);
    const a = (m[2] === '-' ? -1 : 1) * coef(m[3]);
    return linearResult(a, b, parseFloat(m[4]));
  }
  const a = coef(m[1]);
  const b = m[2] ? parseFloat(m[2]) : 0;
  return linearResult(a, b, parseFloat(m[3]));
}
function linearResult(a, b, c) {
  if (!isFinite(a) || !isFinite(c) || a === 0) return null;
  const x = (c - b) / a;
  const bTerm = b === 0 ? '' : (b > 0 ? ` + ${formatNumber(b)}` : ` − ${formatNumber(-b)}`);
  const steps = [
    `${formatNumber(a)}x${bTerm} = ${formatNumber(c)}`,
    ...(b !== 0 ? [`${formatNumber(a)}x = ${formatNumber(c)} ${b > 0 ? '−' : '+'} ${formatNumber(Math.abs(b))}`] : []),
    `x = ${formatNumber(c - b)} ÷ ${formatNumber(a)}`,
  ].join('<br>');
  return mathAnswer(`x = ${formatNumber(x)}`, steps, x);
}

/* ---- temperature ---- */
function tryTemperature(s) {
  const re = /(-?\d+\.?\d*)\s*(?:degrees?\s*)?(fahrenheit|celsius|centigrade|kelvin|°f|°c|°k|[fck])\s*(?:to|in|into|as|=)\s*(?:degrees?\s*)?(fahrenheit|celsius|centigrade|kelvin|°f|°c|°k|[fck])/;
  const m = s.match(re);
  if (!m) return null;
  const norm = u => (u[0] === 'f' || u === 'fahrenheit') ? 'f'
    : (u[0] === 'c' || u === 'celsius' || u === 'centigrade') ? 'c' : 'k';
  const toC   = { f: v => (v - 32) * 5 / 9, c: v => v, k: v => v - 273.15 };
  const fromC = { f: v => v * 9 / 5 + 32, c: v => v, k: v => v + 273.15 };
  const label = { f: '°F', c: '°C', k: 'K' };
  const v = parseFloat(m[1]);
  const from = norm(m[2]), to = norm(m[3]);
  const res = parseFloat(fromC[to](toC[from](v)).toFixed(4));
  return mathAnswer(
    `${formatNumber(v)} ${label[from]} = ${formatNumber(res)} ${label[to]}`,
    `via Celsius: ${formatNumber(parseFloat(toC[from](v).toFixed(2)))} °C`,
    res
  );
}

/* ---- unit conversions ---- */
const UNIT_DEFS = [
  ['length', { mm:.001, cm:.01, m:1, km:1000, in:.0254, inch:.0254, inches:.0254, ft:.3048, foot:.3048, feet:.3048, yd:.9144, yard:.9144, mi:1609.344, mile:1609.344 }],
  ['weight', { mg:1e-6, g:.001, gram:.001, grams:.001, kg:1, kilogram:1, kilograms:1, oz:.0283495, ounce:.0283495, lb:.453592, lbs:.453592, pound:.453592, pounds:.453592, ton:1000, tonne:1000 }],
  ['volume', { ml:.001, l:1, liter:1, litre:1, gal:3.78541, gallon:3.78541, cup:.24, cups:.24, pint:.473176, quart:.946353, tbsp:.0147868, tsp:.00492892 }],
  ['speed',  { 'm/s':1, 'km/h':.277778, mph:.44704, kph:.277778, knot:.514444, knots:.514444, 'ft/s':.3048 }],
  ['data',   { b:1, kb:1024, mb:1048576, gb:1073741824, tb:1099511627776 }],
  ['time',   { ms:.001, sec:1, second:1, seconds:1, min:60, minute:60, minutes:60, hr:3600, hour:3600, hours:3600, day:86400, days:86400, week:604800, year:31557600 }],
];
const UNIT_MAP = {};
UNIT_DEFS.forEach(([cat, units]) => {
  Object.entries(units).forEach(([alias, f]) => { UNIT_MAP[alias] = { cat, f }; });
});
function lookupUnit(u) {
  u = u.toLowerCase();
  if (UNIT_MAP[u]) return UNIT_MAP[u];
  if (u.endsWith('s') && UNIT_MAP[u.slice(0, -1)]) return UNIT_MAP[u.slice(0, -1)];
  return null;
}
function tryUnits(s) {
  const m = s.match(/(-?\d[\d,]*\.?\d*)\s*([a-z][a-z0-9\/]*)\s*(?:to|in|into|as|=)\s*([a-z][a-z0-9\/]*)/);
  if (!m) return null;
  const A = lookupUnit(m[2]), B = lookupUnit(m[3]);
  if (!A || !B || A.cat !== B.cat) return null;
  const v = parseFloat(m[1].replace(/,/g, ''));
  const res = parseFloat((v * A.f / B.f).toPrecision(8));
  return mathAnswer(
    `${formatNumber(v)} ${m[2]} = ${formatNumber(res)} ${m[3]}`,
    `${m[2]} → ${m[3]} (${A.cat})`,
    res
  );
}

/* ---- percentages ---- */
function tryPercent(s) {
  const num = x => parseFloat(x.replace(/,/g, ''));
  let m;
  if ((m = s.match(/(-?\d[\d,]*\.?\d*)\s*(?:%|percent)\s*of\s*(-?\d[\d,]*\.?\d*)/))) {
    const a = num(m[1]), b = num(m[2]), r = a / 100 * b;
    return mathAnswer(formatNumber(r),
      `${formatNumber(a)}% × ${formatNumber(b)}<br>= ${formatNumber(a / 100)} × ${formatNumber(b)} = ${formatNumber(r)}`, r);
  }
  if ((m = s.match(/(-?\d[\d,]*\.?\d*)\s+is\s+what\s*(?:%|percent)\s*of\s+(-?\d[\d,]*\.?\d*)/))) {
    const a = num(m[1]), b = num(m[2]), r = a / b * 100;
    return mathAnswer(`${formatNumber(parseFloat(r.toPrecision(10)))}%`,
      `${formatNumber(a)} ÷ ${formatNumber(b)} × 100 = ${formatNumber(parseFloat(r.toPrecision(10)))}%`, r);
  }
  if ((m = s.match(/(?:%|percent|percentage)\s*(increase|decrease|change|drop|growth)\w*\s+from\s+(-?\d[\d,]*\.?\d*)\s+to\s+(-?\d[\d,]*\.?\d*)/))) {
    const a = num(m[2]), b = num(m[3]), r = (b - a) / a * 100;
    return mathAnswer(`${r >= 0 ? '+' : ''}${formatNumber(parseFloat(r.toPrecision(10)))}%`,
      `(${formatNumber(b)} − ${formatNumber(a)}) ÷ ${formatNumber(a)} × 100`, r);
  }
  if ((m = s.match(/(\d[\d,]*\.?\d*)\s*(?:%|percent)\s*(off|discount|tip|tax|markup)\s*(?:of|on)?\s*(\d[\d,]*\.?\d*)/))) {
    const p = num(m[1]), base = num(m[3]);
    const subtract = /off|discount/.test(m[2]);
    const r = subtract ? base * (1 - p / 100) : base * (1 + p / 100);
    return mathAnswer(formatNumber(r),
      `${formatNumber(base)} ${subtract ? '−' : '+'} ${formatNumber(p)}% = ${formatNumber(base)} ${subtract ? '−' : '+'} ${formatNumber(base * p / 100)}`, r);
  }
  return null;
}

/* ---- factorials / fibonacci / gcd / primes / random ---- */
function tryFactorial(s) {
  const m = s.match(/(\d+)\s*!/) || s.match(/factorial\s*(?:of)?\s*(\d+)/) || s.match(/(\d+)\s+factorial/);
  if (!m) return null;
  const n = +m[1];
  if (n > 170) return wrap(`Whoa — ${n}! overflows my number brain (max 170). Try something smaller! 🤯`);
  let r = 1n;
  for (let i = 2n; i <= BigInt(n); i++) r *= i;
  return mathAnswer(formatNumber(r), `${n}! = 1 × 2 × … × ${n}`, n <= 15 ? Number(r) : null);
}
function tryFibonacci(s) {
  const m = s.match(/fib(?:onacci)?\s*(?:number|of|term|seq(?:uence)?)?\s*#?\s*(\d+)/);
  if (!m) return null;
  const n = +m[1];
  if (n > 300) return wrap('That Fibonacci term is enormous! Try n ≤ 300. 🐘');
  let a = 0n, b = 1n;
  for (let i = 0; i < n; i++) [a, b] = [b, a + b];
  return mathAnswer(`F(${n}) = ${formatNumber(a)}`,
    `F(0)=0, F(1)=1, F(n)=F(n−1)+F(n−2)`, n <= 77 ? Number(a) : null);
}
function tryGcdLcm(s) {
  let m = s.match(/(?:gcd|gcf|hcf)\s*(?:of)?\s*(\d+)\s*(?:and|,)\s*(\d+)/);
  if (m) {
    let a = +m[1], b = +m[2];
    const A = a, B = b;
    while (b) [a, b] = [b, a % b];
    return mathAnswer(`GCD = ${formatNumber(a)}`, `Greatest common divisor of ${A} and ${B}`, a);
  }
  m = s.match(/lcm\s*(?:of)?\s*(\d+)\s*(?:and|,)\s*(\d+)/);
  if (m) {
    const A = +m[1], B = +m[2];
    let a = A, b = B;
    while (b) [a, b] = [b, a % b];
    const r = A / a * B;
    return mathAnswer(`LCM = ${formatNumber(r)}`, `Least common multiple of ${A} and ${B}`, r);
  }
  return null;
}
function tryPrime(s) {
  const m = s.match(/is\s+(\d+)\s+prime/);
  if (!m) return null;
  const n = +m[1];
  if (n < 2) return wrap(`${n} is <strong>not prime</strong> — primes start at 2.`);
  let prime = true;
  for (let i = 2; i * i <= n; i++) if (n % i === 0) { prime = false; break; }
  return wrap(prime
    ? `Yes! <div class="ai-answer">${n} is prime ✅</div><div class="ai-steps">No divisors found up to √${n} ≈ ${Math.floor(Math.sqrt(n))}</div>`
    : `<div class="ai-answer">${n} is not prime ❌</div><div class="ai-steps">It has divisors other than 1 and itself.</div>`, n);
}
function tryRandom(s) {
  const m = s.match(/random\s+number\s+between\s+(\d+)\s+and\s+(\d+)/);
  if (!m) return null;
  const a = +m[1], b = +m[2];
  const lo = Math.min(a, b), hi = Math.max(a, b);
  const r = Math.floor(Math.random() * (hi - lo + 1)) + lo;
  return mathAnswer(`🎲 ${r}`, `random integer in [${lo}, ${hi}]`, r);
}

/* ---- general word-math ---- */
function tryGeneral(q) {
  let t = ' ' + q.toLowerCase() + ' ';
  t = t
    .replace(/what\s+is|what's|whats|calculate|compute|evaluate|simplify|please|can\s+you|could\s+you|tell\s+me|how\s+much\s+is|\?/g, ' ')
    .replace(/\bsquared\b/g, ' ^2 ')
    .replace(/\bcubed\b/g, ' ^3 ')
    .replace(/square\s+root\s+of/g, ' sqrt ')
    .replace(/cube\s+root\s+of/g, ' cbrt ')
    .replace(/to\s+the\s+power\s+of|raised\s+to|power\s+of|\bpower\b/g, ' ^ ')
    .replace(/\bplus\b/g, ' + ')
    .replace(/\bminus\b|\bsubtract\b/g, ' - ')
    .replace(/\btimes\b|multiplied\s+by|\bmultiply\b/g, ' * ')
    .replace(/divided\s+by|\bdivide\b|\bover\b/g, ' / ')
    .replace(/\bpercent\s+of\b/g, '% of')
    .replace(/\bpercent\b/g, '%')
    .replace(/\bof\b/g, ' * ')
    .replace(/(\d)\s*x\s*(\d)/g, '$1 * $2')
    .replace(/,/g, ' ');
  const keep = ['sqrt', 'cbrt', 'abs', 'sin', 'cos', 'tan', 'log', 'ln'];
  t = t.replace(/[a-z]+/g, w => keep.includes(w) ? w : ' ');
  t = t.replace(/sqrt\s*\(?\s*(\d+(?:\.\d+)?)\s*\)?/g, 'sqrt($1)')
       .replace(/cbrt\s*\(?\s*(\d+(?:\.\d+)?)\s*\)?/g, 'cbrt($1)');
  if (!/\d/.test(t)) return null;
  if (!/[+\-*/^%]|sqrt|cbrt|sin|cos|tan|log|ln/.test(t)) return null;
  try {
    const v = calculate(closeParens(t));
    if (!isFinite(v)) return null;
    return mathAnswer(formatNumber(v), `${escapeHTML(q.trim())} = ${formatNumber(v)}`, v);
  } catch { return null; }
}

/* ---- Nova dispatcher ---- */
function helpHTML() {
  const examples = [
    'What is 15% of 240?', 'Solve 3x + 7 = 25', 'Convert 72°F to °C',
    '5 miles to km', 'sqrt(196) + 8', '12 factorial', 'Fibonacci of 20',
    'gcd of 48 and 36', 'Is 97 prime?',
  ];
  return `<div class="ai-answer">Here's what I can do ✨</div>
    <div class="ai-steps">Arithmetic · Percentages · Equations · Conversions · Roots &amp; powers · Factorials · Fibonacci · GCD/LCM · Primes</div>
    <div class="ai-suggest-list">${examples.map(e =>
      `<button class="ai-suggest" data-ask="${escapeHTML(e)}">${escapeHTML(e)}</button>`).join('')}</div>`;
}
function fallbackHTML() {
  const ideas = ['What is 18 × 46?', '20% off 85', 'Convert 10 km to miles', '2 to the power of 16'];
  return `Hmm, I couldn't crunch that one 🤔 I'm best with numbers!<br>
    <div class="ai-suggest-list">${ideas.map(e =>
      `<button class="ai-suggest" data-ask="${escapeHTML(e)}">${escapeHTML(e)}</button>`).join('')}</div>`;
}

const Nova = {
  reply(input) {
    const q = input.trim();
    const s = q.toLowerCase().replace(/\s+/g, ' ');
    let r;

    if (/^(hi|hii+|hello|hey|yo|hola|howdy)\b/.test(s))
      return wrap(`Hey there! 👋 Got a number puzzle for me? Try <strong>"15% of 240"</strong> or <strong>"solve 2x+5=15"</strong>.`);
    if (/^(thanks|thank you|thx|ty)\b/.test(s))
      return wrap(`Anytime! 🎯 Throw me another one.`);
    if (/who are you|your name/.test(s))
      return wrap(`I'm <strong>Nova</strong> ✨ — the AI brain living inside CalcMind. Numbers are my love language.`);
    if (/what can you do|help\b|capabilit|features/.test(s)) return wrap(helpHTML());
    if (/show.*history|open history/.test(s)) { switchTab('history'); return wrap(`Done — flipped to the <strong>History</strong> tab 🕘`); }
    if (/what time/.test(s))
      return wrap(`It's <strong>${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</strong> right now ⏰`);
    if (/what.*date|today's date|todays date|what day is/.test(s))
      return wrap(`Today is <strong>${new Date().toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</strong> 📅`);
    if (/(?:usd|eur|gbp|inr|jpy|cad|aud)\s*(?:to|in)\s*(?:usd|eur|gbp|inr|jpy|cad|aud)|currency/.test(s))
      return wrap(`💱 Currency needs live exchange rates and I run fully offline — try <strong>length, weight, temperature, speed, data or time</strong> conversions instead!`);

    if ((r = trySolve(q)))        return r;
    if ((r = tryTemperature(s)))  return r;
    if ((r = tryUnits(s)))        return r;
    if ((r = tryPercent(s)))      return r;
    if ((r = tryFactorial(s)))    return r;
    if ((r = tryFibonacci(s)))    return r;
    if ((r = tryGcdLcm(s)))       return r;
    if ((r = tryPrime(s)))        return r;
    if ((r = tryRandom(s)))       return r;
    if ((r = tryGeneral(q)))      return r;
    return wrap(fallbackHTML());
  }
};

/* ============================================================
   CHAT UI + TABS
   ============================================================ */
const chatEl  = $('#chat');
const chipsEl = $('#chips');
const aiForm  = $('#aiForm');
const aiInput = $('#aiInput');

function appendMsg(role, html, value = null) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  if (role === 'ai') {
    div.innerHTML = `<div class="avatar">✦</div><div class="bubble">${html}${
      value !== null ? `<br><button class="ai-use" data-use="${value}">➜ Send to calculator</button>` : ''
    }</div>`;
  } else {
    div.innerHTML = `<div class="bubble">${html}</div>`;
  }
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
}

function appendTyping() {
  const div = document.createElement('div');
  div.className = 'msg ai typing';
  div.innerHTML = `<div class="avatar">✦</div><div class="bubble"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>`;
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
  return div;
}

function sendToAI(text) {
  const t = text.trim();
  if (!t) return;
  appendMsg('user', escapeHTML(t));
  const typing = appendTyping();
  setTimeout(() => {
    typing.remove();
    const res = Nova.reply(t);
    appendMsg('ai', res.html, res.value);
  }, 550 + Math.random() * 650);
}

chatEl.addEventListener('click', ev => {
  const ask = ev.target.closest('[data-ask]');
  if (ask) { sendToAI(ask.dataset.ask); return; }
  const use = ev.target.closest('[data-use]');
  if (use) insertIntoCalc(use.dataset.use);
});

aiForm.addEventListener('submit', ev => {
  ev.preventDefault();
  sendToAI(aiInput.value);
  aiInput.value = '';
  aiInput.focus();
});

/* suggestion chips */
const CHIPS = [
  'What is 15% of 240?', 'Solve 3x + 7 = 25', 'Convert 72°F to °C',
  'sqrt(196) + 8', '12 factorial', 'Fibonacci of 20',
  '5 miles to km', 'gcd of 48 and 36', 'Is 97 prime?', 'Random number between 1 and 100',
];
chipsEl.innerHTML = CHIPS.map(c => `<button type="button" class="chip" data-chip="${escapeHTML(c)}">${escapeHTML(c)}</button>`).join('');
chipsEl.addEventListener('click', ev => {
  const chip = ev.target.closest('[data-chip]');
  if (chip) sendToAI(chip.dataset.chip);
});

/* tabs */
function switchTab(name) {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  $('#panel-history').classList.toggle('hidden', name !== 'history');
  $('#panel-ai').classList.toggle('hidden', name !== 'ai');
}
$$('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

/* ============================================================
   INIT
   ============================================================ */
renderHistory();
render();
appendMsg('ai', `Hey! I'm <strong>Nova</strong> ✨ — your built-in math AI.<br>Ask me anything numerical, or tap a suggestion below 👇`);