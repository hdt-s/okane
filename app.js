'use strict';
// データはすべて localStorage に1つのJSONで保存する
const KEY = 'okane-data';
const PREF_KEY = 'okane-prefs';

// 項目の種類。純資産に入るのは asset / card / liability だけ
const KINDS = { asset: '資産', card: 'カード', liability: '負債', held: '預かり', item: '持ち物' };
// 新しく始める人の最初の項目（口座やカードは本人が足す）。使っている人の項目は、その人の端末のデータにある
const DEFAULT_ACCOUNTS = [
  { id: 'cash', name: '現金', kind: 'asset' },
];
const DEFAULT_CATS = {
  expense: ['食費', '外食', 'コンビニ', '本', '交通', '日用品', '娯楽', 'サブスク', 'その他'],
  income: ['給料', 'もらいもの', '臨時', 'その他'],
};
const REPEAT_STEP = { monthly: 1, yearly: 12 };

// 支出の性質。用途ごとに決めておき、1件ごとに上書きもできる
const NATURES = [['invest', '投資'], ['consume', '消費'], ['waste', '浪費']];
const NATURE_LABEL = Object.fromEntries(NATURES);
const NATURE_COLOR = { invest: '#3d6fe0', consume: '#1a9970', waste: '#d6336c' }; // アプリの色に関係なく固定（サファイア・エメラルド・ルビー）。白黒どちらの地とも3:1以上
const DEFAULT_NATURES = { 本: 'invest', コンビニ: 'waste', 娯楽: 'waste', ホットスナック: 'waste' };
function natureOf(cat) { return state.natures?.[cat] || 'consume'; }
function txNature(t) { return t.nature || natureOf(t.category); }

let state = load();
let prefs = loadPrefs();
let form = { type: 'expense', from: null, to: null, category: null, editing: null };
let period = { from: '', to: '' }; // 最初は全期間
let periodMode = 'all'; // 'all'（全期間）| 'month'（月ごと）| 'range'（指定：何月〜何月）
let histView = 'summary';
let histCat = '';
let histNature = '';
let detailId = null;
let planType = 'income';
let planEditing = null;
let currentTab = 'add';

// ---------- 保存と読み込み ----------
// 「その他」は常に一番下
function otherLast(list) { return [...list.filter(c => c !== 'その他'), ...list.filter(c => c === 'その他')]; }
// カテゴリを足す（「その他」の上に入る）。足した名前を返す
function addCategoryName(type, name) {
  const c = name?.trim();
  if (!c) return '';
  if (!state.categories[type].includes(c)) state.categories[type] = otherLast([...state.categories[type], c]);
  save();
  return c;
}
function normAccount(a) {
  return {
    id: a.id || uid(),
    name: a.name || '',
    kind: KINDS[a.kind] ? a.kind : 'asset',
    unit: a.kind === 'item' ? (a.unit || '個') : '円',
    memo: a.memo || '',
    hidden: !!a.hidden,
    // 初期残高は内訳の行で持つ（note＝出どころ・用途、due＝カードの支払日）
    initial: Array.isArray(a.initial) ? a.initial : (a.initial ? [{ amount: a.initial, note: '', due: '' }] : []),
    limit: a.limit || 0,
    closingDay: a.closingDay ?? 0,
    payDay: a.payDay ?? 27,
    payFrom: a.payFrom || '',
    parent: a.parent || '', // 親項目（現金の中の小銭など）
  };
}
function migrate(s) {
  const v = s.version || 1;
  if (v < 2) {
    s.accounts = s.accounts.map(a => (a.id === 'paypay-card' && a.kind === 'liability') ? { ...a, kind: 'card', payFrom: 'paypay-bank' } : a);
    if (!s.accounts.some(a => a.kind === 'held')) s.accounts.splice(Math.min(4, s.accounts.length), 0, { id: 'held', name: '預かり金', kind: 'held' });
    if (s.categories?.income && !s.categories.income.includes('もらいもの')) s.categories.income.splice(1, 0, 'もらいもの');
  }
  s.accounts = s.accounts.map(normAccount);
  s.categories ||= structuredClone(DEFAULT_CATS);
  for (const k of ['expense', 'income']) s.categories[k] = otherLast(s.categories[k] || []);
  s.natures ||= Object.fromEntries(s.categories.expense.map(c => [c, DEFAULT_NATURES[c] || 'consume']));
  s.balanceOrder ||= [];
  s.plans = (s.plans || []).map(p => {
    const { monthly, ...rest } = p;
    return { ...rest, repeat: p.repeat || (monthly ? 'monthly' : 'none'), day: p.day || Number(p.date.slice(8, 10)), auto: !!p.auto };
  });
  if (v < 4 && !s.accounts.some(a => a.name === '小銭')) {
    const i = s.accounts.findIndex(a => a.id === 'cash');
    if (i >= 0) s.accounts.splice(i + 1, 0, normAccount({ id: 'coins', name: '小銭', kind: 'asset', parent: 'cash' }));
  }
  s.fixes ||= [];
  // 1回だけ：預かり金は財布（現金）の中にあるので、現金の子にする（2026-10-15）
  const heldAcct = s.accounts.find(a => a.id === 'held' && a.kind === 'held');
  if (!s.fixes.includes('held-in-cash') && heldAcct && !heldAcct.parent && s.accounts.some(a => a.id === 'cash' && a.kind === 'asset')) {
    heldAcct.parent = 'cash';
    s.fixes.push('held-in-cash');
  }
  s.version = 4;
  return s;
}
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s && Array.isArray(s.accounts) && Array.isArray(s.txs)) return migrate(s);
  } catch (e) {}
  // まっさらから始める時は今の形（version 4）で作る。古いデータ向けの移行（小銭の自動追加など）は通さない
  return migrate({ version: 4, setupDone: false, fixes: ['held-in-cash'], accounts: structuredClone(DEFAULT_ACCOUNTS), categories: structuredClone(DEFAULT_CATS), txs: [], plans: [] });
}
function save() { localStorage.setItem(KEY, JSON.stringify(state)); }
function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch (e) { return {}; }
}
function savePrefs() { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); }

// ---------- アプリの色（端末ごとに prefs に保存。初回の色は index.html の先頭で当てる） ----------
const COLORS = [['green', '緑', '#1f7a4d'], ['ai', '藍', '#2b4aa8'], ['sumi', '墨', '#1f1f1f'], ['sumire', 'すみれ', '#6a3fc0']];
function applyColor() {
  const c = COLORS.find(x => x[0] === prefs.color) || COLORS[0];
  if (c[0] === 'green') delete document.documentElement.dataset.color; else document.documentElement.dataset.color = c[0];
  document.querySelector('meta[name=theme-color]').setAttribute('content', c[2]);
}
function renderColorSeg() {
  const cur = prefs.color || 'green';
  $('#color-seg').innerHTML = COLORS.map(([k, label, hex]) => `<button type="button" data-color="${k}" class="${k === cur ? 'on' : ''}" aria-pressed="${k === cur}"><span class="swatch" style="background:${hex}"></span>${label}</button>`).join('');
}

// ---------- 小道具 ----------
function $(sel) { return document.querySelector(sel); }
function pad(n) { return String(n).padStart(2, '0'); }
function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function today() { return ymd(new Date()); }
function addDays(s, n) { const [y, m, d] = s.split('-').map(Number); return ymd(new Date(y, m - 1, d + n)); }
// 月を足す。日は day（なければ元の日）で、月末を超えたら月末に寄せる
function addMonths(s, n, day) {
  const [y, m, d] = s.split('-').map(Number);
  const first = new Date(y, m - 1 + n, 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return `${first.getFullYear()}-${pad(first.getMonth() + 1)}-${pad(Math.min(day || d, last))}`;
}
function monthRange(ym) { return { from: ym + '-01', to: addDays(addMonths(ym + '-01', 1), -1) }; }
function shortDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  const md = `${m}/${d}(${'日月火水木金土'[new Date(y, m - 1, d).getDay()]})`;
  return y === new Date().getFullYear() ? md : `${y}/${md}`;
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function yen(n) { return (n < 0 ? '−¥' : '¥') + Math.abs(Math.round(n)).toLocaleString('ja-JP'); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function acct(id) { return state.accounts.find(a => a.id === id); }
function acctName(id) { return acct(id)?.name ?? '(削除済み)'; }
function visibleAccounts() { return state.accounts.filter(a => !a.hidden); }
const isItem = a => a?.kind === 'item';
const isDebt = a => a?.kind === 'card' || a?.kind === 'liability';
const countsInNet = a => a && (a.kind === 'asset' || isDebt(a));
// 金額をその項目の単位で書く（持ち物は「2枚」など）
function fmt(n, a) { return isItem(a) ? `${n < 0 ? '−' : ''}${Math.abs(n).toLocaleString('ja-JP')}${a.unit}` : yen(n); }
function initialTotal(a) { return a.initial.reduce((s, l) => s + l.amount, 0); }
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 1800);
}
// 「1,200」「１２００」「1200+340」などを数に直す
function parseAmount(str) {
  const s = String(str).replace(/[０-９＋]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/[,¥円\s]/g, '');
  if (!/^\d+(\+\d+)*$/.test(s)) return NaN;
  return s.split('+').reduce((a, b) => a + Number(b), 0);
}
// 数字の欄に出す文字：3桁ごとにカンマ（「1200+340」→「1,200+340」）
function withCommas(v) {
  return String(v ?? '').replace(/[０-９＋]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/[^\d+]/g, '')
    .split('+').map(x => (x ? Number(x).toLocaleString('ja-JP') : x)).join('+');
}
function row(label, value, cls = '', attrs = '') {
  return `<li${attrs}><div class="main">${label}</div><span class="num ${cls}">${value}</span></li>`;
}
const EMPTY = '<li class="day">なし</li>';

// ---------- 残高の計算 ----------
// 資産・預かり・持ち物はプラス、カードと負債はマイナス（払う必要がある額）で持つ
// 1件の記録が各項目をいくら増減させるか
function txEffects(t) {
  if (t.type === 'expense') return [[t.from, -t.amount]];
  if (t.type === 'income') return [[t.to, t.amount]];
  if (t.type === 'transfer') return [[t.from, -t.amount], [t.to, t.amount]];
  return [[t.to, t.amount]]; // adjust
}
function balances() {
  const bal = {};
  for (const a of state.accounts) bal[a.id] = (isDebt(a) ? -1 : 1) * initialTotal(a);
  for (const t of state.txs) for (const [id, n] of txEffects(t)) if (id in bal) bal[id] += n;
  return bal;
}
// カードで使った日から支払日を出す（締め日0＝月末締め）
function dueFor(card, dateStr) {
  const d = Number(dateStr.slice(8, 10));
  const closing = card.closingDay || 31;
  return addMonths(dateStr.slice(0, 8) + '01', d <= closing ? 1 : 2, card.payDay || 27);
}
// 次に来る支払日（支払日が未設定の初期残高はここに入れる）
function nextPayDay(card) {
  const t = today();
  const thisMonth = addMonths(t.slice(0, 8) + '01', 0, card.payDay || 27);
  return thisMonth >= t ? thisMonth : addMonths(t.slice(0, 8) + '01', 1, card.payDay || 27);
}
// カードの未払いを支払日ごとに分ける。払った分は古い支払日から消していく
// 支払日ごとの利用額（払う前の額）と、払った合計
function cardBuckets(card) {
  const bucket = {};
  let paid = 0;
  const add = (due, n) => { bucket[due] = (bucket[due] || 0) + n; };
  for (const l of card.initial) add(l.due || nextPayDay(card), l.amount);
  for (const t of state.txs) {
    if ((t.type === 'expense' || t.type === 'transfer') && t.from === card.id) add(dueFor(card, t.date), t.amount);
    else if (t.type === 'adjust' && t.to === card.id) { if (t.amount < 0) add(dueFor(card, t.date), -t.amount); else paid += t.amount; }
    else if ((t.type === 'transfer' || t.type === 'income') && t.to === card.id) paid += t.amount;
  }
  return { bucket, paid };
}
// 締めの期間（月末締めなら1日〜月末）に使った額＝その期間の支払日に払う額。monthsAgo=1で前の期間
function cardCycleUsage(card, monthsAgo = 0) {
  const d = addMonths(today().slice(0, 8) + '01', -monthsAgo, Number(today().slice(8, 10)));
  return cardBuckets(card).bucket[dueFor(card, d)] || 0;
}
function cardBills(card) {
  let { bucket, paid } = cardBuckets(card);
  const list = Object.keys(bucket).sort().map(due => ({ due, amount: bucket[due] }));
  for (const b of list) { const p = Math.min(paid, b.amount); b.amount -= p; paid -= p; }
  return list.filter(b => b.amount > 0);
}

// ---------- 予定（給料・定期支払い＋カード引き落とし） ----------
function repeatLabel(p) {
  if (p.repeat === 'monthly') return `毎月${p.day}日`;
  if (p.repeat === 'yearly') return `毎年${Number(p.date.slice(5, 7))}/${p.day}`;
  return '';
}
function upcoming(days) {
  const limit = addDays(today(), days);
  const items = [];
  for (const p of state.plans) {
    const step = REPEAT_STEP[p.repeat];
    for (let n = 0, d = p.date; d <= limit && n < 4; d = addMonths(p.date, ++n * step, p.day)) {
      items.push({ src: 'plan', plan: p, first: n === 0, date: d, name: p.name, type: p.type, amount: p.amount, account: p.account });
      if (!step) break;
    }
  }
  for (const c of state.accounts.filter(a => a.kind === 'card')) {
    for (const b of cardBills(c)) {
      if (b.due <= limit) items.push({ src: 'card', card: c, date: b.due, name: `${c.name} 引き落とし`, type: 'expense', amount: b.amount, account: c.payFrom });
    }
  }
  items.sort((a, b) => a.date.localeCompare(b.date));
  // その日のあとの口座残高の見込み
  const bal = balances();
  for (const it of items) {
    if (!(it.account in bal)) continue;
    bal[it.account] += it.type === 'income' ? it.amount : -it.amount;
    it.after = bal[it.account];
  }
  return items;
}
function planLine(it, withButtons) {
  const a = acct(it.account);
  const late = it.date < today();
  const short = it.after < 0 && !isDebt(a);
  const meta = !a ? '引き落とし口座 未設定'
    : isDebt(a) ? `${a.name} 未払い ${yen(-it.after)}`
    : `${a.name} 残高 ${fmt(it.after, a)}`;
  let btn = '';
  if (withButtons && it.src === 'plan' && it.first && !it.plan.auto) btn = `<button type="button" data-act="rec" data-id="${esc(it.plan.id)}">記録</button>`;
  if (withButtons && it.src === 'card') btn = `<button type="button" data-act="pay" data-id="${esc(it.card.id)}" data-amount="${it.amount}">記録</button>`;
  const attrs = it.src === 'plan' && withButtons ? ` data-plan="${esc(it.plan.id)}"` : '';
  return `<li${attrs}><div class="main">${late ? '<span class="tag">未処理</span>' : ''}${shortDate(it.date)} ${esc(it.name)}${it.src === 'plan' && it.plan.auto ? ' <span class="tag auto">自動</span>' : ''}<div class="meta ${short ? 'minus' : ''}">${esc(meta)}${short ? ' ・ 残高不足' : ''}</div></div>
    <span class="num ${it.type === 'income' ? 'plus' : 'minus'}">${it.type === 'income' ? '+' : '−'}${fmt(it.amount, a).replace('−', '')}</span>${btn ? `<span class="btns">${btn}</span>` : ''}</li>`;
}
// カードごとの「何日にいくら引き落とされるか」
function cardUsageLabel(card, due) {
  const m = Number(addMonths(due.slice(0, 8) + '01', -1).slice(5, 7)); // 支払日の前の月に締める
  return card.closingDay ? `${m}/${card.closingDay}締め分` : `${m}月利用分`;
}
function renderCardBills() {
  const t0 = today();
  $('#card-bills').innerHTML = state.accounts.filter(a => a.kind === 'card' && !a.hidden).map(c => {
    const bills = cardBills(c);
    const owed = bills.reduce((x, b) => x + b.amount, 0);
    const rows = bills.map(b => {
      const open = b.due === dueFor(c, t0); // 今まさに使っている期間の分
      const late = b.due < t0;
      const meta = [cardUsageLabel(c, b.due), open ? '未確定' : '', c.payFrom ? `${acctName(c.payFrom)}から` : '引き落とし口座 未設定'].filter(Boolean).join('・');
      return `<li data-card="${esc(c.id)}"><div class="main">${late ? '<span class="tag">未処理</span>' : ''}${shortDate(b.due)}<div class="meta">${esc(meta)}</div></div><span class="num">${yen(b.amount)}</span></li>`;
    }).join('') || EMPTY;
    const foot = owed ? row('<strong>未払い合計</strong>', yen(owed), 'minus') + (c.limit ? row('今月利用可能額', yen(c.limit - owed)) : '') : '';
    return `<h3>${esc(c.name)}</h3><ul class="list">${rows}${foot}</ul>`;
  }).join('');
}
function renderPlans() {
  renderCardBills();
  const items = upcoming(92);
  $('#plans').innerHTML = items.map(it => planLine(it, true)).join('') || EMPTY;
  $('#plans-count').textContent = items.length ? `・${items.length}件` : '';
  $('#home-plans').innerHTML = items.slice(0, 3).map(it => planLine(it, false)).join('') || EMPTY;
  // 定期支払い（サブスクなど）。年払いは12で割って月額換算する
  const recurring = t => state.plans.filter(p => p.repeat !== 'none' && p.type === t);
  const perMonth = list => list.reduce((s, p) => s + (p.repeat === 'yearly' ? p.amount / 12 : p.amount), 0);
  const fixed = recurring('expense'), regular = recurring('income');
  $('#fixed').innerHTML = fixed.map(p => `<li data-plan="${esc(p.id)}"><div class="main">${esc(p.name)}<div class="meta">${repeatLabel(p)}${p.auto ? '・自動' : ''} ・ ${esc(acctName(p.account))}${p.repeat === 'yearly' ? ` ・ 次回 ${shortDate(p.date)}` : ''}</div></div><span class="num">${yen(p.amount)}<small>/${p.repeat === 'yearly' ? '年' : '月'}</small></span></li>`).join('')
    + (fixed.length ? row('<strong>月額換算</strong>', yen(perMonth(fixed)), 'minus') + row('年額', yen(perMonth(fixed) * 12)) : EMPTY)
    + (regular.length ? row('定期収入（月額換算）', yen(perMonth(regular)), 'plus') + row('定期収入 − 定期支払い', yen(perMonth(regular) - perMonth(fixed))) : '');
  // 入力欄
  const f = $('#plan-form');
  document.querySelectorAll('#plan-type button').forEach(b => { b.classList.toggle('on', b.dataset.type === planType); b.setAttribute('aria-pressed', b.dataset.type === planType); });
  const curA = f.account.value, curC = f.category.value;
  f.account.innerHTML = state.accounts.filter(a => !isItem(a)).map(a => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
  if (curA) f.account.value = curA;
  const opt = c => `<option>${esc(c)}</option>`;
  f.category.innerHTML = (planType === 'expense'
    ? NATURES.map(([k, label]) => `<optgroup label="${label}">${state.categories.expense.filter(c => natureOf(c) === k).map(opt).join('')}</optgroup>`).join('')
    : (state.categories[planType] || []).map(opt).join('')) + '<option value="__new">＋ 新しいカテゴリ</option>';
  if (curC) f.category.value = curC;
  if (!f.date.value) f.date.value = today();
  $('#plan-form-title').textContent = planEditing ? '予定を編集' : '予定を追加';
  $('#plan-submit').textContent = planEditing ? '更新' : '追加';
  $('#plan-cancel').hidden = !planEditing;
  $('#plan-delete').hidden = !planEditing;
}
// 「自動で記録」の予定は、日付を過ぎていたらその日付で記録して次回へ進める（開かなかった日の分もまとめて）
function runAutoPlans() {
  const t0 = today();
  let n = 0;
  for (const p of [...state.plans]) {
    if (!p.auto) continue;
    for (let guard = 0; p.date <= t0 && guard < 60; guard++) {
      const income = p.type === 'income';
      state.txs.push({ id: uid(), date: p.date, type: p.type, amount: p.amount, from: income ? null : p.account, to: income ? p.account : null, category: p.category || (income ? '給料' : 'その他'), memo: p.name, auto: true, createdAt: Date.now() + n });
      n++;
      if (!REPEAT_STEP[p.repeat]) { state.plans = state.plans.filter(x => x !== p); break; }
      p.date = addMonths(p.date, REPEAT_STEP[p.repeat], p.day);
    }
  }
  if (n) { save(); toast(`予定 ${n}件を自動で記録しました`); }
  return n;
}
function resetPlanForm() {
  planEditing = null;
  const f = $('#plan-form');
  f.name.value = ''; f.amount.value = ''; f.date.value = today(); f.repeat.value = 'monthly'; f.auto.checked = planType === 'expense';
  renderPlans();
}
function submitPlan(e) {
  e.preventDefault();
  const f = e.target;
  const amount = parseAmount(f.amount.value);
  if (!(amount > 0)) return toast('金額を入力');
  if (f.category.value === '__new') return toast('カテゴリを選択');
  const date = f.date.value || today();
  const p = { id: planEditing || uid(), name: f.name.value.trim() || f.category.value || '予定', type: planType, amount, account: f.account.value, category: f.category.value, date, day: Number(date.slice(8, 10)), repeat: f.repeat.value, auto: f.auto.checked };
  const i = state.plans.findIndex(x => x.id === p.id);
  if (i >= 0) state.plans[i] = p; else state.plans.push(p);
  save();
  toast(planEditing ? '更新しました' : '追加しました');
  resetPlanForm(); renderAll();
}
function editPlan(id) {
  const p = state.plans.find(x => x.id === id);
  if (!p) return;
  planEditing = id; planType = p.type;
  renderPlans();
  const f = $('#plan-form');
  f.name.value = p.name; f.amount.value = withCommas(p.amount); f.account.value = p.account; f.category.value = p.category;
  f.date.value = p.date; f.repeat.value = p.repeat; f.auto.checked = !!p.auto;
  f.scrollIntoView({ behavior: 'smooth' });
}
function deletePlan() {
  const p = state.plans.find(x => x.id === planEditing);
  if (!p || !confirm(`「${p.name}」を削除しますか？`)) return;
  state.plans = state.plans.filter(x => x !== p);
  save(); resetPlanForm(); renderAll(); toast('削除しました');
}
function planClick(e) {
  const b = e.target.closest('button[data-act]');
  if (!b) { const li = e.target.closest('li[data-plan]'); if (li) editPlan(li.dataset.plan); return; }
  if (b.dataset.act === 'pay') {
    const c = acct(b.dataset.id);
    form = { type: 'transfer', from: c.payFrom || null, to: c.id, category: null, editing: null };
    $('#amount').value = withCommas(b.dataset.amount); $('#memo').value = ''; $('#date').value = today();
    showTab('add'); renderForm(); window.scrollTo(0, 0);
    return toast('確認して「記録」');
  }
  const p = state.plans.find(x => x.id === b.dataset.id);
  if (!p) return;
  const input = prompt(`${p.name} の金額`, String(p.amount));
  if (input === null) return;
  const amount = parseAmount(input);
  if (!(amount > 0)) return toast('数字で入力');
  const income = p.type === 'income';
  state.txs.push({ id: uid(), date: today(), type: p.type, amount, from: income ? null : p.account, to: income ? p.account : null, category: p.category || (income ? '給料' : 'その他'), memo: p.name, createdAt: Date.now() });
  if (REPEAT_STEP[p.repeat]) p.date = addMonths(p.date, REPEAT_STEP[p.repeat], p.day);
  else state.plans = state.plans.filter(x => x !== p);
  save(); renderAll();
  toast(`${yen(amount)} 記録しました`);
}

// ---------- ドル円（ECB基準レート。毎日1:00に更新） ----------
const FX_KEY = 'okane-fx';
const FX_URL = 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=JPY';
const FX_HOUR = 1; // ECBの公表（日本時間23〜0時ごろ）が済んだあと
let fx = (() => { try { return JSON.parse(localStorage.getItem(FX_KEY)); } catch (e) { return null; } })();
// 直近の「毎日1:00」の時刻
function lastFxBoundary() {
  const b = new Date();
  b.setHours(FX_HOUR, 0, 0, 0);
  if (b > new Date()) b.setDate(b.getDate() - 1);
  return b.getTime();
}
async function refreshFx() {
  if (fx && fx.fetchedAt >= lastFxBoundary()) return;
  try {
    const res = await fetch(FX_URL, { cache: 'no-store' });
    const j = await res.json();
    if (!(j.rates?.JPY > 0)) return;
    fx = { rate: j.rates.JPY, date: j.date, fetchedAt: Date.now() };
    localStorage.setItem(FX_KEY, JSON.stringify(fx));
    renderHeader();
  } catch (e) { /* 電波がないときは前回のレートのまま */ }
}
function usd(n) {
  return (n < 0 ? '−$' : '$') + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

// ---------- 画面: 上の合計と残高一覧 ----------
function renderHeader() {
  const bal = balances();
  let own = 0, debt = 0, held = 0;
  for (const a of state.accounts) {
    if (a.kind === 'asset') own += bal[a.id];
    else if (isDebt(a)) debt += bal[a.id];
    else if (a.kind === 'held') held += bal[a.id];
  }
  $('#net').textContent = yen(own + debt);
  $('#net').className = 'total ' + (own + debt < 0 ? 'minus' : '');
  $('#usd').innerHTML = fx ? `${usd((own + debt) / fx.rate)} <small>1ドル ${fx.rate.toFixed(2)}円</small>` : '';
  $('#sub').textContent = `資産 ${yen(own)} ・ 負債 ${yen(-debt)}${held ? ` ・ 預かり ${yen(held)}` : ''}`;
}
function childrenOf(id) { return state.accounts.filter(x => x.parent === id); }
// 親項目の残高は子の分も含めた合計
// 預かりの子は自分のお金ではないので合計に入れず、「手元」として別に出す
function familyBalance(a, bal) { return childrenOf(a.id).filter(c => c.kind !== 'held').reduce((s, c) => s + bal[c.id], bal[a.id]); }
function heldInside(a, bal) { return childrenOf(a.id).filter(c => c.kind === 'held').reduce((s, c) => s + bal[c.id], 0); }
function balanceLine(a, bal, child = false) {
  const b = familyBalance(a, bal);
  let meta = a.memo, amount = fmt(b, a), cls = b < 0 ? 'minus' : '';
  if (isDebt(a)) { amount = yen(-b); cls = 'minus'; }
  if (a.kind === 'card') {
    const next = cardBills(a)[0];
    meta = `今月利用 ${yen(cardCycleUsage(a))}` + (next ? ` ・ 次回 ${shortDate(next.due)} ${yen(next.amount)}` : '') + (a.initial.some(l => !l.due) ? ' ・ 支払日未設定あり' : '');
  }
  const held = heldInside(a, bal);
  if (held) meta = `手元 ${yen(b + held)}（うち預かり ${yen(held)}）` + (meta ? ` ・ ${meta}` : '');
  if (child && a.kind === 'held') {
    return `<li data-id="${esc(a.id)}" class="child held"><div class="main">${esc(a.name)} <span class="tag held-tag">預かり</span>${a.memo ? `<div class="meta">${esc(a.memo)}</div>` : ''}</div><span class="num">${amount}</span></li>`;
  }
  return `<li data-id="${esc(a.id)}"${child ? ' class="child"' : ''}><div class="main">${esc(a.name)}${meta ? `<div class="meta">${esc(meta)}</div>` : ''}</div><span class="num ${cls}">${amount}</span></li>`;
}
const BALANCE_GROUPS = [['資産', ['asset']], ['負債', ['card', 'liability']], ['預かり', ['held']], ['持ち物', ['item']]];
// 残高一覧の並び。balanceOrder にないものは後ろ（項目の並び順）
function balanceSorted(kinds) {
  const pos = id => { const i = state.balanceOrder.indexOf(id); return i < 0 ? Infinity : i; };
  return visibleAccounts().filter(a => kinds.includes(a.kind)).sort((a, b) => pos(a.id) - pos(b.id));
}
function renderBalances() {
  const bal = balances();
  const vis = visibleAccounts();
  const shownUnderParent = a => a.parent && vis.some(p => p.id === a.parent);
  // 子は親のいる見出しの下に出す（預かりの子も、置いてある現金の下に出す）
  const kidsOf = id => BALANCE_GROUPS.flatMap(([, k]) => balanceSorted(k)).filter(c => c.parent === id && !(c.kind === 'held' && !bal[c.id])); // 預かりが0円の時は出さない
  $('#balances').innerHTML = BALANCE_GROUPS.map(([title, kinds]) => {
    const tops = balanceSorted(kinds).filter(a => !shownUnderParent(a));
    return tops.length ? `<li class="day">${title}</li>` + tops.map(t => balanceLine(t, bal) + kidsOf(t.id).map(c => balanceLine(c, bal, true)).join('')).join('') : '';
  }).join('');
}
// 実際の残高を入力すると差額を「残高調整」として記録する
function adjustBalance(id) {
  const a = acct(id);
  const cur = balances()[id];
  const debt = isDebt(a);
  const shown = debt ? -cur : cur;
  const what = a.kind === 'card' ? '未払い額' : debt ? '負債額' : '残高';
  const all = balances();
  const own = childrenOf(a.id).filter(c => c.kind !== 'held').map(c => c.name);
  const heldKids = childrenOf(a.id).filter(c => c.kind === 'held');
  const held = heldKids.reduce((x, c) => x + all[c.id], 0);
  const note = [own.length ? `${own.join('・')}以外` : '', heldKids.length ? `${heldKids.map(c => c.name).join('・')}込み` : ''].filter(Boolean).join('、');
  const input = prompt(`${a.name}${note ? `（${note}）` : ''} の実際の${what}\n記録上: ${fmt(shown + held, a)}`, String(shown + held));
  if (input === null) return;
  const real = parseAmount(input) - held; // 預かり分はアプリが引く
  if (Number.isNaN(real)) return toast('数字で入力');
  const diff = (debt ? -real : real) - cur;
  if (diff === 0) return toast('差額なし');
  state.txs.push({ id: uid(), date: today(), type: 'adjust', amount: diff, from: null, to: id, category: '残高調整', memo: '', createdAt: Date.now() });
  save(); renderAll();
  toast(`${fmt(diff, a)} 調整しました`);
}

// ---------- 画面: 項目の詳細 ----------
function groupSum(list, key) {
  const m = {};
  for (const x of list) m[key(x)] = (m[key(x)] || 0) + x.amount;
  return Object.entries(m).sort((a, b) => b[1] - a[1]);
}
function sumList(rows, a, cls = '') {
  return rows.map(([k, v]) => row(esc(k), fmt(v, a), cls, ` data-cat="${esc(k)}"`)).join('') || EMPTY;
}
function renderDetail() {
  const a = acct(detailId);
  if (!a) return;
  const all = balances();
  const kids = childrenOf(a.id);
  const sign = isDebt(a) ? -1 : 1;
  const shown = sign * familyBalance(a, all);
  let html = `<h2>${esc(a.name)} <span class="meta">${KINDS[a.kind]}</span></h2>
    <div class="total ${isDebt(a) ? 'minus' : ''}">${fmt(shown, a)}</div>${a.memo ? `<p>${esc(a.memo)}</p>` : ''}`;
  if (kids.length) {
    const ownKids = kids.filter(c => c.kind !== 'held'), heldKids = kids.filter(c => c.kind === 'held');
    const held = heldInside(a, all);
    html += `<ul class="list">${ownKids.map(c => row(esc(c.name), fmt(sign * all[c.id], c))).join('')}${row(`${esc(ownKids.length ? ownKids.map(c => c.name).join('・') + '以外' : a.name)}`, fmt(sign * all[a.id], a))}`
      + `${heldKids.map(c => row(`${esc(c.name)} <span class="tag held-tag">預かり</span>`, fmt(all[c.id], c), 'muted')).join('')}`
      + `${held ? row('<strong>手元の合計</strong>', yen(shown + held)) : ''}</ul>`;
  }
  html += `
    <button type="button" id="adjust-btn">残高を修正</button>`;
  if (a.kind === 'card') {
    html += `<h3>利用状況</h3><ul class="list">
      ${row(`今月の利用額 <span class="meta">${shortDate(dueFor(a, today()))}払い</span>`, yen(cardCycleUsage(a)))}
      ${row(`先月の利用額 <span class="meta">${shortDate(dueFor(a, addMonths(today().slice(0, 8) + '01', -1)))}払い</span>`, yen(cardCycleUsage(a, 1)))}
      ${row('未払い合計', yen(shown), 'minus')}
      ${a.limit ? row(`利用可能額 <span class="meta">枠 ${yen(a.limit)}</span>`, yen(a.limit - shown)) : ''}
    </ul><h3>支払い予定${a.payFrom ? `（${esc(acctName(a.payFrom))}）` : ''}</h3>
    <ul class="list">${cardBills(a).map(b => row(shortDate(b.due), yen(b.amount))).join('') || EMPTY}</ul>`;
  }
  if (a.initial.length) {
    html += `<h3>${a.kind === 'held' ? '預かりの内訳' : '初期残高の内訳'}</h3><ul class="list">${a.initial.map(l => row(`${esc(l.note || '—')}${l.due ? `<div class="meta">支払日 ${shortDate(l.due)}</div>` : a.kind === 'card' ? '<div class="meta minus">支払日未設定</div>' : ''}`, fmt(l.amount, a))).join('')}</ul>`;
  }
  const ins = state.txs.filter(t => t.to === a.id && t.type !== 'adjust');
  const outs = state.txs.filter(t => t.from === a.id);
  const label = t => t.type === 'transfer' ? (t.to === a.id ? `${acctName(t.from)}から` : `${acctName(t.to)}へ`) : t.category;
  html += `<h3>入金の内訳</h3><ul class="list">${sumList(groupSum(ins, label), a)}</ul>
    <h3>出金の内訳</h3><ul class="list">${sumList(groupSum(outs, label), a)}</ul>
    ${accountTrend(a)}
    <h3>最近の記録</h3><ul class="list" id="detail-txs">${state.txs.filter(t => t.from === a.id || t.to === a.id).sort(byNewest).slice(0, 30).map(t => txLine(t, a.id)).join('') || EMPTY}</ul>`;
  $('#acct-detail').innerHTML = html;
  $('#adjust-btn').onclick = () => adjustBalance(a.id);
}
function accountTrend(a) {
  const ids = [a.id, ...childrenOf(a.id).map(c => c.id)];
  const mine = state.txs.filter(t => ids.includes(t.from) || ids.includes(t.to));
  if (!mine.length) return '';
  const t0 = today();
  const first = mine.reduce((m, t) => (t.date < m ? t.date : m), t0);
  const from = [first, addDays(t0, -90)].sort()[1];
  const { days, values } = dailyTotals(ids, from, t0);
  const sign = isDebt(a) ? -1 : 1;
  return `<h3>残高の推移</h3>${lineChart([{ color: isDebt(a) ? 'var(--minus)' : 'var(--accent)', values: values.map(v => sign * v) }], days.map(mdLabel))}`;
}
function openDetail(id) { detailId = id; renderDetail(); showTab('account'); window.scrollTo(0, 0); }

// ---------- 並べ替え（縦1列のリストで、触れた行をそのまま動かす） ----------
let sorter = null; // { kind: 'accounts' | 'cats', catType, ids }
let sd = null;     // ドラッグ中の状態
let suppressNextClick = false; // 長押しで指を離したときのタップを1回だけ無視する
function openSorter(kind) {
  const sections = kind === 'accounts' ? [{ title: '', ids: visibleAccounts().map(a => a.id) }]
    : kind === 'cats' ? (form.type === 'expense'
      ? NATURES.map(([k, title]) => ({ title, key: k, ids: state.categories.expense.filter(c => natureOf(c) === k) }))
      : [{ title: '', ids: [...state.categories[form.type]] }])
    : BALANCE_GROUPS.map(([title, kinds]) => ({ title, ids: balanceSorted(kinds).map(a => a.id) })).filter(x => x.ids.length);
  sorter = { kind, catType: form.type, sections, merges: [], confirm: null };
  $('#sorter-title').textContent = { accounts: '支払い元の並べ替え', balances: '残高の並べ替え', cats: `${form.type === 'income' ? '収入源' : '用途'}の編集` }[kind];
  renderSorter();
  $('#sorter').hidden = false;
  document.body.classList.add('noscroll');
}
// カテゴリを使っている記録・予定の数
function catUsage(type, name) {
  return state.txs.filter(t => t.type === type && t.category === name).length + state.plans.filter(p => p.type === type && p.category === name).length;
}
function sorterRow(id, si) {
  const ren = `<button type="button" class="ren" data-id="${esc(id)}">名前変更</button><button type="button" class="mv" data-id="${esc(id)}" data-sec="${si}" data-d="-1" aria-label="上へ">↑</button><button type="button" class="mv" data-id="${esc(id)}" data-sec="${si}" data-d="1" aria-label="下へ">↓</button>`;
  if (sorter.kind !== 'cats') return `<li data-sec="${si}"><span class="name">${esc(acctName(id))}</span>${ren}<span class="handle" aria-hidden="true">≡</span></li>`;
  if (sorter.confirm !== id) return `<li data-sec="${si}"><span class="name">${esc(id)}</span><button type="button" class="ren" data-id="${esc(id)}">名前変更</button><button type="button" class="del" data-id="${esc(id)}">削除</button>${ren.replace(/^<button type="button" class="ren"[^>]*>名前変更<\/button>/, '')}<span class="handle" aria-hidden="true">≡</span></li>`;
  // 削除の確認。記録があれば移し先を選べる
  const n = catUsage(sorter.catType, id) + sorter.merges.filter(m => m.to === id).length;
  const others = sorter.sections.flatMap(x => x.ids).filter(x => x !== id);
  return `<li class="confirm"><div><strong>${esc(id)}</strong> を削除${n ? `<div class="meta">記録・予定 ${n}件の移し先</div><select class="merge-to"><option value="">移さない</option>${others.map(o => `<option>${esc(o)}</option>`).join('')}</select>` : ''}</div>
    <span class="btns"><button type="button" class="del-cancel">戻る</button><button type="button" class="del-ok danger" data-id="${esc(id)}">削除</button></span></li>`;
}
function renderSorter() {
  const isCats = sorter.kind === 'cats';
  const addRow = (si, label) => `<li class="add-row"><button type="button" class="sorter-add" data-sec="${si}">＋ ${label}</button></li>`;
  $('#sorter-list').innerHTML = sorter.sections.map((sec, si) => (sec.title ? `<li class="sec">${esc(sec.title)}</li>` : '')
    + sec.ids.map(id => sorterRow(id, si)).join('')
    + (isCats ? addRow(si, sec.title ? `${sec.title}に追加` : '追加') : '')).join('')
    + (isCats ? '' : addRow(-1, '項目を追加'));
}
// 並べ替え画面から追加。用途はその区切りに名前だけで足す。口座は並びを確定してから設定の入力欄を開く
function addFromSorter(si) {
  if (sorter.kind !== 'cats') { closeSorter(); return quickAddAccount('from'); }
  const name = prompt(sorter.catType === 'income' ? '新しい収入源' : `新しい用途（${sorter.sections[si].title || '用途'}）`)?.trim();
  if (!name) return;
  if (sorter.sections.some(x => x.ids.includes(name))) return toast('同じ名前があります');
  sorter.sections[si].ids.push(name);
  renderSorter();
  toast(`「${name}」を追加しました（完了で確定）`);
}
// 名前変更。口座はその場で名前だけ、用途・収入源は過去の記録と予定の名前もいっしょに変える
function renameInSorter(id) {
  const old = sorter.kind === 'cats' ? id : acctName(id);
  const name = prompt('新しい名前', old)?.trim();
  if (!name || name === old) return;
  if (sorter.kind !== 'cats') {
    if (state.accounts.some(a => a.id !== id && a.name === name)) return toast('同じ名前の項目があります');
    acct(id).name = name;
  } else {
    if (sorter.sections.some(x => x.ids.includes(name))) return toast('同じ名前があります（まとめるなら削除して移す）');
    for (const sec of sorter.sections) sec.ids = sec.ids.map(x => (x === id ? name : x));
    for (const t of [...state.txs, ...state.plans]) if (t.type === sorter.catType && t.category === id) t.category = name;
    for (const m of sorter.merges) { if (m.from === id) m.from = name; if (m.to === id) m.to = name; }
    if (form.category === id) form.category = name;
  }
  save(); renderSorter();
}
function sorterClick(e) {
  if (!sorter) return;
  const add = e.target.closest('.sorter-add');
  if (add) return addFromSorter(Number(add.dataset.sec));
  const ren = e.target.closest('.ren');
  if (ren) return renameInSorter(ren.dataset.id);
  const mv = e.target.closest('.mv');
  if (mv) {
    const si = Number(mv.dataset.sec), d = Number(mv.dataset.d);
    const ids = sorter.sections[si].ids;
    const i = ids.indexOf(mv.dataset.id), j = i + d;
    if (i < 0) return;
    if (j < 0 || j >= ids.length) { // 区画の端：隣の区画（性質）へ移す
      const next = sorter.sections[si + d];
      if (sorter.kind !== 'cats' || !next) return;
      ids.splice(i, 1);
      if (d < 0) next.ids.push(mv.dataset.id); else next.ids.unshift(mv.dataset.id);
    } else [ids[i], ids[j]] = [ids[j], ids[i]];
    renderSorter();
    $(`#sorter-list .mv[data-id="${CSS.escape(mv.dataset.id)}"][data-d="${mv.dataset.d}"]`)?.focus();
    return;
  }
  const del = e.target.closest('.del');
  if (del) { sorter.confirm = del.dataset.id; return renderSorter(); }
  if (e.target.closest('.del-cancel')) { sorter.confirm = null; return renderSorter(); }
  const ok = e.target.closest('.del-ok');
  if (ok) {
    const id = ok.dataset.id;
    const to = e.target.closest('li').querySelector('.merge-to')?.value || '';
    for (const sec of sorter.sections) sec.ids = sec.ids.filter(x => x !== id);
    if (to) sorter.merges.push({ from: id, to });
    sorter.confirm = null;
    renderSorter();
  }
}
function closeSorter() {
  const ids = sorter.sections.flatMap(x => x.ids);
  if (sorter.kind === 'accounts') state.accounts = [...ids.map(acct), ...state.accounts.filter(a => !ids.includes(a.id))];
  else if (sorter.kind === 'balances') state.balanceOrder = ids;
  else {
    state.categories[sorter.catType] = otherLast(ids);
    if (sorter.catType === 'expense') state.natures = Object.fromEntries(sorter.sections.flatMap(sec => sec.ids.map(id => [id, sec.key])));
    // 削除したカテゴリの記録・予定を移し先へ（A→B、B→C と続いても最後の行き先へ）
    const dest = name => { let d = name, m; while ((m = sorter.merges.find(x => x.from === d))) d = m.to; return d; };
    for (const t of [...state.txs, ...state.plans]) if (t.type === sorter.catType) t.category = dest(t.category);
  }
  sorter = null;
  $('#sorter').hidden = true;
  document.body.classList.remove('noscroll');
  save(); renderAll();
}
function updateSort() {
  const { li, list, items, from, h } = sd;
  const dy = sd.y - sd.y0 + (list.scrollTop - sd.s0);
  li.style.transform = `translateY(${dy}px)`;
  const to = Math.max(0, Math.min(items.length - 1, Math.round(from + dy / h)));
  items.forEach((it, i) => {
    if (it === li) return;
    const shift = from < to && i > from && i <= to ? -h : from > to && i >= to && i < from ? h : 0;
    it.style.transform = shift ? `translateY(${shift}px)` : '';
  });
  sd.to = to;
}
// 端に近づいたら自動でスクロール
function sortTick() {
  if (!sd) return;
  const r = sd.list.getBoundingClientRect();
  if (sd.y < r.top + 56) sd.list.scrollTop -= 8;
  else if (sd.y > r.bottom - 56) sd.list.scrollTop += 8;
  updateSort();
  sd.raf = requestAnimationFrame(sortTick);
}
function endSort() {
  if (!sd) return;
  cancelAnimationFrame(sd.raf);
  const ids = sorter.sections[sd.sec].ids;
  ids.splice(sd.to, 0, ids.splice(sd.from, 1)[0]);
  sd = null;
  renderSorter();
}
// 記録画面のボタンを長押ししても並べ替えを開ける
function longPressOpens(box, kind, sel = 'button[data-v]') {
  let t = null, x = 0, y = 0;
  box.addEventListener('pointerdown', e => {
    if (!e.target.closest(sel)) return;
    x = e.clientX; y = e.clientY;
    t = setTimeout(() => { t = null; suppressNextClick = true; openSorter(kind); }, 500);
  });
  const stop = () => { clearTimeout(t); t = null; };
  box.addEventListener('pointermove', e => { if (t && Math.hypot(e.clientX - x, e.clientY - y) > 8) stop(); });
  box.addEventListener('pointerup', stop);
  box.addEventListener('pointercancel', stop);
  box.addEventListener('contextmenu', e => e.preventDefault());
}
document.addEventListener('pointerdown', () => { suppressNextClick = false; }, true);
document.addEventListener('click', e => { if (suppressNextClick) { suppressNextClick = false; e.stopPropagation(); e.preventDefault(); } }, true);

// ---------- 画面: 記録フォーム ----------
// 文字の見た目の幅（全角1・半角0.55）。マスに収まらない長い名前は文字を小さくする
function textWidth(t) { return [...t].reduce((w, c) => w + (c.charCodeAt(0) < 0x2000 ? 0.55 : 1), 0); }
function chip(value, label, on, max = 7) {
  return `<button type="button" data-v="${esc(value)}" aria-pressed="${on}" class="${on ? 'on' : ''}${textWidth(label) > max ? ' long' : ''}">${esc(label)}</button>`;
}
// 預かり・持ち物はカテゴリを選ばない（純資産や集計に入らないため）
function needsCategory() {
  const a = acct(form.from);
  return form.type !== 'transfer' && !(a && (a.kind === 'held' || isItem(a)));
}
function autoCategory() {
  const a = acct(form.from);
  if (a?.kind === 'held') return form.type === 'expense' ? '引渡し' : '受取';
  return form.type === 'expense' ? '使用' : '追加';
}
function renderForm() {
  document.querySelectorAll('#type-seg button').forEach(b => { b.classList.toggle('on', b.dataset.type === form.type); b.setAttribute('aria-pressed', b.dataset.type === form.type); });
  const accts = visibleAccounts();
  if (!acct(form.from)) form.from = accts[0]?.id;
  if (!acct(form.to)) form.to = accts.find(a => a.id !== form.from)?.id;
  $('#from-label').textContent = { expense: '支払い元', income: '入金先', transfer: '移動元' }[form.type];
  $('#from-chips').innerHTML = accts.map(a => chip(a.id, a.name, a.id === form.from)).join('') + '<button type="button" data-add="1" class="add" aria-label="口座を追加">＋</button>';
  $('#to-wrap').hidden = form.type !== 'transfer';
  $('#to-chips').innerHTML = accts.map(a => chip(a.id, a.name, a.id === form.to)).join('') + '<button type="button" data-add="1" class="add" aria-label="口座を追加">＋</button>';
  $('#cat-wrap').hidden = !needsCategory();
  $('#cat-label').textContent = form.type === 'income' ? '収入源' : '用途';
  const cats = state.categories[form.type] || [];
  if (!cats.includes(form.category)) form.category = null;
  if (form.type === 'expense') {
    $('#cat-chips').innerHTML = NATURES.map(([k, label]) => `<div class="cat-head">${label}</div><div class="grid">${cats.filter(c => natureOf(c) === k).map(c => chip(c, c, c === form.category, 5)).join('')}<button type="button" data-add="1" data-nature="${k}" class="add" aria-label="${label}に用途を追加">＋</button></div>`).join('');
  } else {
    $('#cat-chips').innerHTML = `<div class="grid">${cats.map(c => chip(c, c, c === form.category, 5)).join('')}<button type="button" data-add="1" class="add" aria-label="収入源を追加">＋</button></div>`;
  }
  // 選んだ用途の性質（ふだんは用途の分類のまま。違うときだけ切り替える）
  const showNature = form.type === 'expense' && needsCategory() && !!form.category;
  $('#nature-seg').hidden = !showNature;
  if (showNature) {
    const cur = form.nature || natureOf(form.category);
    $('#nature-seg').innerHTML = NATURES.map(([k, label]) => `<button type="button" data-n="${k}" class="${k === cur ? 'on' : ''}" aria-pressed="${k === cur}">${label}</button>`).join('');
  }
  const fa = acct(form.from);
  $('#amount').placeholder = isItem(fa) ? `数（${fa.unit}）` : '金額';
  $('#edit-bar').hidden = !form.editing;
  $('#save').textContent = form.editing ? '更新' : '記録';
}
function setType(type) {
  form.type = type;
  const last = prefs['last-' + type] || {};
  if (acct(last.from)) form.from = last.from;
  if (acct(last.to)) form.to = last.to;
  form.category = null;
  form.nature = null;
  renderForm();
}
function resetForm() {
  form.editing = null;
  $('#amount').value = '';
  $('#memo').value = '';
  $('#date').value = today();
  setType(form.type);
}
function addCategory(nature) {
  const c = addCategoryName(form.type, prompt(form.type === 'income' ? '新しい収入源' : `新しい用途（${NATURE_LABEL[nature] || '消費'}）`));
  if (!c) return;
  if (form.type === 'expense' && nature) { state.natures[c] = nature; save(); }
  form.nature = null;
  form.category = c;
  renderForm(); renderPlans();
}
function submitForm(e) {
  e.preventDefault();
  const amount = parseAmount($('#amount').value);
  if (!(amount > 0)) return toast('金額を入力');
  if (form.type === 'transfer') {
    if (form.from === form.to) return toast('移動元と移動先が同じです');
    if (isItem(acct(form.from)) !== isItem(acct(form.to))) return toast('持ち物とお金の間は移動できません');
  }
  if (needsCategory() && !form.category) return toast(form.type === 'income' ? '収入源を選択' : '用途を選択');
  const tx = {
    id: form.editing || uid(),
    date: $('#date').value || today(),
    type: form.type,
    amount,
    from: form.type === 'income' ? null : form.from,
    to: form.type === 'income' ? form.from : form.type === 'transfer' ? form.to : null,
    category: form.type === 'transfer' ? '移動' : needsCategory() ? form.category : autoCategory(),
    ...(form.type === 'expense' && needsCategory() ? { nature: form.nature || natureOf(form.category) } : {}),
    memo: $('#memo').value.trim(),
    createdAt: Date.now(),
  };
  const wasEditing = !!form.editing;
  if (wasEditing) {
    const i = state.txs.findIndex(t => t.id === form.editing);
    tx.createdAt = state.txs[i]?.createdAt ?? tx.createdAt;
    if (i >= 0) state.txs[i] = tx; else state.txs.push(tx);
  } else {
    state.txs.push(tx);
  }
  prefs['last-' + form.type] = { from: form.from, to: form.to };
  save(); savePrefs();
  toast(wasEditing ? '更新しました' : `${fmt(amount, acct(form.from))} 記録しました`);
  resetForm();
  renderAll();
}
function startEdit(id) {
  const t = state.txs.find(x => x.id === id);
  if (!t) return;
  if (t.type === 'adjust') {
    if (confirm(`残高調整 ${fmt(t.amount, acct(t.to))}（${acctName(t.to)}）を削除しますか？`)) {
      state.txs = state.txs.filter(x => x.id !== id);
      save(); renderAll();
    }
    return;
  }
  form = { type: t.type, from: t.type === 'income' ? t.to : t.from, to: t.type === 'transfer' ? t.to : null, category: t.category, nature: t.nature || null, editing: t.id };
  $('#amount').value = withCommas(t.amount);
  $('#memo').value = t.memo;
  $('#date').value = t.date;
  showTab('add');
  renderForm();
  window.scrollTo(0, 0);
}
function deleteEditing() {
  if (!form.editing || !confirm('この記録を削除しますか？')) return;
  state.txs = state.txs.filter(t => t.id !== form.editing);
  save(); resetForm(); renderAll();
  toast('削除しました');
}

// ---------- グラフ（SVGを直接描く。外部の部品なしでオフラインでも描ける） ----------
// どれも白・黒どちらの背景とも3:1以上（WCAG）
// グラフの色はアプリの色ごと。どれも白・黒どちらの地とも3:1以上
const PALETTES = {
  green: ['#1f7a4d', '#c9601c', '#3b6fd8', '#c0392b', '#8e5bd0', '#a67c00', '#2a9d8f', '#e05a9b', '#7a8b99'],
  ai: ['#4566cc', '#d0622a', '#1f8a8a', '#c2416f', '#7a5cc7', '#9a7b00', '#4a7bd4', '#c0392b', '#66788f'],
  sumi: ['#6b6b6b', '#ab5a33', '#4f7394', '#8a7428', '#7d6699', '#3d7a68', '#bb4844', '#868686', '#4a6fa5'],
  sumire: ['#7a4fd0', '#d23f78', '#2a86bd', '#d9701f', '#2f8f72', '#a447c0', '#5468d4', '#8c7f9e', '#a8791f'],
};
function palColor(i) { const p = PALETTES[prefs.color] || PALETTES.green; return p[i % p.length]; }
function compactYen(n) {
  const a = Math.abs(n), sgn = n < 0 ? '−' : '';
  if (a >= 10000) return sgn + (a / 10000).toFixed(a >= 100000 ? 0 : 1).replace(/\.0$/, '') + '万';
  return sgn + Math.round(a).toLocaleString('ja-JP');
}
// 上位8件＋残りをまとめる
function topItems(entries, n = 8) {
  const items = entries.map(([label, value]) => ({ label, value }));
  if (items.length <= n + 1) return items;
  return [...items.slice(0, n), { label: `ほか${items.length - n}件`, value: items.slice(n).reduce((s, x) => s + x.value, 0), rest: true }];
}
function legend(items, total, clickable) {
  return `<ul class="list legend">${items.map((it, i) => `<li${clickable && !it.rest ? (it.key ? ` data-nature="${it.key}"` : ` data-cat="${esc(it.label)}"`) : ''}><div class="main"><span class="dot" style="background:${it.color || palColor(i)}"></span>${esc(it.label)} <span class="meta-inline">${Math.round(it.value / total * 100)}%</span></div><span class="num">${yen(it.value)}</span></li>`).join('')}</ul>`;
}
function donut(items) {
  const total = items.reduce((s, x) => s + x.value, 0);
  if (!total) return '';
  const R = 80, r = 50, c = 90;
  const pt = (rad, ang) => `${(c + rad * Math.cos(ang)).toFixed(2)} ${(c + rad * Math.sin(ang)).toFixed(2)}`;
  let a0 = -Math.PI / 2, svg = '';
  items.forEach((it, i) => {
    const col = it.color || palColor(i);
    const frac = it.value / total;
    if (frac > 0.9999) { svg += `<circle cx="${c}" cy="${c}" r="${(R + r) / 2}" fill="none" stroke="${col}" stroke-width="${R - r}"/>`; return; }
    const a1 = a0 + frac * 2 * Math.PI, big = frac > 0.5 ? 1 : 0;
    svg += `<path d="M${pt(R, a0)} A${R} ${R} 0 ${big} 1 ${pt(R, a1)} L${pt(r, a1)} A${r} ${r} 0 ${big} 0 ${pt(r, a0)}Z" fill="${col}"/>`;
    a0 = a1;
  });
  return `<svg viewBox="0 0 180 180" class="chart donut" role="img" aria-label="内訳のドーナツグラフ。合計${yen(total)}。下の一覧に用途ごとの金額">${svg}<text x="${c}" y="${c - 4}" class="c-sub">合計</text><text x="${c}" y="${c + 16}" class="c-main">${yen(total)}</text></svg>`;
}
// series: [{ color, values: [数 or null] }]、xLabels: 各点のラベル
function lineChart(series, xLabels, { lastLabel = true, floor0 = false } = {}) {
  const W = 360, H = 180, L = 46, Rm = 12, T = 12, B = 24;
  const ys = series.flatMap(x => x.values).filter(v => v != null);
  if (!ys.length) return '';
  let min = Math.min(...ys), max = Math.max(...ys);
  const fromZero = floor0 || min === 0; // 累計など0から始まるものは0より下を描かない
  if (fromZero) min = 0;
  if (min === max) { min -= Math.max(1, Math.abs(min) * 0.1); max += Math.max(1, Math.abs(max) * 0.1); }
  const pad = (max - min) * 0.08; min = fromZero ? 0 : min - pad; max += pad;
  // 幅が小さいときは丸めすぎないよう、100円単位で書く
  const ylab = v => (max - min >= 100000 ? compactYen(v) : (Math.round(v / 100) * 100).toLocaleString('ja-JP'));
  const n = Math.max(...series.map(x => x.values.length));
  const X = i => L + (n <= 1 ? (W - L - Rm) / 2 : i * (W - L - Rm) / (n - 1));
  const Y = v => T + (max - v) * (H - T - B) / (max - min);
  let svg = '';
  for (let k = 0; k <= 2; k++) {
    const v = min + (max - min) * k / 2;
    svg += `<line x1="${L}" x2="${W - Rm}" y1="${Y(v)}" y2="${Y(v)}" class="grid"/><text x="${L - 4}" y="${Y(v) + 3}" class="ylab">${ylab(v)}</text>`;
  }
  if (min < 0 && max > 0) svg += `<line x1="${L}" x2="${W - Rm}" y1="${Y(0)}" y2="${Y(0)}" class="zero"/>`;
  for (const sr of [...series].reverse()) { // 1本目（主役）を最後に描いて一番上に出す
    let seg = [];
    const flush = () => { if (seg.length) svg += `<polyline points="${seg.join(' ')}" fill="none" stroke="${sr.color}" stroke-width="2.2" stroke-linejoin="round"${sr.dash ? ' stroke-dasharray="4 3"' : ''}/>`; seg = []; };
    sr.values.forEach((v, i) => { if (v == null) flush(); else seg.push(`${X(i).toFixed(1)},${Y(v).toFixed(1)}`); });
    flush();
  }
  const main = series[0].values;
  const li = main.reduce((acc, v, i) => (v != null ? i : acc), -1);
  if (lastLabel && li >= 0) svg += `<circle cx="${X(li)}" cy="${Y(main[li])}" r="3.5" fill="${series[0].color}"/>`;
  const idx = n <= 2 ? [...Array(n).keys()] : [0, Math.floor((n - 1) / 2), n - 1];
  idx.forEach((i, k) => { svg += `<text x="${X(i)}" y="${H - 6}" class="xlab" text-anchor="${n > 1 && k === 0 ? 'start' : n > 1 && i === n - 1 ? 'end' : 'middle'}">${esc(xLabels[i] ?? '')}</text>`; });
  const v = series[0].values.filter(x => x != null);
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="折れ線グラフ。${esc(xLabels[0] ?? '')}から${esc(xLabels.at(-1) ?? '')}まで。始め${yen(v[0] ?? 0)}、終わり${yen(v.at(-1) ?? 0)}">${svg}</svg>`;
}
function barChart(groups) { // [{ label, inc, exp }]
  const W = 360, H = 190, L = 46, Rm = 8, T = 16, B = 24;
  const max = Math.max(1, ...groups.flatMap(g => [g.inc, g.exp]));
  const Y = v => T + (max - v) * (H - T - B) / max;
  const gw = (W - L - Rm) / groups.length, bw = Math.min(18, gw / 3);
  let svg = '';
  for (let k = 0; k <= 2; k++) { const v = max * k / 2; svg += `<line x1="${L}" x2="${W - Rm}" y1="${Y(v)}" y2="${Y(v)}" class="grid"/><text x="${L - 4}" y="${Y(v) + 3}" class="ylab">${compactYen(v)}</text>`; }
  groups.forEach((g, i) => {
    const cx = L + gw * i + gw / 2;
    svg += `<rect x="${cx - bw - 1}" y="${Y(g.inc)}" width="${bw}" height="${Y(0) - Y(g.inc)}" fill="var(--plus)" rx="2"/>`;
    svg += `<rect x="${cx + 1}" y="${Y(g.exp)}" width="${bw}" height="${Y(0) - Y(g.exp)}" fill="var(--minus)" rx="2"/>`;
    svg += `<text x="${cx}" y="${H - 6}" class="xlab" text-anchor="middle">${esc(g.label)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="棒グラフ。${groups.map(g => `${g.label} 収入${yen(g.inc)} 支出${yen(g.exp)}`).join('、')}">${svg}</svg>`;
}
// 指定した項目の合計残高を日ごとに出す（初期残高を記録の始まりとして積み上げる）
function dailyTotals(ids, from, to) {
  const set = new Set(ids);
  let v = state.accounts.filter(a => set.has(a.id)).reduce((s, a) => s + (isDebt(a) ? -1 : 1) * initialTotal(a), 0);
  const byDay = {};
  for (const t of state.txs) for (const [id, n] of txEffects(t)) {
    if (!set.has(id)) continue;
    if (t.date < from) v += n; else byDay[t.date] = (byDay[t.date] || 0) + n;
  }
  const days = [], values = [];
  for (let d = from; d <= to; d = addDays(d, 1)) { v += byDay[d] || 0; days.push(d); values.push(v); }
  return { days, values };
}
const mdLabel = d => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
function renderCharts(txs) {
  const t0 = today();
  const exp = txs.filter(t => t.type === 'expense' && countsInNet(acct(t.from)));
  let html = '';
  // 0. 投資・消費・浪費
  const nItems = NATURES.map(([k, label]) => ({ label, key: k, color: NATURE_COLOR[k], value: exp.filter(t => txNature(t) === k).reduce((s, t) => s + t.amount, 0) })).filter(x => x.value);
  const nTotal = nItems.reduce((s, x) => s + x.value, 0);
  if (nTotal) html += `<h3>投資・消費・浪費</h3>${donut(nItems)}${legend(nItems, nTotal, true)}`;
  // 1. 支出の内訳
  const items = topItems(groupSum(exp, t => t.category));
  const total = items.reduce((s, x) => s + x.value, 0);
  html += `<h3>支出の内訳</h3>${total ? donut(items) + legend(items, total, true) : `<ul class="list">${EMPTY}</ul>`}`;
  // 2. 純資産の推移（期間内、今日まで）
  const first = state.txs.reduce((m, t) => (t.date < m ? t.date : m), t0);
  const from = period.from || first, to = [period.to || t0, t0].sort()[0];
  if (from <= to) {
    const netIds = state.accounts.filter(countsInNet).map(a => a.id);
    const { days, values } = dailyTotals(netIds, from, to);
    html += `<h3>純資産の推移</h3>${lineChart([{ color: 'var(--accent)', values }], days.map(mdLabel))}
      <div class="chart-note">${mdLabel(days[0])} ${yen(values[0])} → ${mdLabel(days.at(-1))} ${yen(values.at(-1))}（${values.at(-1) - values[0] >= 0 ? '+' : ''}${yen(values.at(-1) - values[0])}）</div>`;
  }
  // 3. 支出のペース（1か月を選んでいるとき：先月の同じ日と比べる）
  const ym = (period.from || '').slice(0, 7);
  if (period.from && monthRange(ym).from === period.from && monthRange(ym).to === period.to && period.from <= t0) {
    const prev = addMonths(ym + '-01', -1).slice(0, 7);
    const cum = (m, stop) => {
      const len = Number(monthRange(m).to.slice(8, 10));
      const per = Array(len).fill(0);
      for (const t of state.txs) if (t.type === 'expense' && countsInNet(acct(t.from)) && t.date.startsWith(m)) per[Number(t.date.slice(8, 10)) - 1] += t.amount;
      let s = 0;
      return per.map((v, i) => (stop && `${m}-${pad(i + 1)}` > stop ? null : (s += v)));
    };
    const cur = cum(ym, t0), last = cum(prev);
    const n = Math.max(cur.length, last.length);
    const dayIdx = Math.min(cur.filter(v => v != null).length, last.length) - 1;
    html += `<h3>支出のペース</h3>${lineChart([{ color: 'var(--minus)', values: cur }, { color: 'var(--muted)', values: last, dash: true }], Array.from({ length: n }, (_, i) => `${i + 1}日`), { floor0: true })}
      <div class="chart-note"><span class="dot" style="background:var(--minus)"></span>${Number(ym.slice(5))}月　<span class="dot dash"></span>${Number(prev.slice(5))}月${dayIdx >= 0 ? `　同じ日までで ${cur[dayIdx] - last[dayIdx] >= 0 ? '+' : ''}${yen(cur[dayIdx] - last[dayIdx])}` : ''}</div>`;
  }
  // 4. 月ごとの収入と支出（直近6か月）
  const endM = [(period.to || t0), t0].sort()[0].slice(0, 7);
  const groups = Array.from({ length: 6 }, (_, i) => addMonths(endM + '-01', i - 5).slice(0, 7)).map(m => {
    const mt = state.txs.filter(t => t.date.startsWith(m));
    const sum = (type, side) => mt.filter(t => t.type === type && countsInNet(acct(t[side]))).reduce((s, t) => s + t.amount, 0);
    return { label: `${Number(m.slice(5))}月`, inc: sum('income', 'to'), exp: sum('expense', 'from') };
  });
  while (groups.length > 1 && !groups[0].inc && !groups[0].exp) groups.shift(); // 記録を始める前の空の月は出さない
  html += `<h3>月ごとの収入と支出</h3>${barChart(groups)}<div class="chart-note"><span class="dot" style="background:var(--plus)"></span>収入　<span class="dot" style="background:var(--minus)"></span>支出</div>`;
  // 5. 今の資産の構成
  const bal = balances();
  const assets = state.accounts.filter(a => a.kind === 'asset' && !a.parent).map(a => [a.name, familyBalance(a, bal)]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const aItems = topItems(assets, 6), aTotal = aItems.reduce((s, x) => s + x.value, 0);
  if (aTotal) {
    let x = 0;
    const bar = aItems.map((it, i) => { const w = it.value / aTotal * 100; const r = `<rect x="${x}%" y="0" width="${w}%" height="22" fill="${palColor(i)}"/>`; x += w; return r; }).join('');
    html += `<h3>今の資産の構成</h3><svg class="chart hbar" viewBox="0 0 100 22" preserveAspectRatio="none" role="img" aria-label="資産の構成の帯グラフ。下の一覧に口座ごとの金額">${bar}</svg>${legend(aItems, aTotal, false)}`;
  }
  $('#hist-chart').innerHTML = html;
}

// ---------- 画面: 履歴（集計／グラフ／明細） ----------
const byNewest = (a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt;
function txLine(t, viewId) {
  let meta, sign = 0, unitAcct;
  if (t.type === 'expense') { meta = acctName(t.from); sign = -1; unitAcct = acct(t.from); }
  else if (t.type === 'income') { meta = acctName(t.to); sign = 1; unitAcct = acct(t.to); }
  else if (t.type === 'transfer') {
    meta = `${acctName(t.from)} → ${acctName(t.to)}`; unitAcct = acct(t.from);
    if (viewId) sign = t.from === viewId ? -1 : 1;
  } else { meta = acctName(t.to); sign = Math.sign(t.amount); unitAcct = acct(t.to); }
  if (t.type === 'expense' && countsInNet(acct(t.from))) meta += ' ・ ' + NATURE_LABEL[txNature(t)];
  if (t.memo) meta += ' ・ ' + t.memo;
  if (t.auto) meta += ' ・ 自動';
  return `<li data-id="${esc(t.id)}"><div class="main">${esc(t.category)}<div class="meta">${esc(meta)}</div></div>
    <span class="num ${sign < 0 ? 'minus' : sign > 0 ? 'plus' : ''}">${sign > 0 ? '+' : sign < 0 ? '−' : ''}${fmt(Math.abs(t.amount), unitAcct)}</span></li>`;
}
function periodLabel() {
  const { from, to } = period;
  if (!from && !to) return '全期間';
  if (from && to && from.endsWith('-01') && monthRange(from.slice(0, 7)).to === to) return `${from.slice(0, 4)}年${Number(from.slice(5, 7))}月`;
  return `${from ? shortDate(from) : ''} 〜 ${to ? shortDate(to) : ''}`;
}
function periodTxs() {
  const f = $('#hist-filter').value;
  return state.txs.filter(t => (!period.from || t.date >= period.from) && (!period.to || t.date <= period.to) && (!f || t.from === f || t.to === f));
}
function renderHistory() {
  const sel = $('#hist-filter');
  const cur = sel.value;
  sel.innerHTML = '<option value="">すべての項目</option>' + state.accounts.map(a => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
  sel.value = cur;
  $('#period-label').textContent = periodLabel();
  document.querySelectorAll('#period-mode button').forEach(b => { b.classList.toggle('on', b.dataset.mode === periodMode); b.setAttribute('aria-pressed', b.dataset.mode === periodMode); });
  $('#pm-month').hidden = periodMode !== 'month';
  $('#pm-range').hidden = periodMode !== 'range';
  if (periodMode === 'range') {
    const opts = monthOptions();
    for (const [id, v] of [['#r-from', period.from.slice(0, 7)], ['#r-to', period.to.slice(0, 7)]]) {
      $(id).innerHTML = opts.map(m => `<option value="${m}">${m.slice(0, 4)}年${Number(m.slice(5))}月</option>`).join('');
      $(id).value = v;
    }
  }
  document.querySelectorAll('#view-seg button').forEach(b => { b.classList.toggle('on', b.dataset.view === histView); b.setAttribute('aria-pressed', b.dataset.view === histView); });
  $('#hist-summary').hidden = histView !== 'summary';
  $('#hist-list').hidden = histView !== 'list';
  $('#hist-chart').hidden = histView !== 'chart';
  const txs = periodTxs();
  renderSummary(txs);
  if (histView === 'chart') renderCharts(txs);
  // 明細
  const chipLabel = [histCat, histNature && NATURE_LABEL[histNature]].filter(Boolean).join('・');
  $('#hist-chip').innerHTML = chipLabel ? `<button type="button" id="clear-cat" aria-label="絞り込みを外す">${esc(chipLabel)} ✕</button>` : '';
  let html = '', day = '';
  for (const t of txs.filter(t => (!histCat || t.category === histCat) && (!histNature || (t.type === 'expense' && txNature(t) === histNature))).sort(byNewest)) {
    if (t.date !== day) { day = t.date; html += `<li class="day">${shortDate(day)}</li>`; }
    html += txLine(t, sel.value);
  }
  $('#history').innerHTML = html || '<li class="day">該当する記録はありません</li>';
}
function renderSummary(txs) {
  const sum = list => list.reduce((a, t) => a + t.amount, 0);
  // 純資産に入る項目（資産・カード・負債）の出入りだけを数える
  const exp = txs.filter(t => t.type === 'expense' && countsInNet(acct(t.from)));
  const inc = txs.filter(t => t.type === 'income' && countsInNet(acct(t.to)));
  const adj = sum(txs.filter(t => t.type === 'adjust' && countsInNet(acct(t.to))));
  const balance = sum(inc) - sum(exp);
  const byCat = groupSum(exp, t => t.category);
  const max = byCat[0]?.[1] || 1;
  const others = txs.filter(t => (t.type === 'expense' || t.type === 'income') && !countsInNet(acct(t.from || t.to)));
  $('#hist-summary').innerHTML = `
    <ul class="list">
      ${row('収入', yen(sum(inc)), 'plus')}
      ${row('支出', yen(sum(exp)), 'minus')}
      ${row('<strong>収支</strong>', (balance > 0 ? '+' : '') + yen(balance), balance < 0 ? 'minus' : 'plus')}
      ${adj ? row('残高調整', yen(adj)) : ''}
    </ul>
    <h3>投資・消費・浪費</h3>
    <ul class="list">${natureRows(exp)}</ul>
    <h3>支出の内訳</h3>
    <ul class="list">${byCat.map(([k, v]) => `<li data-cat="${esc(k)}"><div class="main">${esc(k)}<div class="bar" style="width:${Math.round(v / max * 100)}%"></div></div><span class="num">${yen(v)}</span></li>`).join('') || EMPTY}</ul>
    <h3>収入の内訳</h3>
    <ul class="list">${sumList(groupSum(inc, t => t.category), null, 'plus')}</ul>
    <h3>支払い元</h3>
    <ul class="list">${groupSum(exp, t => acctName(t.from)).map(([k, v]) => row(esc(k), yen(v))).join('') || EMPTY}</ul>
    ${others.length ? `<h3>預かり・持ち物</h3><ul class="list">${others.sort(byNewest).map(t => txLine(t)).join('')}</ul>` : ''}`;
}
function natureRows(exp) {
  const total = exp.reduce((s, t) => s + t.amount, 0) || 1;
  return NATURES.map(([k, label]) => {
    const v = exp.filter(t => txNature(t) === k).reduce((s, t) => s + t.amount, 0);
    return `<li data-nature="${k}"><div class="main">${label} <span class="meta-inline">${Math.round(v / total * 100)}%</span><div class="bar" style="width:${Math.round(v / total * 100)}%;background:${NATURE_COLOR[k]}"></div></div><span class="num">${yen(v)}</span></li>`;
  }).join('');
}
// 選べる月：記録のある最初の月（なければ1年前）〜今月
function monthOptions() {
  const t0 = today().slice(0, 7);
  const first = state.txs.reduce((m, t) => (t.date.slice(0, 7) < m ? t.date.slice(0, 7) : m), addMonths(t0 + '-01', -11).slice(0, 7));
  const list = [];
  for (let m = first; m <= t0; m = addMonths(m + '-01', 1).slice(0, 7)) list.push(m);
  return list;
}
function setPeriodMode(mode) {
  const base = (period.from || today()).slice(0, 7);
  periodMode = mode;
  if (mode === 'all') period = { from: '', to: '' };
  else if (mode === 'month') period = monthRange(base);
  else { // 最初は「見ていた月までの3か月」
    const end = [(period.to || today()).slice(0, 7), today().slice(0, 7)].sort()[0];
    const start = [addMonths(end + '-01', -2).slice(0, 7), monthOptions()[0]].sort()[1];
    period = { from: monthRange(start).from, to: monthRange(end).to };
  }
  renderHistory();
}
// 期間：始まりと終わりの月。逆に選んだら入れ替える
function setRange() {
  let a = $('#r-from').value, z = $('#r-to').value;
  if (a > z) [a, z] = [z, a];
  period = { from: monthRange(a).from, to: monthRange(z).to };
  renderHistory();
}
function shiftPeriod(d) {
  const base = (period.from || period.to || today()).slice(0, 7);
  period = monthRange(addMonths(base + '-01', d).slice(0, 7));
  renderHistory();
}
function showCategory(e) {
  const li = e.target.closest('li[data-cat], li[data-nature]');
  if (!li) return;
  histCat = li.dataset.cat || ''; histNature = li.dataset.nature || ''; histView = 'list';
  renderHistory();
}

// ---------- 画面: 設定 ----------
function lineRow(l) {
  return `<div class="line"><input name="l-amount" inputmode="numeric" placeholder="金額" aria-label="金額" value="${withCommas(l.amount)}"><input name="l-note" placeholder="メモ" aria-label="メモ" value="${esc(l.note || '')}"><input name="l-due" type="date" class="only-card" aria-label="支払日" value="${esc(l.due || '')}"></div>`;
}
function summaryHtml(a) {
  return `${esc(a.name || '新しい項目')} <span class="meta">${KINDS[a.kind]}${a.hidden ? '・非表示' : ''}</span>`;
}
function acctEditor(a, open) {
  const lines = (a.initial.length ? a.initial : [{}]).map(lineRow).join('');
  const payOpts = state.accounts.filter(x => x.kind === 'asset').map(x => `<option value="${esc(x.id)}"${x.id === a.payFrom ? ' selected' : ''}>${esc(x.name)}</option>`).join('');
  const dayOpts = (cur, withEnd) => (withEnd ? [[0, '月末']] : []).concat(Array.from({ length: 31 }, (_, i) => [i + 1, `${i + 1}日`])).map(([v, l]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${l}</option>`).join('');
  return `<details class="acct kind-${a.kind}" data-id="${esc(a.id)}"${open ? ' open' : ''}>
    <summary>${summaryHtml(a)}</summary>
    <div class="field">初期残高</div>
    <div class="line head"><span><span class="not-card">金額</span><span class="only-card">未払い額</span></span><span>メモ</span><span class="only-card">支払日</span></div>
    <div class="lines">${lines}</div>
    <button type="button" class="add-line">＋ 行</button>
    <label class="field">名前<input name="name" value="${esc(a.name)}"></label>
    <label class="field">種類<select name="kind">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}"${k === a.kind ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
    <label class="field">親項目<select name="parent"><option value="">—</option>${state.accounts.filter(x => x.id !== a.id && !x.parent).map(x => `<option value="${esc(x.id)}"${x.id === a.parent ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
    <label class="field only-item">単位<input name="unit" value="${esc(isItem(a) ? a.unit : '枚')}"></label>
    <div class="only-card">
      <label class="field">利用枠<input name="limit" inputmode="numeric" value="${a.limit ? withCommas(a.limit) : ''}"></label>
      <div class="row"><label class="field">締め日<select name="closingDay">${dayOpts(a.closingDay, true)}</select></label><label class="field">支払日<select name="payDay">${dayOpts(a.payDay, false)}</select></label></div>
      <label class="field">引き落とし口座<select name="payFrom"><option value="">—</option>${payOpts}</select></label>
    </div>
    <label class="field">メモ<input name="memo" value="${esc(a.memo)}"></label>
    <label class="check"><input type="checkbox" name="hidden"${a.hidden ? ' checked' : ''}> 非表示</label>
    <div class="row"><button type="button" class="save-acct primary-sm">保存</button><button type="button" class="del-acct danger">削除</button></div>
  </details>`;
}
function renderSettings() {
  $('#setup-msg').hidden = state.setupDone;
  renderColorSeg();
  $('#acct-edit').innerHTML = state.accounts.map(a => acctEditor(a, false)).join('');
  $('#cat-expense').value = state.categories.expense.join(', ');
  $('#cat-income').value = state.categories.income.join(', ');
}
// 1項目ぶんの入力を読み取る。おかしければ文字列（エラー文）を返す
function readEditor(d) {
  const v = n => d.querySelector(`[name=${n}]`);
  const name = v('name').value.trim();
  if (!name) return '名前が空の項目があります';
  const kind = v('kind').value;
  const parent = v('parent').value;
  if (parent) {
    if (acct(parent) && acct(parent).kind !== kind && !(kind === 'held' && acct(parent).kind === 'asset')) return `${name}：親項目と種類をそろえてください（預かりは資産の中に入れられます）`;
    if (childrenOf(d.dataset.id).length) return `${name}：子項目がある項目は親項目を持てません`;
  }
  const initial = [];
  for (const r of d.querySelectorAll('.lines .line')) {
    const raw = r.querySelector('[name=l-amount]').value.trim();
    if (!raw) continue;
    const amount = parseAmount(raw);
    if (Number.isNaN(amount)) return `${name} の金額が数字ではありません`;
    const due = kind === 'card' ? r.querySelector('[name=l-due]').value : '';
    if (kind === 'card' && !due) return `${name}：支払日を入力`;
    initial.push({ amount, note: r.querySelector('[name=l-note]').value.trim(), due });
  }
  return normAccount({
    id: d.dataset.id, name, kind, unit: v('unit').value.trim() || '個', memo: v('memo').value.trim(), hidden: v('hidden').checked, initial,
    limit: parseAmount(v('limit').value || '0') || 0, closingDay: Number(v('closingDay').value), payDay: Number(v('payDay').value) || 27, payFrom: v('payFrom').value, parent,
  });
}
// 設定に新しい項目の入力欄を開く。返り値はその項目のid
function openNewAccount() {
  const id = uid();
  $('#acct-edit').insertAdjacentHTML('beforeend', acctEditor(normAccount({ id, name: '', kind: 'asset' }), true));
  const d = $('#acct-edit details:last-child');
  d.scrollIntoView({ block: 'start' });
  d.querySelector('[name=l-amount]').focus();
  return id;
}
// 記録画面の「＋」：新しい項目を作り、保存したら記録画面に戻ってその項目を選ぶ
let pendingAdd = null; // { id, slot: 'from' | 'to' }
function quickAddAccount(slot) {
  showTab('settings');
  pendingAdd = { id: openNewAccount(), slot };
}
function saveOne(d) {
  const a = readEditor(d);
  if (typeof a === 'string') return toast(a);
  const i = state.accounts.findIndex(x => x.id === a.id);
  if (i >= 0) state.accounts[i] = a; else state.accounts.push(a);
  state.setupDone = true;
  save(); renderAll();
  d.querySelector('summary').innerHTML = summaryHtml(a);
  d.open = false;
  $('#setup-msg').hidden = true;
  toast(`${a.name} を保存しました`);
  if (pendingAdd?.id === a.id) {
    form[pendingAdd.slot] = a.id;
    pendingAdd = null;
    showTab('add'); renderForm(); window.scrollTo(0, 0);
  }
}
function settingsClick(e) {
  const d = e.target.closest('details.acct');
  if (!d) return;
  if (e.target.closest('.add-line')) d.querySelector('.lines').insertAdjacentHTML('beforeend', lineRow({}));
  if (e.target.closest('.save-acct')) saveOne(d);
  if (e.target.closest('.del-acct')) {
    const id = d.dataset.id;
    if (state.txs.some(t => t.from === id || t.to === id) || state.plans.some(p => p.account === id)) return toast('記録や予定がある項目は削除できません（非表示にできます）');
    if (!confirm('この項目を削除しますか？')) return;
    state.accounts = state.accounts.filter(a => a.id !== id);
    save(); renderAll(); d.remove(); toast('削除しました');
  }
}
function saveSettings() {
  const accounts = [];
  for (const d of document.querySelectorAll('#acct-edit details.acct')) {
    const a = readEditor(d);
    if (typeof a === 'string') return toast(a);
    accounts.push(a);
  }
  const split = s => s.split(/[,、，]/).map(x => x.trim()).filter(Boolean);
  state.accounts = accounts;
  state.categories = { expense: otherLast(split($('#cat-expense').value)), income: otherLast(split($('#cat-income').value)) };
  state.setupDone = true;
  save(); renderAll(); renderSettings();
  toast('保存しました');
}

// ---------- バックアップ ----------
async function exportData() {
  const name = `okane-${today()}.json`;
  const blob = new Blob([JSON.stringify(state, null, 1)], { type: 'application/json' });
  const file = new File([blob], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
async function importData(e) {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const s = JSON.parse(await f.text());
    if (!Array.isArray(s.accounts) || !Array.isArray(s.txs)) throw new Error('形式が違います');
    if (!confirm(`記録${s.txs.length}件のデータで置き換えますか？`)) return;
    state = migrate(s); save(); renderAll(); renderSettings(); toast('読み込みました');
  } catch (err) { toast('読み込めませんでした: ' + err.message); }
}

// ---------- 数字の欄：打つたびにカンマを付ける ----------
document.addEventListener('input', e => {
  const el = e.target;
  if (el.tagName !== 'INPUT' || el.inputMode !== 'numeric' || e.isComposing) return;
  let before = el.value, caret = el.selectionStart ?? before.length;
  const digits = v => v.replace(/[^\d+]/g, '');
  // カンマだけを消した（数字が変わっていない）ときは、その前の数字を消す
  if (e.inputType === 'deleteContentBackward' && digits(before) === digits(el.dataset.prev || '') && caret > 0) {
    before = before.slice(0, caret - 1) + before.slice(caret);
    caret -= 1;
  }
  const after = withCommas(before);
  el.dataset.prev = after;
  if (after === el.value) return;
  const keep = before.slice(0, caret).replace(/[０-９＋]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/[^\d+]/g, '').length;
  let pos = 0;
  for (let n = 0; pos < after.length && n < keep; pos++) if (/[\d+]/.test(after[pos])) n++;
  el.value = after;
  el.setSelectionRange(pos, pos);
});

// ---------- 入力欄の × ボタン（まとめて消す） ----------
// 文字を打つ欄にカーソルがあって中身があるときだけ、右端に1つの × を重ねて出す
const clr = document.createElement('button');
clr.type = 'button'; clr.id = 'clear-input'; clr.textContent = '×'; clr.hidden = true; clr.setAttribute('aria-label', '消す');
document.body.appendChild(clr);
const isTextInput = el => el?.tagName === 'INPUT' && !['date', 'checkbox', 'file'].includes(el.type);
function placeClear() {
  const el = document.activeElement;
  if (!isTextInput(el) || !el.value || el.closest('[hidden]')) { clr.hidden = true; return; }
  const r = el.getBoundingClientRect();
  clr.style.top = `${r.top + window.scrollY + r.height / 2 - 15}px`;
  clr.style.left = `${r.right + window.scrollX - 34}px`;
  clr.hidden = false;
}
clr.addEventListener('pointerdown', e => e.preventDefault()); // 押してもキーボードを閉じない
clr.addEventListener('click', () => {
  const el = document.activeElement;
  if (!isTextInput(el)) return;
  el.value = '';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.focus();
  placeClear();
});
document.addEventListener('focusin', placeClear);
document.addEventListener('input', placeClear);
document.addEventListener('focusout', () => setTimeout(placeClear, 0));
window.addEventListener('scroll', placeClear, true);
window.addEventListener('resize', placeClear);

// ---------- タップで開く行をキーボードでも操作できるように（WCAG 2.1.1） ----------
const ROW_SEL = 'li[data-id], li[data-plan], li[data-cat], li[data-card], li[data-nature]';
// 押せる行のある一覧は「ただの入れ物」にして、行はボタン・日付などは見出しとして伝える
function markList(ul) {
  if (!ul || !ul.querySelector(':scope > ' + ROW_SEL.split(', ').join(', :scope > '))) return;
  ul.setAttribute('role', 'none');
  for (const li of ul.children) {
    if (li.matches(ROW_SEL)) { li.tabIndex = 0; li.setAttribute('role', 'button'); }
    else if (li.classList.contains('day')) { li.setAttribute('role', 'heading'); li.setAttribute('aria-level', '4'); }
    else li.setAttribute('role', 'none');
  }
}
function markRows(root) {
  if (!root?.querySelectorAll) return;
  if (root.matches('ul')) markList(root);
  root.querySelectorAll('ul').forEach(markList);
}
new MutationObserver(ms => {
  const lists = new Set();
  for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1 && n.isConnected) lists.add(n.tagName === 'LI' ? n.parentNode : n);
  lists.forEach(markRows);
}).observe(document.body, { childList: true, subtree: true });
document.addEventListener('keydown', e => {
  const li = e.target.closest?.(ROW_SEL);
  if (li && e.target === li && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); li.click(); }
});

// ---------- タブと起動 ----------
function showTab(name) {
  if (name !== 'settings') pendingAdd = null;
  currentTab = name;
  document.querySelectorAll('.tab').forEach(s => s.classList.toggle('active', s.id === 'tab-' + name));
  document.querySelectorAll('nav button').forEach(b => { b.classList.toggle('on', b.dataset.tab === name); if (b.dataset.tab === name) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  $('#open-settings').classList.toggle('on', name === 'settings');
  if (name === 'settings') renderSettings();
}
function renderAll() {
  renderHeader(); renderBalances(); renderForm(); renderHistory(); renderPlans();
  if (detailId) renderDetail();
}
function onBtn(handler) {
  return e => { const b = e.target.closest('button'); if (b) handler(b); };
}

document.querySelector('nav').addEventListener('click', onBtn(b => { showTab(b.dataset.tab); window.scrollTo(0, 0); }));
$('#open-settings').addEventListener('click', () => { showTab(currentTab === 'settings' ? 'add' : 'settings'); window.scrollTo(0, 0); });
$('#type-seg').addEventListener('click', onBtn(b => { if (!form.editing) setType(b.dataset.type); }));
$('#from-chips').addEventListener('click', onBtn(b => { if (b.dataset.add) return quickAddAccount('from'); form.from = b.dataset.v; renderForm(); }));
$('#to-chips').addEventListener('click', onBtn(b => { if (b.dataset.add) return quickAddAccount('to'); form.to = b.dataset.v; renderForm(); }));
$('#cat-chips').addEventListener('click', onBtn(b => { if (b.dataset.add) return addCategory(b.dataset.nature); form.category = b.dataset.v; form.nature = null; renderForm(); }));
$('#nature-seg').addEventListener('click', onBtn(b => { form.nature = b.dataset.n === natureOf(form.category) ? null : b.dataset.n; renderForm(); }));
longPressOpens($('#from-chips'), 'accounts');
longPressOpens($('#to-chips'), 'accounts');
longPressOpens($('#cat-chips'), 'cats');
longPressOpens($('#balances'), 'balances', 'li[data-id]');
document.querySelectorAll('.sort-btn').forEach(b => b.addEventListener('click', () => openSorter(b.dataset.sort)));
$('#sorter-done').addEventListener('click', closeSorter);
$('#sorter-list').addEventListener('click', sorterClick);
$('#sorter-list').addEventListener('pointerdown', e => {
  const li = e.target.closest('li[data-sec]');
  // つかめるのは右の「≡」だけ（行のほかの所はスクロールに使う）
  if (!li || sd || sorter?.confirm || !e.target.closest('.handle')) return;
  e.preventDefault();
  const list = $('#sorter-list');
  const items = [...list.querySelectorAll(`li[data-sec="${li.dataset.sec}"]`)]; // 同じ見出しの中だけで動かす
  sd = { li, list, items, sec: Number(li.dataset.sec), from: items.indexOf(li), to: items.indexOf(li), y0: e.clientY, y: e.clientY, s0: list.scrollTop, h: li.offsetHeight };
  li.setPointerCapture(e.pointerId);
  li.classList.add('lifted');
  list.classList.add('sorting');
  sd.raf = requestAnimationFrame(sortTick);
});
$('#sorter-list').addEventListener('pointermove', e => { if (sd) sd.y = e.clientY; });
$('#sorter-list').addEventListener('pointerup', endSort);
$('#sorter-list').addEventListener('pointercancel', endSort);
$('#form').addEventListener('submit', submitForm);
$('#cancel-edit').addEventListener('click', resetForm);
$('#delete-tx').addEventListener('click', deleteEditing);
$('#balances').addEventListener('click', e => { const li = e.target.closest('li[data-id]'); if (li) openDetail(li.dataset.id); });
$('#acct-back').addEventListener('click', () => { detailId = null; showTab('add'); });
$('#acct-detail').addEventListener('click', e => { const li = e.target.closest('#detail-txs li[data-id]'); if (li) startEdit(li.dataset.id); });
$('#history').addEventListener('click', e => { const li = e.target.closest('li[data-id]'); if (li) startEdit(li.dataset.id); });
$('#hist-filter').addEventListener('change', renderHistory);
$('#hist-chip').addEventListener('click', () => { histCat = ''; histNature = ''; renderHistory(); });
$('#prev-period').addEventListener('click', () => shiftPeriod(-1));
$('#next-period').addEventListener('click', () => shiftPeriod(1));
$('#period-mode').addEventListener('click', onBtn(b => setPeriodMode(b.dataset.mode)));
$('#r-from').addEventListener('change', setRange);
$('#r-to').addEventListener('change', setRange);
$('#view-seg').addEventListener('click', onBtn(b => { histView = b.dataset.view; renderHistory(); }));
$('#hist-summary').addEventListener('click', showCategory);
$('#hist-chart').addEventListener('click', showCategory);
$('#plan-form').category.addEventListener('change', e => {
  if (e.target.value !== '__new') return;
  const c = addCategoryName(planType, prompt(planType === 'income' ? '新しい収入源' : '新しい用途'));
  e.target.value = c || (state.categories[planType] || [])[0] || '';
  renderPlans(); renderForm();
  if (c) { e.target.value = c; toast(`「${c}」を追加しました`); }
});
$('#plan-type').addEventListener('click', onBtn(b => { planType = b.dataset.type; $('#plan-form').category.value = ''; if (!planEditing) $('#plan-form').auto.checked = planType === 'expense'; renderPlans(); }));
$('#plan-form').addEventListener('submit', submitPlan);
$('#plan-cancel').addEventListener('click', resetPlanForm);
$('#plan-delete').addEventListener('click', deletePlan);
$('#plans').addEventListener('click', planClick);
$('#fixed').addEventListener('click', planClick);
$('#card-bills').addEventListener('click', e => { const li = e.target.closest('li[data-card]'); if (li) openDetail(li.dataset.card); });
$('#acct-edit').addEventListener('click', settingsClick);
$('#acct-edit').addEventListener('change', e => {
  if (e.target.name === 'kind') e.target.closest('details.acct').className = 'acct kind-' + e.target.value;
});
$('#add-acct').addEventListener('click', () => openNewAccount());
$('#save-settings').addEventListener('click', saveSettings);
$('#export').addEventListener('click', exportData);
$('#color-seg').addEventListener('click', onBtn(b => {
  if (b.dataset.color === 'green') delete prefs.color; else prefs.color = b.dataset.color;
  savePrefs(); applyColor(); renderColorSeg(); renderHistory();
}));
$('#import').addEventListener('change', importData);

applyColor();
$('#date').value = today();
setType('expense');
if (state.notice) { const msg = state.notice; delete state.notice; save(); setTimeout(() => toast(msg), 300); }
runAutoPlans();
renderAll();
markRows(document.body);
if (!state.setupDone) showTab('settings');
refreshFx();
// アプリに戻ってきたら新しい版も確かめる（iPhoneは裏から戻るだけだと版を確かめないため）
document.addEventListener('visibilitychange', () => { if (!document.hidden) { refreshFx(); if (runAutoPlans()) renderAll(); navigator.serviceWorker?.getRegistration().then(r => r?.update()).catch(() => {}); } });
navigator.storage?.persist?.();
let reloadLater = false;
// 入力の途中ではないか（新しい版への読み込み直しで、打ちかけの内容を消さないため）
function isIdle() {
  return !form.editing && !$('#amount').value && !$('#memo').value && $('#sorter').hidden && currentTab !== 'settings' && !$('#plan-form').elements.namedItem('name').value && !$('#plan-form').amount.value;
}
if ('serviceWorker' in navigator) {
  // 新しい版が入ったら1回だけ読み込み直す（初回インストール時は除く）
  const hadController = !!navigator.serviceWorker.controller;
  // ただし入力の途中なら消さないよう、アプリを裏に回した時まで待つ
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!hadController) return; if (isIdle()) location.reload(); else reloadLater = true; });
  document.addEventListener('visibilitychange', () => { if (document.hidden && reloadLater) location.reload(); });
  navigator.serviceWorker.register('sw.js');
}
