'use strict';

/* ---------- helpers ---------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};

const TYPE_LABEL = { expense: '支出', income: '收入', transfer: '转账' };
const DISPLAY_CURS = ['TWD', 'MYR'];
const VIEW_TITLE = { list: '明细', stats: '统计', accounts: '账户', settings: '设置' };

function monthKey(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }
function shiftMonth(key, n) { const [y, m] = key.split('-').map(Number); return monthKey(new Date(y, m - 1 + n, 1)); }
function monthLabel(key) { const [y, m] = key.split('-'); return `${y} 年 ${Number(m)} 月`; }
function toLocalInput(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function dayLabel(d) {
  const today = new Date();
  const yest = new Date(); yest.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return '今天';
  if (d.toDateString() === yest.toDateString()) return '昨天';
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 星期${'日一二三四五六'[d.getDay()]}`;
}
function fmt(n) {
  return (Number(n) || 0).toLocaleString('zh-Hans', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
function curTag(c) { return `<span class="cur">${esc(c)}</span>`; }
function parseAmount(s, allowAny = false) {
  const raw = String(s ?? '').replace(/,/g, '').trim();
  if (raw === '') return null;
  const v = Number(raw);
  if (!isFinite(v)) return null;
  if (!allowAny && v <= 0) return null;
  return Math.round(v * 100) / 100;
}
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

/* ---------- config / client ---------- */
const cfg = window.APP_CONFIG || {};
if (!cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes('xxxx') || !cfg.SUPABASE_KEY || cfg.SUPABASE_KEY.includes('xxxx')) {
  document.body.innerHTML = '<p style="padding:24px;font-family:sans-serif">还没设定：请在 config.js 填入 Supabase 的 URL 和 Publishable key。</p>';
  throw new Error('config.js not filled in');
}
const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY);

const state = {
  user: null,
  accounts: [],
  categories: [],
  txs: [],
  rates: null,
  view: 'list',
  month: monthKey(new Date()),
  scope: 'all',
  displayCur: store.get('displayCur', 'TWD'),
};
const accById = id => state.accounts.find(a => a.id === id);
const catById = id => state.categories.find(c => c.id === id);

/* ---------- exchange rates ---------- */
async function getRates(force = false) {
  const cached = store.get('rates');
  if (!force && cached && Date.now() - cached.t < 12 * 3600e3) return cached.r;
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD');
    const j = await res.json();
    if (j.result === 'success' && j.rates) {
      store.set('rates', { t: Date.now(), r: j.rates });
      return j.rates;
    }
  } catch { /* offline: fall back to cache */ }
  return cached ? cached.r : null;
}
function ratesFor(cur, rates) {
  if (!rates || !rates[cur] || !rates.TWD || !rates.MYR) return { rate_twd: null, rate_myr: null };
  return {
    rate_twd: +(rates.TWD / rates[cur]).toFixed(8),
    rate_myr: +(rates.MYR / rates[cur]).toFixed(8),
  };
}
// amount in fromCur -> toCur, using the rate stored on the record when there is one
function convert(amount, fromCur, toCur, t) {
  if (fromCur === toCur) return Number(amount);
  let r = null;
  if (t) r = toCur === 'TWD' ? t.rate_twd : toCur === 'MYR' ? t.rate_myr : null;
  if (r == null && state.rates && state.rates[fromCur] && state.rates[toCur]) r = state.rates[toCur] / state.rates[fromCur];
  return r == null ? 0 : Number(amount) * Number(r);
}

/* ---------- data ---------- */
async function loadAll() {
  const [a, c] = await Promise.all([
    sb.from('accounts').select('*').order('created_at'),
    sb.from('categories').select('*').order('sort_order'),
  ]);
  if (a.error) throw a.error;
  if (c.error) throw c.error;
  let all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('transactions').select('*')
      .order('occurred_at', { ascending: false }).range(from, from + 999);
    if (error) throw error;
    all = all.concat(data);
    if (data.length < 1000) break;
  }
  state.accounts = a.data;
  state.categories = c.data;
  state.txs = all;
}

// records added by the shortcut have no rates yet: fill them in
async function backfillRates() {
  const missing = state.txs.filter(t => t.rate_twd == null);
  if (!missing.length) return;
  const rates = state.rates || await getRates();
  if (!rates) return;
  let changed = false;
  for (const t of missing) {
    const acc = accById(t.account_id);
    if (!acc) continue;
    const r = ratesFor(acc.currency, rates);
    if (r.rate_twd == null) continue;
    const { error } = await sb.from('transactions').update(r).eq('id', t.id);
    if (!error) { Object.assign(t, r); changed = true; }
  }
  if (changed) render();
}

let reloading = false;
async function reload() {
  if (reloading) return;
  reloading = true;
  $('#refreshBtn').classList.add('spin');
  try {
    await loadAll();
    render();
    backfillRates();
  } catch (e) {
    toast('载入失败：' + (e.message || e));
  } finally {
    reloading = false;
    $('#refreshBtn').classList.remove('spin');
  }
}

function balanceOf(acc) {
  let b = Number(acc.opening_balance || 0);
  for (const t of state.txs) {
    if (t.account_id === acc.id) b += t.type === 'income' ? Number(t.amount) : -Number(t.amount);
    if (t.type === 'transfer' && t.to_account_id === acc.id) b += Number(t.to_amount);
  }
  return b;
}

/* ---------- rendering ---------- */
function render() {
  $$('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.view === state.view));
  $('#fab').classList.toggle('hidden', state.view === 'settings');
  $('#title').textContent = VIEW_TITLE[state.view];
  ({ list: renderList, stats: renderStats, accounts: renderAccounts, settings: renderSettings })[state.view]();
}

function monthNav() {
  return `<div class="month-nav">
    <button class="icon-btn" data-act="prev" aria-label="上个月">‹</button>
    <span>${monthLabel(state.month)}</span>
    <button class="icon-btn" data-act="next" aria-label="下个月">›</button>
  </div>`;
}
function bindMonthNav(root) {
  $('[data-act=prev]', root).onclick = () => { state.month = shiftMonth(state.month, -1); render(); };
  $('[data-act=next]', root).onclick = () => { state.month = shiftMonth(state.month, 1); render(); };
}
function inMonth(t, key = state.month) { return monthKey(new Date(t.occurred_at)) === key; }

function renderList() {
  const main = $('#main');
  const cur = state.displayCur;
  const txs = state.txs.filter(t => inMonth(t));
  let exp = 0, inc = 0;
  for (const t of txs) {
    const acc = accById(t.account_id);
    if (!acc) continue;
    if (t.type === 'expense') exp += convert(t.amount, acc.currency, cur, t);
    if (t.type === 'income') inc += convert(t.amount, acc.currency, cur, t);
  }
  const groups = new Map();
  for (const t of txs) {
    const d = new Date(t.occurred_at);
    const k = d.toDateString();
    if (!groups.has(k)) groups.set(k, { d, items: [] });
    groups.get(k).items.push(t);
  }

  let html = monthNav() + `
    <div class="figure">
      <div class="figure-label">本月支出</div>
      <div class="figure-main"><span class="figure-num">${fmt(Math.round(exp))}</span>${curTag(cur)}</div>
      <div class="figure-sub"><span>收入 <b>${fmt(Math.round(inc))}</b></span><span>${txs.length} 笔记录</span></div>
    </div>`;
  if (!txs.length) html += `<p class="empty">这个月还没有记录，按右下角的 + 记第一笔</p>`;
  for (const { d, items } of groups.values()) {
    html += `<section class="day"><h3>${dayLabel(d)}</h3><ul class="rows">${items.map(txRow).join('')}</ul></section>`;
  }
  main.innerHTML = html;
  bindMonthNav(main);
  $$('.row', main).forEach(li => li.onclick = () => openTxForm(state.txs.find(t => t.id === li.dataset.id)));
}

function txRow(t) {
  const acc = accById(t.account_id);
  const cur = acc?.currency || '';
  const time = new Date(t.occurred_at).toLocaleTimeString('zh-Hans', { hour: '2-digit', minute: '2-digit', hour12: false });
  let title, sub, amt, cls = '';
  if (t.type === 'transfer') {
    const to = accById(t.to_account_id);
    title = '转账';
    sub = `${esc(acc?.name)} 到 ${esc(to?.name)}`;
    cls = 'move';
    amt = `${fmt(t.amount)} ${curTag(cur)}`;
    if (to && to.currency !== cur) amt += `<small>到账 ${fmt(t.to_amount)} ${esc(to.currency)}</small>`;
  } else {
    const c = catById(t.category_id);
    title = esc(c?.name || (t.type === 'expense' ? '未分类' : '收入'));
    sub = esc(acc?.name);
    cls = t.type === 'income' ? 'in' : '';
    amt = `${t.type === 'income' ? '+' : '−'}${fmt(t.amount)} ${curTag(cur)}`;
  }
  const note = t.note ? `<span class="row-note">${esc(t.note)}</span>` : '';
  return `<li class="row" data-id="${t.id}">
    <div class="row-main"><span class="row-title">${title}</span>${note}<span class="row-sub">${sub}　${time}</span></div>
    <div class="row-amt ${cls}">${amt}</div>
  </li>`;
}

function renderStats() {
  const main = $('#main');
  if (state.scope !== 'all' && !accById(state.scope)) state.scope = 'all';
  const scopeAcc = state.scope === 'all' ? null : accById(state.scope);
  const cur = scopeAcc ? scopeAcc.currency : state.displayCur;
  const inScope = t => !scopeAcc || t.account_id === scopeAcc.id;
  const val = t => { const a = accById(t.account_id); return a ? convert(t.amount, a.currency, cur, t) : 0; };

  const monthTx = state.txs.filter(t => inMonth(t) && inScope(t));
  const exp = monthTx.filter(t => t.type === 'expense');
  const expTotal = exp.reduce((s, t) => s + val(t), 0);
  const incTotal = monthTx.filter(t => t.type === 'income').reduce((s, t) => s + val(t), 0);

  const byCat = new Map();
  for (const t of exp) { const k = t.category_id || 'none'; byCat.set(k, (byCat.get(k) || 0) + val(t)); }
  const cats = [...byCat.entries()].sort((a, b) => b[1] - a[1]);

  const trend = [];
  for (let i = 5; i >= 0; i--) {
    const k = shiftMonth(state.month, -i);
    trend.push([k, state.txs.filter(t => t.type === 'expense' && inScope(t) && inMonth(t, k)).reduce((s, t) => s + val(t), 0)]);
  }
  const maxT = Math.max(1, ...trend.map(x => x[1]));

  const scopeOpts = `<option value="all">全部账户</option>` + state.accounts.map(a =>
    `<option value="${a.id}" ${a.id === state.scope ? 'selected' : ''}>${esc(a.name)}（${esc(a.currency)}）</option>`).join('');
  const curSeg = scopeAcc ? '' : `<div class="seg small" id="curSeg">${DISPLAY_CURS.map(c =>
    `<button data-cur="${c}" class="${c === cur ? 'on' : ''}">${c}</button>`).join('')}</div>`;

  main.innerHTML = `
    <div class="controls"><select id="scopeSel" aria-label="统计范围">${scopeOpts}</select>${curSeg}</div>
    ${monthNav()}
    <div class="figure">
      <div class="figure-label">${scopeAcc ? esc(scopeAcc.name) + ' 本月支出' : '本月支出'}</div>
      <div class="figure-main"><span class="figure-num">${fmt(Math.round(expTotal))}</span>${curTag(cur)}</div>
      <div class="figure-sub"><span>收入 <b>${fmt(Math.round(incTotal))}</b></span><span>结余 <b>${fmt(Math.round(incTotal - expTotal))}</b></span></div>
    </div>
    <section class="panel"><h3>分类</h3>
      ${cats.length ? cats.map(([k, v]) => {
        const name = k === 'none' ? '未分类' : esc(catById(k)?.name || '已删除的分类');
        const pct = expTotal ? v / expTotal * 100 : 0;
        return `<div class="bar-row"><div class="bar-label"><span>${name}</span><span>${fmt(Math.round(v))}　${pct.toFixed(0)}%</span></div><div class="bar"><i style="width:${pct}%"></i></div></div>`;
      }).join('') : '<p class="hint">这个月没有支出</p>'}
    </section>
    <section class="panel"><h3>近 6 个月支出</h3>
      <div class="trend">${trend.map(([k, v]) => `
        <div class="trend-col ${k === state.month ? 'on' : ''}">
          <span class="trend-val">${v ? fmt(Math.round(v)) : ''}</span>
          <div class="trend-bar"><i style="height:${v / maxT * 100}%"></i></div>
          <small>${Number(k.split('-')[1])} 月</small>
        </div>`).join('')}
      </div>
    </section>`;
  bindMonthNav(main);
  $('#scopeSel').onchange = e => { state.scope = e.target.value; render(); };
  $$('#curSeg button').forEach(b => b.onclick = () => setDisplayCur(b.dataset.cur));
}

function setDisplayCur(c) {
  state.displayCur = c;
  store.set('displayCur', c);
  render();
}

function renderAccounts() {
  const main = $('#main');
  const cur = state.displayCur;
  const active = state.accounts.filter(a => !a.archived);
  const archived = state.accounts.filter(a => a.archived);
  const total = active.reduce((s, a) => s + convert(balanceOf(a), a.currency, cur, null), 0);
  const row = a => `<li class="row" data-id="${a.id}">
      <div class="row-main"><span class="row-title">${esc(a.name)}</span><span class="row-sub">${a.archived ? '已封存' : ''}</span></div>
      <div class="row-amt">${fmt(balanceOf(a))} ${curTag(a.currency)}</div>
    </li>`;
  main.innerHTML = `
    <div class="figure">
      <div class="figure-label">总余额（按目前汇率换算）</div>
      <div class="figure-main"><span class="figure-num">${fmt(Math.round(total))}</span>${curTag(cur)}</div>
    </div>
    ${active.length ? `<ul class="rows">${active.map(row).join('')}</ul>` : '<p class="empty">还没有账户</p>'}
    ${archived.length ? `<h3 class="section-title">已封存</h3><ul class="rows">${archived.map(row).join('')}</ul>` : ''}
    <p class="hint" style="margin:12px 4px">余额 = 初始余额 + 收入 − 支出 ± 转账。点账户可以设定初始余额。</p>
    <button class="btn ghost wide" id="addAcc">新增账户</button>`;
  $$('.row', main).forEach(li => li.onclick = () => openAccountForm(accById(li.dataset.id)));
  $('#addAcc').onclick = () => openAccountForm(null);
}

function renderSettings() {
  const main = $('#main');
  const catList = kind => state.categories.filter(c => c.kind === kind).map(c => `
    <li data-id="${c.id}"><span>${esc(c.name)}</span>
      <span><button class="link" data-act="rename">改名</button><button class="link danger" data-act="del">删除</button></span>
    </li>`).join('');
  const r = store.get('rates');
  const rateInfo = r ? `汇率更新于 ${new Date(r.t).toLocaleString('zh-Hans', { hour12: false })}` : '还没取得汇率';
  main.innerHTML = `
    <section class="panel"><h3>显示货币</h3>
      <div class="seg small" id="curSeg">${DISPLAY_CURS.map(c => `<button data-cur="${c}" class="${c === state.displayCur ? 'on' : ''}">${c}</button>`).join('')}</div>
      <p class="hint">跨账户的总额会换算成这个货币，用的是每笔记录当天的汇率。</p>
    </section>
    <section class="panel"><h3>支出分类</h3><ul class="cat-list">${catList('expense')}</ul>
      <button class="btn ghost wide" data-add="expense">新增支出分类</button>
      <p class="hint">快捷指令里的分类名称要和这里一字不差。</p>
    </section>
    <section class="panel"><h3>收入分类</h3><ul class="cat-list">${catList('income')}</ul>
      <button class="btn ghost wide" data-add="income">新增收入分类</button>
    </section>
    <section class="panel"><h3>资料</h3>
      <button class="btn wide" id="exportBtn">导出 CSV</button>
      <button class="btn wide" id="ratesBtn" style="margin-top:10px">立即更新汇率</button>
      <p class="hint">${rateInfo}（来源 open.er-api.com）</p>
    </section>
    <section class="panel"><h3>账号</h3>
      <p class="hint" style="margin:0 0 12px">${esc(state.user?.email)}</p>
      <button class="btn danger wide" id="logoutBtn">登出</button>
    </section>`;

  $$('#curSeg button').forEach(b => b.onclick = () => setDisplayCur(b.dataset.cur));
  $$('[data-add]', main).forEach(b => b.onclick = () => addCategory(b.dataset.add));
  $$('.cat-list li', main).forEach(li => {
    const c = catById(li.dataset.id);
    $('[data-act=rename]', li).onclick = () => renameCategory(c);
    $('[data-act=del]', li).onclick = () => deleteCategory(c);
  });
  $('#exportBtn').onclick = exportCsv;
  $('#ratesBtn').onclick = async () => { state.rates = await getRates(true); toast(state.rates ? '汇率已更新' : '取得汇率失败，请检查网络'); render(); };
  $('#logoutBtn').onclick = async () => { if (confirm('确定登出？')) await sb.auth.signOut(); };
}

/* ---------- categories ---------- */
async function addCategory(kind) {
  const name = (prompt(kind === 'expense' ? '新的支出分类名称' : '新的收入分类名称') || '').trim();
  if (!name) return;
  const max = Math.max(0, ...state.categories.filter(c => c.kind === kind).map(c => c.sort_order || 0));
  const { error } = await sb.from('categories').insert({ name, kind, sort_order: max + 1 });
  if (error) return toast(error.message);
  await reload();
  toast('已新增');
}
async function renameCategory(c) {
  const name = (prompt('新名称', c.name) || '').trim();
  if (!name || name === c.name) return;
  const { error } = await sb.from('categories').update({ name }).eq('id', c.id);
  if (error) return toast(error.message);
  await reload();
  toast('已改名，记得同步修改快捷指令');
}
async function deleteCategory(c) {
  if (!confirm(`删除分类「${c.name}」？用过它的记录会变成未分类。`)) return;
  const { error } = await sb.from('categories').delete().eq('id', c.id);
  if (error) return toast(error.message);
  await reload();
  toast('已删除');
}

/* ---------- bottom sheet ---------- */
function openSheet(html) {
  $('#sheetPanel').innerHTML = html;
  const s = $('#sheet');
  s.classList.remove('hidden');
  requestAnimationFrame(() => s.classList.add('open'));
}
function closeSheet() {
  const s = $('#sheet');
  s.classList.remove('open');
  setTimeout(() => s.classList.add('hidden'), 220);
}

/* ---------- transaction form ---------- */
function openTxForm(tx) {
  const usable = state.accounts.filter(a => !a.archived || (tx && (a.id === tx.account_id || a.id === tx.to_account_id)));
  if (!usable.length) { toast('先到「账户」新增一个账户'); state.view = 'accounts'; render(); return; }

  let type = tx?.type || store.get('lastType', 'expense');
  const lastAcc = store.get('lastAcc');
  const defAcc = tx?.account_id || usable.find(a => a.id === lastAcc)?.id || usable[0].id;
  const defTo = tx?.to_account_id || usable.find(a => a.id !== defAcc)?.id || defAcc;
  const accOpts = sel => usable.map(a => `<option value="${a.id}" ${a.id === sel ? 'selected' : ''}>${esc(a.name)}（${esc(a.currency)}）</option>`).join('');
  const when = tx ? new Date(tx.occurred_at) : new Date();

  openSheet(`
    <h2>${tx ? '编辑记录' : '记一笔'}</h2>
    <div class="seg" id="typeSeg">${['expense', 'income', 'transfer'].map(k => `<button data-type="${k}">${TYPE_LABEL[k]}</button>`).join('')}</div>
    <label><span id="amtLabel">金额</span><input id="f_amt" class="amount-input" inputmode="decimal" placeholder="0" autocomplete="off" value="${tx ? tx.amount : ''}"></label>
    <label><span id="accLabel">账户</span><select id="f_acc">${accOpts(defAcc)}</select></label>
    <div id="catWrap"><label>分类<select id="f_cat"></select></label></div>
    <div id="xferWrap">
      <label>转入账户<select id="f_to">${accOpts(defTo)}</select></label>
      <label><span id="toAmtLabel">到账金额</span><input id="f_toamt" inputmode="decimal" autocomplete="off" value="${tx?.to_amount ?? ''}"></label>
      ${tx ? '' : '<label>手续费（选填，会另外记成一笔支出）<input id="f_fee" inputmode="decimal" placeholder="0" autocomplete="off"></label>'}
    </div>
    <label>时间<input id="f_when" type="datetime-local" value="${toLocalInput(when)}"></label>
    <label>备注<input id="f_note" autocomplete="off" value="${esc(tx?.note || '')}"></label>
    <div class="actions">
      ${tx ? '<button class="btn danger" id="f_del">删除</button>' : '<button class="btn" id="f_cancel">取消</button>'}
      <button class="btn primary" id="f_save">保存</button>
    </div>`);

  const curOf = id => accById(id)?.currency || '';
  const autoToAmt = () => {
    if (type !== 'transfer') return;
    const same = curOf($('#f_acc').value) === curOf($('#f_to').value);
    $('#f_toamt').readOnly = same;
    if (same) $('#f_toamt').value = $('#f_amt').value;
  };
  const sync = () => {
    $$('#typeSeg button').forEach(b => b.classList.toggle('on', b.dataset.type === type));
    const isX = type === 'transfer';
    $('#catWrap').classList.toggle('hidden', isX);
    $('#xferWrap').classList.toggle('hidden', !isX);
    $('#accLabel').textContent = isX ? '转出账户' : '账户';
    $('#amtLabel').textContent = `${isX ? '转出金额' : '金额'}（${curOf($('#f_acc').value)}）`;
    $('#toAmtLabel').textContent = `到账金额（${curOf($('#f_to').value)}）`;
    const kind = type === 'income' ? 'income' : 'expense';
    const sel = $('#f_cat');
    const prev = sel.value || tx?.category_id || '';
    sel.innerHTML = '<option value="">未分类</option>' + state.categories.filter(c => c.kind === kind)
      .map(c => `<option value="${c.id}" ${c.id === prev ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
    autoToAmt();
  };

  $$('#typeSeg button').forEach(b => b.onclick = () => { type = b.dataset.type; sync(); });
  $('#f_acc').onchange = sync;
  $('#f_to').onchange = sync;
  $('#f_amt').oninput = autoToAmt;
  if ($('#f_cancel')) $('#f_cancel').onclick = closeSheet;
  sync();
  if (!tx) $('#f_amt').focus();

  $('#f_save').onclick = async () => {
    const amount = parseAmount($('#f_amt').value);
    if (amount == null) return toast('请输入大于 0 的金额');
    const whenVal = $('#f_when').value;
    if (!whenVal) return toast('请选择时间');
    const account_id = $('#f_acc').value;
    const acc = accById(account_id);
    const row = {
      type, account_id, amount,
      occurred_at: new Date(whenVal).toISOString(),
      note: $('#f_note').value.trim() || null,
      category_id: null, to_account_id: null, to_amount: null,
    };
    if (type === 'transfer') {
      row.to_account_id = $('#f_to').value;
      if (row.to_account_id === account_id) return toast('转出和转入不能是同一个账户');
      row.to_amount = parseAmount($('#f_toamt').value);
      if (row.to_amount == null) return toast('请输入到账金额');
    } else {
      row.category_id = $('#f_cat').value || null;
    }
    const sameCurAsBefore = tx && curOf(tx.account_id) === acc.currency && tx.rate_twd != null;
    if (!sameCurAsBefore) {
      state.rates = state.rates || await getRates();
      Object.assign(row, ratesFor(acc.currency, state.rates));
    }

    const btn = $('#f_save');
    btn.disabled = true;
    const { error } = tx
      ? await sb.from('transactions').update(row).eq('id', tx.id)
      : await sb.from('transactions').insert(row);
    if (error) { btn.disabled = false; return toast(error.message); }

    if (!tx && type === 'transfer') {
      const fee = parseAmount($('#f_fee').value);
      if (fee) {
        const r = await sb.from('transactions').insert({
          type: 'expense', account_id, amount: fee, occurred_at: row.occurred_at,
          note: '转账手续费', ...ratesFor(acc.currency, state.rates),
        });
        if (r.error) toast('手续费没有记成功：' + r.error.message);
      }
    }
    store.set('lastAcc', account_id);
    if (type !== 'transfer') store.set('lastType', type);
    closeSheet();
    await reload();
    toast('已保存');
  };

  if ($('#f_del')) $('#f_del').onclick = async () => {
    if (!confirm('删除这笔记录？')) return;
    const { error } = await sb.from('transactions').delete().eq('id', tx.id);
    if (error) return toast(error.message);
    closeSheet();
    await reload();
    toast('已删除');
  };
}

/* ---------- account form ---------- */
function openAccountForm(acc) {
  const hasTx = acc && state.txs.some(t => t.account_id === acc.id || t.to_account_id === acc.id);
  openSheet(`
    <h2>${acc ? '编辑账户' : '新增账户'}</h2>
    <label>名称<input id="f_name" autocomplete="off" value="${esc(acc?.name || '')}" placeholder="例如：台湾银行"></label>
    <label>货币（3 个英文字母）<input id="f_cur" autocomplete="off" maxlength="3" value="${esc(acc?.currency || 'TWD')}" ${hasTx ? 'disabled' : ''}></label>
    ${hasTx ? '<p class="hint">这个账户已有记录，不能再改货币。</p>' : ''}
    <label>初始余额<input id="f_open" inputmode="decimal" autocomplete="off" value="${acc?.opening_balance ?? 0}"></label>
    ${acc ? `<label class="check"><input type="checkbox" id="f_arch" ${acc.archived ? 'checked' : ''}>封存（记账时不再出现）</label>` : ''}
    <div class="actions">
      ${acc && !hasTx ? '<button class="btn danger" id="f_del">删除</button>' : '<button class="btn" id="f_cancel">取消</button>'}
      <button class="btn primary" id="f_save">保存</button>
    </div>`);
  if ($('#f_cancel')) $('#f_cancel').onclick = closeSheet;

  $('#f_save').onclick = async () => {
    const name = $('#f_name').value.trim();
    const currency = $('#f_cur').value.trim().toUpperCase();
    const opening = parseAmount($('#f_open').value || '0', true);
    if (!name) return toast('请填账户名称');
    if (!/^[A-Z]{3}$/.test(currency)) return toast('货币要是 3 个英文字母，例如 TWD');
    if (opening == null) return toast('初始余额的格式不对');
    const row = { name, opening_balance: opening };
    if (!hasTx) row.currency = currency;
    if (acc) row.archived = $('#f_arch').checked;
    const { error } = acc
      ? await sb.from('accounts').update(row).eq('id', acc.id)
      : await sb.from('accounts').insert(row);
    if (error) return toast(error.message);
    closeSheet();
    await reload();
    toast('已保存');
  };
  if ($('#f_del')) $('#f_del').onclick = async () => {
    if (!confirm(`删除账户「${acc.name}」？`)) return;
    const { error } = await sb.from('accounts').delete().eq('id', acc.id);
    if (error) return toast(error.message);
    closeSheet();
    await reload();
    toast('已删除');
  };
}

/* ---------- CSV export ---------- */
async function exportCsv() {
  const rows = [['日期', '类型', '账户', '货币', '金额', '分类', '转入账户', '转入货币', '到账金额', '备注']];
  for (const t of [...state.txs].reverse()) {
    const a = accById(t.account_id), to = accById(t.to_account_id), c = catById(t.category_id);
    rows.push([
      toLocalInput(new Date(t.occurred_at)).replace('T', ' '), TYPE_LABEL[t.type],
      a?.name || '', a?.currency || '', t.amount, c?.name || '',
      to?.name || '', to?.currency || '', t.to_amount ?? '', t.note || '',
    ]);
  }
  const csv = '\ufeff' + rows.map(r => r.map(v => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n');
  const name = `记账-${toLocalInput(new Date()).slice(0, 10)}.csv`;
  const file = new File([csv], name, { type: 'text/csv' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- auth & start ---------- */
function showLogin() {
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
}
async function showApp() {
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  render();
  state.rates = await getRates();
  await reload();
}

$('#loginForm').onsubmit = async e => {
  e.preventDefault();
  $('#loginErr').textContent = '';
  const { data, error } = await sb.auth.signInWithPassword({
    email: $('#email').value.trim(),
    password: $('#password').value,
  });
  if (error) { $('#loginErr').textContent = 'Email 或密码不对'; return; }
  state.user = data.user;
  showApp();
};

$$('.tabbar button').forEach(b => b.onclick = () => { state.view = b.dataset.view; render(); window.scrollTo(0, 0); });
$('#fab').onclick = () => openTxForm(null);
$('#refreshBtn').onclick = reload;
$('.sheet-backdrop').onclick = closeSheet;

// coming back from the shortcut: refresh so the new record shows up
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.user) reload();
});

(async function start() {
  const { data: { session } } = await sb.auth.getSession();
  sb.auth.onAuthStateChange((event, s) => {
    if (event === 'SIGNED_OUT') { state.user = null; showLogin(); }
    else if (s) state.user = s.user;
  });
  if (session) { state.user = session.user; showApp(); }
  else showLogin();
})();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
