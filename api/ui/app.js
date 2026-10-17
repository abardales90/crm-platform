// CRM web app. No build step. All text from the server goes in with textContent, never as HTML.

const TOKEN_KEY = 'crm_token';
let token = localStorage.getItem(TOKEN_KEY) || '';
let me = null; // { user, permissions }
let signingIn = false; // while true, a 401 means 'bad token', not 'session expired'
const cache = { users: [], stages: [], queues: [], accounts: [], contacts: [] };

// ---------- tiny DOM helper ----------
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  const props = {};
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (['value', 'checked', 'disabled', 'selected'].includes(k)) props[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  Object.assign(e, props);
  return e;
}
const $ = (s, el = document) => el.querySelector(s);

// ---------- api ----------
class ApiErr extends Error {
  constructor(status, error) { super(error?.message || 'Request failed'); this.status = status; this.code = error?.code; this.details = error?.details; }
}
async function api(method, path, body) {
  const res = await fetch('/v1' + path, {
    method,
    headers: { authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { if (!signingIn) signOut(); throw new ApiErr(401, { message: 'Please sign in again' }); }
  if (res.status === 204) return null;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiErr(res.status, json.error);
  return json;
}
async function listAll(path) {
  const out = []; let after = null;
  do {
    const sep = path.includes('?') ? '&' : '?';
    const j = await api('GET', `${path}${sep}limit=200${after ? '&after=' + after : ''}`);
    out.push(...j.data); after = j.next;
  } while (after);
  return out;
}
function errText(e) {
  switch (e.code) {
    case 'duplicate': return 'That value is already used by another record.';
    case 'bad_reference': return 'One of the linked records no longer exists.';
    case 'version_conflict': return 'Someone else changed this record. Reload the page to see their change, then try again.';
    case 'field_forbidden': case 'forbidden': return e.message;
    case 'missing_field': return 'A required field is empty.';
    case 'rule_violation': return 'That change breaks a data rule. Check the values and try again.';
    default: return e.message || 'Something went wrong.';
  }
}

// ---------- formatting ----------
const money = (v) => v == null || v === '' ? '' : new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(v));
const fmtDate = (v) => { if (!v) return ''; const [y, m, d] = String(v).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); };
const fmtDateTime = (v) => v ? new Date(v).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
const toLocalInput = (iso) => { if (!iso) return ''; const d = new Date(iso); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
const fromLocalInput = (v) => v ? new Date(v).toISOString() : null;
function span(ms) {
  const a = Math.abs(ms) / 60000;
  if (a < 60) return `${Math.round(a)}m`;
  if (a < 60 * 48) return `${Math.round(a / 60)}h`;
  return `${Math.round(a / 1440)}d`;
}
function dueBadge(due, done) {
  if (!due) return null;
  if (done) return h('span', { class: 'pill ok' }, 'met');
  const ms = new Date(due) - Date.now();
  if (ms < 0) return h('span', { class: 'pill bad' }, `overdue ${span(ms)}`);
  return h('span', { class: 'pill ' + (ms < 2 * 3600e3 ? 'warn' : 'ok') }, `due in ${span(ms)}`);
}
const can = (perm, action) => !!me?.permissions?.[perm]?.includes(action);
const userName = (id) => cache.users.find((u) => u.id === id)?.display_name || '';
const stageOf = (id) => cache.stages.find((s) => s.id === id);

// ---------- toasts and dialogs ----------
function toast(msg, bad) {
  const t = h('div', { class: 'toast' + (bad ? ' bad' : '') }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), bad ? 6000 : 3000);
}
function modal(title, body, buttons) {
  const banner = h('div', { class: 'banner', hidden: true });
  const dlg = h('dialog', {},
    h('div', { class: 'dh' }, h('h2', {}, title)),
    h('div', { class: 'db' }, banner, body),
    h('div', { class: 'df' }, buttons.map((b) => h('button', {
      class: b.primary ? 'primary' : '', type: 'button',
      onclick: async (ev) => {
        if (!b.run) return dlg.close();
        ev.target.disabled = true; banner.hidden = true;
        try { await b.run(dlg); } catch (e) { banner.textContent = errText(e); banner.hidden = false; }
        ev.target.disabled = false;
      },
    }, b.label))));
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
  return dlg;
}

// ---------- entity definitions ----------
const OPTS = {
  accountType: ['prospect', 'customer', 'partner', 'former customer'],
  dealType: ['new business', 'renewal', 'expansion'],
  forecast: ['pipeline', 'best case', 'commit', 'closed'],
  caseStatus: ['new', 'open', 'pending customer', 'escalated', 'solved', 'closed'],
  priority: ['low', 'normal', 'high', 'urgent'],
  caseType: ['question', 'problem', 'incident', 'request'],
  origin: ['email', 'phone', 'web', 'chat', 'internal'],
  activity: ['task', 'note', 'call', 'meeting', 'email'],
};

const ENT = {
  accounts: {
    path: 'accounts', perm: 'account', label: 'Accounts', one: 'Account', title: (r) => r.name,
    fields: [
      { k: 'name', l: 'Name', req: true, create: true },
      { k: 'domain', l: 'Domain', create: true, hint: 'like acme.com' },
      { k: 'type', l: 'Type', t: 'select', opts: OPTS.accountType, create: true },
      { k: 'industry', l: 'Industry', create: true },
      { k: 'website', l: 'Website' }, { k: 'phone', l: 'Phone' },
      { k: 'number_of_employees', l: 'Employees', t: 'number' },
      { k: 'annual_revenue', l: 'Annual revenue (USD)', t: 'number' },
      { k: 'health_score', l: 'Health score', t: 'number', hint: '0 to 100. At risk below 40' },
      { k: 'renewal_date', l: 'Renewal date', t: 'date' },
      { k: 'owner_user_id', l: 'Owner', t: 'user', create: true },
      { k: 'description', l: 'Notes', t: 'textarea', wide: true },
    ],
    cols: [['name', 'Name'], ['domain', 'Domain'], ['type', 'Type'], ['health_score', 'Health', 'health'], ['renewal_date', 'Renewal', 'date'], ['owner_user_id', 'Owner', 'user']],
  },
  contacts: {
    path: 'contacts', perm: 'contact', label: 'Contacts', one: 'Contact', title: (r) => [r.first_name, r.last_name].filter(Boolean).join(' '),
    fields: [
      { k: 'first_name', l: 'First name', create: true }, { k: 'last_name', l: 'Last name', req: true, create: true },
      { k: 'email', l: 'Email', create: true }, { k: 'phone', l: 'Phone' }, { k: 'mobile', l: 'Mobile' },
      { k: 'title', l: 'Job title', create: true }, { k: 'department', l: 'Department' },
      { k: 'account_id', l: 'Account', t: 'account', create: true },
      { k: 'lead_source', l: 'Lead source' },
      { k: 'owner_user_id', l: 'Owner', t: 'user', create: true },
      { k: 'do_not_contact', l: 'Do not contact', t: 'bool' },
      { k: 'description', l: 'Notes', t: 'textarea', wide: true },
    ],
    cols: [['name', 'Name', 'contactname'], ['email', 'Email'], ['title', 'Title'], ['account_id', 'Account', 'account'], ['owner_user_id', 'Owner', 'user']],
  },
  deals: {
    path: 'opportunities', perm: 'opportunity', label: 'Deals', one: 'Deal', title: (r) => r.name,
    fields: [
      { k: 'name', l: 'Deal name', req: true, create: true },
      { k: 'account_id', l: 'Account', t: 'account', req: true, create: true },
      { k: 'primary_contact_id', l: 'Primary contact', t: 'contact' },
      { k: 'stage_id', l: 'Stage', t: 'stage', req: true, create: true },
      { k: 'amount', l: 'Amount (USD)', t: 'number', create: true },
      { k: 'close_date', l: 'Expected close', t: 'date', req: true, create: true },
      { k: 'probability', l: 'Probability %', t: 'number', hint: 'Moves to the stage default when the stage changes' },
      { k: 'type', l: 'Type', t: 'select', opts: OPTS.dealType },
      { k: 'forecast_category', l: 'Forecast', t: 'select', opts: OPTS.forecast },
      { k: 'next_step', l: 'Next step' }, { k: 'lead_source', l: 'Lead source' },
      { k: 'loss_reason', l: 'Loss reason', hint: 'Required to close a deal as lost' },
      { k: 'owner_user_id', l: 'Owner', t: 'user', create: true },
      { k: 'description', l: 'Notes', t: 'textarea', wide: true },
    ],
  },
  cases: {
    path: 'cases', perm: 'case', label: 'Cases', one: 'Case', title: (r) => `#${r.case_number} ${r.subject}`,
    fields: [
      { k: 'subject', l: 'Subject', req: true, create: true, wide: true },
      { k: 'description', l: 'Description', t: 'textarea', create: true, wide: true },
      { k: 'status', l: 'Status', t: 'select', opts: OPTS.caseStatus, req: true },
      { k: 'priority', l: 'Priority', t: 'select', opts: OPTS.priority, req: true, create: true },
      { k: 'type', l: 'Type', t: 'select', opts: OPTS.caseType, create: true },
      { k: 'origin', l: 'Origin', t: 'select', opts: OPTS.origin },
      { k: 'assignee', l: 'Assigned to', t: 'assignee', req: true, create: true },
      { k: 'account_id', l: 'Account', t: 'account', create: true },
      { k: 'contact_id', l: 'Contact', t: 'contact', create: true },
    ],
    cols: [['case_number', '#'], ['subject', 'Subject'], ['status', 'Status', 'status'], ['priority', 'Priority', 'priority'], ['account_id', 'Account', 'account'], ['resolution_due_at', 'Resolve by', 'sla'], ['assignee', 'Assigned to', 'assignee']],
  },
};

// ---------- form building ----------
function selectOf(options, value, { blank = true } = {}) {
  const s = h('select', {}, blank ? h('option', { value: '' }, '') : null,
    options.map(([v, label]) => h('option', { value: v }, label)));
  s.value = value ?? '';
  // A select with no blank choice must always land on a real option.
  if (!blank && s.selectedIndex < 0 && options.length) s.selectedIndex = 0;
  return s;
}
// Sensible starting values for the New dialogs.
const CREATE_DEFAULTS = { priority: 'normal', status: 'new' };
const optList = (arr) => arr.map((x) => [x, x]);

function control(f, rec) {
  let v = rec ? rec[f.k] : undefined;
  if (!rec) v = f.k === 'owner_user_id' ? me?.user?.id : CREATE_DEFAULTS[f.k];
  let input, get;
  switch (f.t) {
    case 'textarea': input = h('textarea', { value: v ?? '' }); get = () => input.value.trim() || null; break;
    case 'number': input = h('input', { type: 'number', step: 'any', value: v ?? '' }); get = () => input.value === '' ? null : Number(input.value); break;
    case 'date': input = h('input', { type: 'date', value: v ? String(v).slice(0, 10) : '' }); get = () => input.value || null; break;
    case 'bool': input = h('input', { type: 'checkbox', checked: !!v }); get = () => input.checked; break;
    case 'select': input = selectOf(optList(f.opts), v, { blank: !f.req }); get = () => input.value || null; break;
    case 'user': input = selectOf(cache.users.map((u) => [u.id, u.display_name]), v, { blank: !f.req }); get = () => input.value || null; break;
    case 'account': input = selectOf(cache.accounts.map((a) => [a.id, a.name]), v); get = () => input.value || null; break;
    case 'contact': input = selectOf(cache.contacts.map((c) => [c.id, ENT.contacts.title(c)]), v); get = () => input.value || null; break;
    case 'stage': input = selectOf(cache.stages.map((s) => [s.id, s.name]), v, { blank: false }); get = () => input.value || null; break;
    case 'assignee': {
      const opts = [...cache.queues.map((q) => ['q:' + q.id, 'Queue: ' + q.name]), ...cache.users.map((u) => ['u:' + u.id, u.display_name])];
      const cur = rec ? (rec.owner_user_id ? 'u:' + rec.owner_user_id : rec.queue_id ? 'q:' + rec.queue_id : '') : 'q:' + (cache.queues[0]?.id ?? '');
      input = selectOf(opts, cur, { blank: false });
      get = () => { const [k, id] = input.value.split(':'); return k === 'u' ? { owner_user_id: id, queue_id: null } : { owner_user_id: null, queue_id: id }; };
      break;
    }
    default: input = h('input', { type: 'text', value: v ?? '' }); get = () => input.value.trim() || null;
  }
  // Keep values the database insists on in one shape.
  if (f.k === 'domain') { const g = get; get = () => { const x = g(); return x && x.toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split('/')[0]; }; }
  if (f.k === 'email') { const g = get; get = () => g()?.toLowerCase() ?? null; }
  input.dataset.k = f.k;
  const node = h('label', { class: 'f' + (f.wide ? ' wide' : '') }, h('span', {}, f.l, f.req ? h('span', { class: 'req' }, ' *') : null, f.hint ? h('span', { class: 'hint' }, ` (${f.hint})`) : null), input);
  return { node, input, get, f };
}

function makeForm(fields, rec, { disabled } = {}) {
  const ctrls = fields.filter((f) => !rec || f.k in rec || f.k === 'assignee').map((f) => control(f, rec));
  ctrls.forEach((c) => { if (disabled) c.input.disabled = true; });
  const grid = h('div', { class: 'grid2' }, ctrls.map((c) => c.node));
  const norm = (f, x) => x == null || x === '' ? null : f.t === 'number' ? Number(x) : x;
  return {
    el: grid,
    // Every field as { key: value } (the assignee control expands to owner and queue).
    values() {
      const out = {};
      for (const c of ctrls) { const x = c.get(); if (c.f.t === 'assignee') Object.assign(out, x); else out[c.f.k] = x; }
      return out;
    },
    // Only what the person actually changed, so fields they cannot edit are never sent.
    changed() {
      const now = this.values(), out = {};
      for (const c of ctrls) {
        const keys = c.f.t === 'assignee' ? ['owner_user_id', 'queue_id'] : [c.f.k];
        for (const k of keys) {
          const f = c.f.t === 'assignee' ? {} : c.f;
          if (norm(f, now[k]) !== norm(f, rec[k])) { for (const kk of keys) out[kk] = now[kk]; break; }
        }
      }
      return out;
    },
  };
}

async function loadRefs() {
  const [users, stages, queues, accounts, contacts] = await Promise.all([
    api('GET', '/users').then((r) => r.data),
    api('GET', '/pipeline-stages').then((r) => r.data).catch(() => []),
    api('GET', '/queues').then((r) => r.data).catch(() => []),
    can('account', 'read') ? listAll('/accounts') : [],
    can('contact', 'read') ? listAll('/contacts') : [],
  ]);
  cache.users = users;
  cache.stages = stages.sort((a, b) => a.sort_order - b.sort_order);
  cache.queues = queues.filter((q) => q.is_active !== false);
  cache.accounts = accounts.sort((a, b) => a.name.localeCompare(b.name));
  cache.contacts = contacts.sort((a, b) => ENT.contacts.title(a).localeCompare(ENT.contacts.title(b)));
}
async function refreshRef(name) {
  if (name === 'accounts') cache.accounts = (await listAll('/accounts')).sort((a, b) => a.name.localeCompare(b.name));
  if (name === 'contacts') cache.contacts = (await listAll('/contacts')).sort((a, b) => ENT.contacts.title(a).localeCompare(ENT.contacts.title(b)));
}

// ---------- cell rendering ----------
function cell(col, r) {
  const [k, , kind] = col;
  switch (kind) {
    case 'date': return fmtDate(r[k]);
    case 'user': return userName(r[k]);
    case 'account': { const a = cache.accounts.find((x) => x.id === r[k]); return a ? h('a', { href: '#/accounts/' + a.id, onclick: (e) => e.stopPropagation() }, a.name) : ''; }
    case 'contactname': return ENT.contacts.title(r);
    case 'health': return r[k] == null ? '' : h('span', { class: 'pill ' + (r[k] < 40 ? 'bad' : r[k] < 70 ? 'warn' : 'ok') }, r[k]);
    case 'status': return h('span', { class: 'pill ' + (['solved', 'closed'].includes(r[k]) ? 'ok' : r[k] === 'escalated' ? 'bad' : '') }, r[k]);
    case 'priority': return h('span', { class: 'pill ' + (r[k] === 'urgent' ? 'bad' : r[k] === 'high' ? 'warn' : '') }, r[k]);
    case 'sla': return ['solved', 'closed'].includes(r.status) ? '' : dueBadge(r[k], false);
    case 'assignee': return r.owner_user_id ? userName(r.owner_user_id) : (cache.queues.find((q) => q.id === r.queue_id)?.name ? 'Queue: ' + cache.queues.find((q) => q.id === r.queue_id).name : '');
    default: return r[k] ?? '';
  }
}

// ---------- views ----------
const view = () => $('#view');
function setView(...nodes) { view().replaceChildren(...nodes.flat()); window.scrollTo(0, 0); }

async function viewHome() {
  const [cases, deals] = await Promise.all([
    can('case', 'read') ? listAll('/cases') : [], can('opportunity', 'read') ? listAll('/opportunities') : [],
  ]);
  const openCases = cases.filter((c) => !['solved', 'closed'].includes(c.status));
  const breached = openCases.filter((c) => new Date(c.resolution_due_at) < Date.now() || (!c.first_response_at && new Date(c.first_response_due_at) < Date.now()));
  const openDeals = deals.filter((d) => !d.is_closed);
  const pipeline = openDeals.reduce((s, d) => s + Number(d.amount || 0), 0);
  const weighted = openDeals.reduce((s, d) => s + Number(d.amount || 0) * d.probability / 100, 0);
  const risk = cache.accounts.filter((a) => a.health_score != null && a.health_score < 40);
  const soon = Date.now() + 90 * 864e5;
  const renewals = cache.accounts.filter((a) => a.renewal_date && new Date(a.renewal_date) <= soon && new Date(a.renewal_date) >= Date.now() - 864e5);
  const stat = (n, l, href) => h(href ? 'a' : 'div', { class: 'stat', href, style: 'color:inherit;text-decoration:none' }, h('div', { class: 'n' }, n), h('div', { class: 'l' }, l));

  const caseRows = openCases.sort((a, b) => new Date(a.resolution_due_at) - new Date(b.resolution_due_at)).slice(0, 6);
  const dealRows = openDeals.sort((a, b) => a.close_date.localeCompare(b.close_date)).slice(0, 6);
  setView(
    h('div', { class: 'head' }, h('h1', {}, `Hi ${me.user.display_name.split(' ')[0]}`)),
    h('div', { class: 'stats' },
      can('case', 'read') ? stat(openCases.length, 'Open cases', '#/cases') : null,
      can('case', 'read') ? stat(breached.length, 'Past an SLA target', '#/cases') : null,
      can('opportunity', 'read') ? stat(money(pipeline), `Open pipeline (${money(weighted)} weighted)`, '#/deals') : null,
      can('account', 'read') ? stat(risk.length, 'Accounts at risk (health under 40)', '#/accounts') : null,
      can('account', 'read') ? stat(renewals.length, 'Renewals in the next 90 days', '#/accounts') : null),
    can('case', 'read') ? h('div', { class: 'card tablewrap' },
      h('div', { style: 'padding:14px 16px 4px' }, h('h2', {}, 'Cases due soonest')),
      caseRows.length ? h('table', {}, h('tbody', {}, caseRows.map((c) => h('tr', { class: 'row', onclick: () => location.hash = '#/cases/' + c.id },
        h('td', {}, '#' + c.case_number), h('td', {}, c.subject), h('td', {}, cell(['priority', '', 'priority'], c)), h('td', {}, dueBadge(c.resolution_due_at, false)))))) : h('div', { class: 'empty' }, 'No open cases.')) : null,
    can('opportunity', 'read') ? h('div', { class: 'card tablewrap' },
      h('div', { style: 'padding:14px 16px 4px' }, h('h2', {}, 'Deals closing soonest')),
      dealRows.length ? h('table', {}, h('tbody', {}, dealRows.map((d) => h('tr', { class: 'row', onclick: () => location.hash = '#/deals/' + d.id },
        h('td', {}, d.name), h('td', {}, stageOf(d.stage_id)?.name), h('td', {}, money(d.amount)), h('td', {}, fmtDate(d.close_date)))))) : h('div', { class: 'empty' }, 'No open deals.')) : null,
    !cases.length && !deals.length && !cache.accounts.length ? h('div', { class: 'card empty' }, 'This workspace is empty. Start by adding an account.') : null,
  );
}

function openCreate(key, defaults = {}, after) {
  const ent = ENT[key];
  const form = makeForm(ent.fields.filter((f) => f.create), null);
  // preset values (for example the account when adding from an account page)
  for (const [k, v] of Object.entries(defaults)) { const el = form.el.querySelector(`[data-k="${k}"]`); if (el) el.value = v; }
  modal('New ' + ent.one.toLowerCase(), form.el, [
    { label: 'Cancel' },
    { label: 'Create', primary: true, run: async (dlg) => {
      const body = {};
      for (const [k, v] of Object.entries({ ...form.values() })) if (v !== null && v !== '') body[k] = v;
      if (key === 'deals') {
        const st = stageOf(body.stage_id);
        if (st?.is_closed && !st.is_won) throw new ApiErr(422, { message: 'Create the deal in an open stage, then move it to Closed Lost with a reason.' });
      }
      const rec = await api('POST', '/' + ent.path, body);
      dlg.close();
      if (key === 'accounts' || key === 'contacts') await refreshRef(key);
      toast(ent.one + ' created');
      if (after) after(rec); else location.hash = `#/${key}/${rec.id}`;
    } },
  ]);
}

async function viewList(key) {
  const ent = ENT[key];
  const rows = await listAll('/' + ent.path);
  const search = h('input', { class: 'search', type: 'search', placeholder: 'Search ' + ent.label.toLowerCase() });
  const body = h('tbody');
  const draw = () => {
    const q = search.value.toLowerCase();
    const shown = rows.filter((r) => !q || JSON.stringify(Object.values(r)).toLowerCase().includes(q) || ent.title(r).toLowerCase().includes(q));
    body.replaceChildren(...shown.map((r) => h('tr', { class: 'row', onclick: () => location.hash = `#/${key}/${r.id}` },
      ent.cols.map((c) => h('td', {}, cell(c, r))))));
    count.textContent = `${shown.length} of ${rows.length}`;
    empty.hidden = shown.length > 0;
  };
  const count = h('span', { class: 'muted' });
  const empty = h('div', { class: 'empty' }, rows.length ? 'Nothing matches.' : `No ${ent.label.toLowerCase()} yet.`);
  search.addEventListener('input', draw);
  setView(
    h('div', { class: 'head' }, h('h1', {}, ent.label),
      h('div', { class: 'tools' }, count, search, can(ent.perm, 'create') ? h('button', { class: 'primary', onclick: () => openCreate(key) }, 'New ' + ent.one.toLowerCase()) : null)),
    h('div', { class: 'card tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ent.cols.map((c) => h('th', {}, c[1])))), body), empty));
  draw();
}

// Moves a deal to a stage, asking for a loss reason when the stage needs one.
async function moveDeal(deal, stageId, done) {
  const st = stageOf(stageId);
  if (!st || stageId === deal.stage_id) return;
  const go = async (extra = {}) => { await api('PATCH', '/opportunities/' + deal.id, { version: deal.version, stage_id: stageId, ...extra }); toast(`Moved to ${st.name}`); done(); };
  if (st.is_closed && !st.is_won) {
    const reason = h('input', { type: 'text', placeholder: 'For example: price, went with a competitor' });
    modal(`Close "${deal.name}" as lost`, h('label', { class: 'f' }, h('span', {}, 'Why was it lost? *'), reason), [
      { label: 'Cancel' },
      { label: 'Close as lost', primary: true, run: async (dlg) => {
        if (!reason.value.trim()) throw new ApiErr(422, { message: 'Add a reason first.' });
        await go({ loss_reason: reason.value.trim() }); dlg.close();
      } },
    ]);
    return;
  }
  try { await go(); } catch (e) { toast(errText(e), true); done(); }
}

async function viewDeals() {
  const ent = ENT.deals;
  const deals = await listAll('/opportunities');
  const search = h('input', { class: 'search', type: 'search', placeholder: 'Search deals' });
  const board = h('div', { class: 'board' });
  const draw = () => {
    const q = search.value.toLowerCase();
    board.replaceChildren(...cache.stages.map((st) => {
      const list = deals.filter((d) => d.stage_id === st.id && (!q || (d.name + ' ' + (cache.accounts.find((a) => a.id === d.account_id)?.name || '')).toLowerCase().includes(q)));
      const total = list.reduce((s, d) => s + Number(d.amount || 0), 0);
      const col = h('div', { class: 'col' }, h('h3', {}, st.name, h('span', {}, `${list.length} · ${money(total)}`)),
        list.map((d) => h('div', { class: 'deal', draggable: 'true',
          ondragstart: (e) => { e.dataTransfer.setData('text/plain', d.id); e.currentTarget.classList.add('dragging'); },
          ondragend: (e) => e.currentTarget.classList.remove('dragging'),
          onclick: () => location.hash = '#/deals/' + d.id },
          h('b', {}, d.name),
          h('div', { class: 'm' }, cache.accounts.find((a) => a.id === d.account_id)?.name || ''),
          h('div', { class: 'm' }, [money(d.amount), fmtDate(d.close_date), userName(d.owner_user_id)].filter(Boolean).join(' · ')))));
      if (can('opportunity', 'edit')) {
        col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('over'); });
        col.addEventListener('dragleave', () => col.classList.remove('over'));
        col.addEventListener('drop', (e) => {
          e.preventDefault(); col.classList.remove('over');
          const d = deals.find((x) => x.id === e.dataTransfer.getData('text/plain'));
          if (d) moveDeal(d, st.id, () => viewDeals());
        });
      }
      return col;
    }));
  };
  search.addEventListener('input', draw);
  setView(h('div', { class: 'head' }, h('h1', {}, 'Deals'),
    h('div', { class: 'tools' }, search, can('opportunity', 'create') ? h('button', { class: 'primary', onclick: () => openCreate('deals') }, 'New deal') : null)), board);
  draw();
}

// ---------- detail pages ----------
function related(title, node, action) {
  return h('div', { class: 'card' }, h('div', { class: 'sectionhead' }, h('h2', {}, title), action || null), node);
}
function miniTable(rows, cols, hrefOf, emptyText) {
  if (!rows.length) return h('div', { class: 'muted' }, emptyText);
  return h('div', { class: 'tablewrap' }, h('table', {}, h('tbody', {}, rows.map((r) => h('tr', { class: 'row', onclick: () => location.hash = hrefOf(r) }, cols.map((c) => h('td', {}, c(r))))))));
}

async function activitiesPanel(filterKey, id) {
  const wrap = h('div');
  const draw = async () => {
    const acts = (await listAll(`/activities?${filterKey}=${id}`)).reverse();
    const type = selectOf(optList(OPTS.activity), 'note', { blank: false });
    const subject = h('input', { class: 'grow', type: 'text', placeholder: 'What happened or what needs doing' });
    const due = h('input', { type: 'datetime-local', title: 'Due (optional)' });
    const add = h('button', { class: 'primary', onclick: async (e) => {
      if (!subject.value.trim()) return subject.focus();
      e.target.disabled = true;
      try { await api('POST', '/activities', { type: type.value, subject: subject.value.trim(), due_at: fromLocalInput(due.value), [filterKey]: id }); await draw(); }
      catch (err) { toast(errText(err), true); e.target.disabled = false; }
    } }, 'Add');
    wrap.replaceChildren(
      can('activity', 'create') ? h('div', { class: 'inline', style: 'margin-bottom:12px' }, type, subject, due, add) : null,
      acts.length ? h('table', {}, h('tbody', {}, acts.map((a) => h('tr', {},
        h('td', { style: 'width:28px' }, a.type === 'task' && can('activity', 'edit') ? h('input', { type: 'checkbox', checked: !!a.completed_at, title: 'Done',
          onchange: async (e) => { try { await api('PATCH', '/activities/' + a.id, { version: a.version, completed_at: e.target.checked ? new Date().toISOString() : null }); await draw(); } catch (err) { toast(errText(err), true); e.target.checked = !e.target.checked; } } }) : null),
        h('td', {}, h('span', { class: 'pill' }, a.type)),
        h('td', { style: a.completed_at ? 'text-decoration:line-through;color:var(--muted)' : '' }, a.subject),
        h('td', { class: 'muted' }, a.due_at ? 'due ' + fmtDateTime(a.due_at) : fmtDateTime(a.created_at)),
        h('td', { class: 'muted' }, userName(a.owner_user_id)))))) : h('div', { class: 'muted' }, 'Nothing logged yet.'));
  };
  await draw();
  return wrap;
}

async function viewDetail(key, id) {
  const ent = ENT[key];
  let rec;
  try { rec = await api('GET', `/${ent.path}/${id}`); } catch (e) {
    if (e.status === 404) return setView(h('div', { class: 'card empty' }, `That ${ent.one.toLowerCase()} was not found. It may have been deleted.`, h('div', {}, h('a', { href: '#/' + key }, 'Back to ' + ent.label.toLowerCase()))));
    throw e;
  }
  const editable = can(ent.perm, 'edit');
  const form = makeForm(ent.fields, rec, { disabled: !editable });
  const banner = h('div', { class: 'banner', hidden: true });
  const save = h('button', { class: 'primary', onclick: async () => {
    const changes = form.changed();
    if (!Object.keys(changes).length) return toast('Nothing to save');
    if (key === 'deals' && changes.stage_id) {
      const st = stageOf(changes.stage_id);
      const reason = changes.loss_reason ?? rec.loss_reason;
      if (st?.is_closed && !st.is_won && !reason) { banner.textContent = 'Add a loss reason to close a deal as lost.'; banner.hidden = false; return; }
    }
    save.disabled = true; banner.hidden = true;
    try {
      await api('PATCH', `/${ent.path}/${id}`, { version: rec.version, ...changes });
      if (key === 'accounts' || key === 'contacts') await refreshRef(key);
      toast('Saved'); await viewDetail(key, id);
    } catch (e) { banner.textContent = errText(e); banner.hidden = false; save.disabled = false; }
  } }, 'Save changes');
  const del = h('button', { class: 'danger', onclick: () => modal(`Delete this ${ent.one.toLowerCase()}?`, h('p', {}, `"${ent.title(rec)}" will be hidden everywhere. It stays in the audit history.`), [
    { label: 'Keep it' },
    { label: 'Delete', primary: true, run: async (dlg) => { await api('DELETE', `/${ent.path}/${id}`); dlg.close(); if (key === 'accounts' || key === 'contacts') await refreshRef(key); toast('Deleted'); location.hash = '#/' + key; } },
  ]) }, 'Delete');

  const heading = h('div', { class: 'head' }, h('div', {},
    h('div', { class: 'crumb' }, h('a', { href: '#/' + key }, ent.label)),
    h('h1', {}, ent.title(rec))),
    key === 'cases' ? h('div', { class: 'inline' },
      ['solved', 'closed'].includes(rec.status)
        ? (editable ? h('button', { onclick: () => quickStatus('open') }, 'Reopen') : null)
        : (editable ? [h('button', { onclick: () => quickStatus('solved') }, 'Mark solved')] : null)) : null);
  async function quickStatus(status) {
    try { await api('PATCH', `/cases/${id}`, { version: rec.version, status }); toast('Status: ' + status); await viewDetail(key, id); } catch (e) { toast(errText(e), true); }
  }

  const parts = [heading];
  if (key === 'cases') {
    const done = ['solved', 'closed'].includes(rec.status);
    parts.push(h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('div', { class: 'l' }, 'First response'), h('div', {}, dueBadge(rec.first_response_due_at, !!rec.first_response_at), ' ', h('span', { class: 'muted' }, rec.first_response_at ? 'at ' + fmtDateTime(rec.first_response_at) : 'due ' + fmtDateTime(rec.first_response_due_at)))),
      h('div', { class: 'stat' }, h('div', { class: 'l' }, 'Resolution'), h('div', {}, dueBadge(rec.resolution_due_at, done), ' ', h('span', { class: 'muted' }, done ? 'at ' + fmtDateTime(rec.resolved_at || rec.closed_at) : 'due ' + fmtDateTime(rec.resolution_due_at)))),
      h('div', { class: 'stat' }, h('div', { class: 'l' }, 'Opened'), h('div', {}, fmtDateTime(rec.opened_at)))));
  }
  if (key === 'deals') {
    parts.push(h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('div', { class: 'l' }, 'Status'), h('div', {}, h('span', { class: 'pill ' + (rec.is_won ? 'ok' : rec.is_closed ? 'bad' : '') }, rec.is_won ? 'Won' : rec.is_closed ? 'Lost' : 'Open'))),
      h('div', { class: 'stat' }, h('div', { class: 'l' }, 'Amount'), h('div', { class: 'n' }, money(rec.amount) || '$0'))));
  }
  parts.push(h('div', { class: 'card' }, banner, form.el,
    editable || can(ent.perm, 'delete') ? h('div', { class: 'actions' }, editable ? save : null, can(ent.perm, 'delete') ? del : null) : h('div', { class: 'muted', style: 'margin-top:12px' }, 'You have read only access to this record.'),
    h('div', { class: 'muted', style: 'margin-top:12px;font-size:12px' }, `Created ${fmtDateTime(rec.created_at)} · Updated ${fmtDateTime(rec.updated_at)} · Version ${rec.version}`)));
  setView(parts);

  const add = (node) => view().append(node);
  if (key === 'accounts') {
    const [contacts, deals, cases] = await Promise.all([
      can('contact', 'read') ? listAll('/contacts?account_id=' + id) : [], can('opportunity', 'read') ? listAll('/opportunities?account_id=' + id) : [], can('case', 'read') ? listAll('/cases?account_id=' + id) : []]);
    if (can('contact', 'read')) add(related('Contacts', miniTable(contacts, [(c) => ENT.contacts.title(c), (c) => c.email || '', (c) => c.title || ''], (c) => '#/contacts/' + c.id, 'No contacts yet.'),
      can('contact', 'create') ? h('button', { class: 'small', onclick: () => openCreate('contacts', { account_id: id }) }, 'Add contact') : null));
    if (can('opportunity', 'read')) add(related('Deals', miniTable(deals, [(d) => d.name, (d) => stageOf(d.stage_id)?.name || '', (d) => money(d.amount), (d) => fmtDate(d.close_date)], (d) => '#/deals/' + d.id, 'No deals yet.'),
      can('opportunity', 'create') ? h('button', { class: 'small', onclick: () => openCreate('deals', { account_id: id }) }, 'Add deal') : null));
    if (can('case', 'read')) add(related('Cases', miniTable(cases, [(c) => '#' + c.case_number, (c) => c.subject, (c) => cell(['status', '', 'status'], c), (c) => dueBadge(c.resolution_due_at, ['solved', 'closed'].includes(c.status))], (c) => '#/cases/' + c.id, 'No cases yet.'),
      can('case', 'create') ? h('button', { class: 'small', onclick: () => openCreate('cases', { account_id: id }) }, 'Add case') : null));
    if (can('activity', 'read')) add(related('Activity', await activitiesPanel('account_id', id)));
  }
  if (key === 'contacts') {
    const cases = can('case', 'read') ? await listAll('/cases?contact_id=' + id) : [];
    if (rec.account_id) add(related('Account', h('a', { href: '#/accounts/' + rec.account_id }, cache.accounts.find((a) => a.id === rec.account_id)?.name || 'Open account')));
    if (can('case', 'read')) add(related('Cases', miniTable(cases, [(c) => '#' + c.case_number, (c) => c.subject, (c) => cell(['status', '', 'status'], c)], (c) => '#/cases/' + c.id, 'No cases yet.')));
    if (can('activity', 'read')) add(related('Activity', await activitiesPanel('contact_id', id)));
  }
  if (key === 'deals') {
    add(related('Account', h('a', { href: '#/accounts/' + rec.account_id }, cache.accounts.find((a) => a.id === rec.account_id)?.name || 'Open account')));
    if (can('activity', 'read')) add(related('Activity', await activitiesPanel('opportunity_id', id)));
  }
  if (key === 'cases') {
    if (rec.account_id && can('account', 'read')) add(related('Account', h('a', { href: '#/accounts/' + rec.account_id }, cache.accounts.find((a) => a.id === rec.account_id)?.name || 'Open account')));
    if (can('case_comment', 'read')) add(await commentsPanel(rec));
    if (can('activity', 'read')) add(related('Tasks and notes', await activitiesPanel('case_id', id)));
  }
}

async function commentsPanel(rec) {
  const comments = await listAll('/case-comments?case_id=' + rec.id);
  const thread = h('div', { class: 'thread' }, comments.length ? comments.map((c) => {
    const customer = !c.author_user_id;
    return h('div', { class: 'msg ' + (!c.is_public ? 'internal' : customer ? 'customer' : '') },
      h('div', { class: 'who' }, `${customer ? 'Customer' : userName(c.author_user_id) || 'Agent'} · ${c.is_public ? (customer ? 'wrote in' : 'public reply') : 'internal note'} · ${fmtDateTime(c.created_at)}`),
      h('div', { class: 'body' }, c.body));
  }) : h('div', { class: 'muted' }, 'No messages yet.'));
  let composer = null;
  if (can('case_comment', 'create')) {
    const mode = selectOf([['public', 'Reply to customer'], ['internal', 'Internal note'], ['customer', 'Customer wrote in']], 'public', { blank: false });
    const body = h('textarea', { placeholder: 'Write a message' });
    const send = h('button', { class: 'primary', onclick: async (e) => {
      if (!body.value.trim()) return body.focus();
      e.target.disabled = true;
      const payload = { case_id: rec.id, body: body.value.trim(), is_public: mode.value !== 'internal' };
      if (mode.value !== 'customer') payload.author_user_id = me.user.id;
      try { await api('POST', '/case-comments', payload); toast('Sent'); await viewDetail('cases', rec.id); } catch (err) { toast(errText(err), true); e.target.disabled = false; }
    } }, 'Send');
    composer = h('div', { style: 'margin-top:12px' }, body, h('div', { class: 'inline', style: 'margin-top:8px' }, mode, send));
  }
  return related('Conversation', h('div', {}, thread, composer));
}

// ---------- shell, sign in, routing ----------
function renderLogin(msg) {
  const err = h('div', { class: 'banner', hidden: !msg }, msg || '');
  const email = h('input', { type: 'email', autocomplete: 'username', placeholder: 'you@example.com' });
  const key = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Your access key' });
  const fail = (text) => { err.textContent = text; err.hidden = false; };
  async function enter(t) {
    token = t; signingIn = true;
    try { localStorage.setItem(TOKEN_KEY, token); await boot(); signingIn = false; }
    catch (x) { signingIn = false; token = ''; localStorage.removeItem(TOKEN_KEY); throw x; }
  }
  const go = async (e) => {
    e?.preventDefault();
    if (!email.value.trim() || !key.value) return fail('Enter your email and access key.');
    btn.disabled = true; err.hidden = true;
    try {
      const res = await fetch('/v1/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: email.value, key: key.value }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new ApiErr(res.status, j.error);
      await enter(j.token);
    } catch (x) { fail(x.status === 404 ? 'Email sign in is not turned on for this server. Use an access token below.' : errText(x)); btn.disabled = false; }
  };
  const btn = h('button', { class: 'primary', type: 'submit' }, 'Sign in');
  const pasted = h('textarea', { placeholder: 'Paste an access token', spellcheck: 'false' });
  $('#app').replaceChildren(h('div', { class: 'login' },
    h('div', { class: 'brand', style: 'padding-left:0' }, h('i'), 'CRM'),
    h('form', { class: 'card', onsubmit: go }, h('h1', { style: 'margin-bottom:12px' }, 'Sign in'), err,
      h('div', { class: 'grid2', style: 'grid-template-columns:1fr' },
        h('label', { class: 'f' }, h('span', {}, 'Email'), email), h('label', { class: 'f' }, h('span', {}, 'Access key'), key)),
      h('div', { class: 'actions' }, btn)),
    h('details', { class: 'muted', style: 'margin-top:8px' }, h('summary', {}, 'Have an access token instead?'),
      h('div', { style: 'margin-top:8px' }, pasted, h('div', { class: 'actions' }, h('button', { type: 'button', onclick: async () => {
        const t = pasted.value.trim().replace(/^Bearer\s+/i, ''); if (!t) return pasted.focus();
        try { await enter(t); } catch (x) { fail(x.status === 401 ? 'That token was not accepted. It may have expired.' : errText(x)); }
      } }, 'Use token'))))));
}
function signOut() { token = ''; me = null; localStorage.removeItem(TOKEN_KEY); renderLogin(); }

function renderShell() {
  const items = [['#/', 'Home', true], ['#/accounts', 'Accounts', can('account', 'read')], ['#/contacts', 'Contacts', can('contact', 'read')],
    ['#/deals', 'Deals', can('opportunity', 'read')], ['#/cases', 'Cases', can('case', 'read')]];
  $('#app').replaceChildren(h('div', { class: 'shell' },
    h('nav', { class: 'side' }, h('div', { class: 'brand' }, h('i'), 'CRM'),
      items.filter((i) => i[2]).map(([href, label]) => h('a', { class: 'item', href, 'data-nav': href }, label)),
      h('div', { class: 'who' }, h('b', {}, me.user.display_name), h('span', { class: 'muted' }, me.user.email), h('div', {}, h('a', { href: '#', onclick: (e) => { e.preventDefault(); signOut(); } }, 'Sign out')))),
    h('main', {}, h('div', { id: 'view' }))));
}

async function route() {
  if (!me) return;
  const [, a, id] = (location.hash || '#/').split('/');
  const section = a || '';
  document.querySelectorAll('[data-nav]').forEach((n) => n.classList.toggle('on', n.dataset.nav === '#/' + section || (section === '' && n.dataset.nav === '#/')));
  try {
    setView(h('div', { class: 'muted' }, 'Loading…'));
    if (section === '') await viewHome();
    else if (section === 'deals' && !id) await viewDeals();
    else if (ENT[section] && !id) await viewList(section);
    else if (ENT[section]) await viewDetail(section, id);
    else setView(h('div', { class: 'card empty' }, 'Page not found.'));
  } catch (e) {
    if (e.status === 401) return;
    setView(h('div', { class: 'banner' }, errText(e)));
  }
}

async function boot() {
  me = await api('GET', '/me');
  await loadRefs();
  renderShell();
  await route();
}
window.addEventListener('hashchange', route);
if (token) boot().catch(() => renderLogin()); else renderLogin();
