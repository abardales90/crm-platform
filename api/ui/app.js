// Tally web app. No build step. All text from the server goes in with textContent, never as HTML.
import { RELEASES } from './changelog.js';

const TOKEN_KEY = 'crm_token';
let token = localStorage.getItem(TOKEN_KEY) || '';
let me = null; // { user, permissions }
let signingIn = false; // while true, a 401 means 'bad token', not 'session expired'
const cache = { users: [], stages: [], queues: [], accounts: [], contacts: [], workspace: null };

// ---------- theme: match the device, or force light or dark ----------
const THEME_KEY = 'crm_theme';
function getTheme() { try { return localStorage.getItem(THEME_KEY) || 'system'; } catch { return 'system'; } }
function applyTheme(t) { if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; updateFavicon(); }
// The little icon on the browser tab uses the same color as the Tally mark in the menu.
function updateFavicon() {
  try {
    const cs = getComputedStyle(document.documentElement);
    const ok = (v, d) => /^#[0-9a-f]{3,8}$/i.test(v) ? v : d;
    const bg = ok(cs.getPropertyValue('--accent').trim(), '#2f6f5e'), fg = ok(cs.getPropertyValue('--accent-ink').trim(), '#ffffff');
    const markup = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${bg}"/><g fill="${fg}"><rect x="15" y="14" width="34" height="11" rx="4"/><rect x="26.5" y="14" width="11" height="22" rx="4"/><circle cx="32" cy="47" r="5.5"/></g></svg>`;
    let link = document.querySelector('link[rel="icon"]');
    if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.append(link); }
    link.type = 'image/svg+xml'; link.href = 'data:image/svg+xml,' + encodeURIComponent(markup);
  } catch { /* the tab icon is only a nicety */ }
}
try { window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', updateFavicon); } catch { /* old browser */ }
function setTheme(t) { try { localStorage.setItem(THEME_KEY, t); } catch { /* private window: the choice lasts until reload */ } applyTheme(t); }
applyTheme(getTheme());

// ---------- accent color: one per person, saved on the server and remembered in this browser to avoid a flash ----------
const ACCENT_KEY = 'crm_accent';
const ACCENTS = [['green', 'Green'], ['blue', 'Blue'], ['purple', 'Purple'], ['orange', 'Orange'], ['rose', 'Rose'], ['slate', 'Slate']];
function applyAccent(a) {
  if (a && a !== 'green' && ACCENTS.some((x) => x[0] === a)) document.documentElement.dataset.accent = a; else delete document.documentElement.dataset.accent;
  try { localStorage.setItem(ACCENT_KEY, a || 'green'); } catch { /* private window */ }
  updateFavicon();
}
let prefs = { accent: null, tour_done_at: null, last_seen_release: null };
async function savePrefs(change) { prefs = await api('PUT', '/me/preferences', change); return prefs; }

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
    cols: [['name', 'Name'], ['domain', 'Domain'], ['type', 'Type', 'enum'], ['health_score', 'Health', 'health'], ['renewal_date', 'Renewal', 'date'], ['owner_user_id', 'Owner', 'user']],
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
// Stored values stay lowercase in the database. Screens show them in Title Case.
const cap = (s) => s == null ? '' : String(s).replace(/\b[a-z]/g, (c) => c.toUpperCase());
const optList = (arr) => arr.map((x) => [x, cap(x)]);

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
  const [users, stages, queues, accounts, contacts, workspace] = await Promise.all([
    api('GET', '/users').then((r) => r.data),
    api('GET', '/pipeline-stages').then((r) => r.data).catch(() => []),
    api('GET', '/queues').then((r) => r.data).catch(() => []),
    can('account', 'read') ? listAll('/accounts') : [],
    can('contact', 'read') ? listAll('/contacts') : [],
    api('GET', '/settings/workspace').catch(() => null),
  ]);
  cache.workspace = workspace;
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
    case 'enum': return cap(r[k]);
    case 'status': return h('span', { class: 'pill ' + (['solved', 'closed'].includes(r[k]) ? 'ok' : r[k] === 'escalated' ? 'bad' : '') }, cap(r[k]));
    case 'priority': return h('span', { class: 'pill ' + (r[k] === 'urgent' ? 'bad' : r[k] === 'high' ? 'warn' : '') }, cap(r[k]));
    case 'sla': return ['solved', 'closed'].includes(r.status) ? '' : dueBadge(r[k], false);
    case 'assignee': return r.owner_user_id ? userName(r.owner_user_id) : (cache.queues.find((q) => q.id === r.queue_id)?.name ? 'Queue: ' + cache.queues.find((q) => q.id === r.queue_id).name : '');
    default: return r[k] ?? '';
  }
}

// ---------- views ----------
let routeSeq = 0; // bumped on every navigation, so a slow page never paints over a newer one
const view = () => $('#view');
function setView(...nodes) { view().replaceChildren(...nodes.flat(Infinity).filter((n) => n != null && n !== false)); window.scrollTo(0, 0); }

async function viewHome() {
  const [cases, deals, myTasks] = await Promise.all([
    can('case', 'read') ? listAll('/cases') : [], can('opportunity', 'read') ? listAll('/opportunities') : [],
    can('activity', 'read') ? listAll(`/activities?type=task&owner_user_id=${me.user.id}`) : [],
  ]);
  const endOfToday = new Date(); endOfToday.setHours(23, 59, 59, 999);
  const tasksDue = myTasks.filter((t) => !t.completed_at && t.due_at && new Date(t.due_at) <= endOfToday);
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
      can('activity', 'read') ? stat(tasksDue.length, 'My tasks due today or overdue', '#/tasks') : null,
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
  let shown = rows;
  const draw = () => {
    const q = search.value.toLowerCase();
    shown = rows.filter((r) => !q || JSON.stringify(Object.values(r)).toLowerCase().includes(q) || ent.title(r).toLowerCase().includes(q));
    body.replaceChildren(...shown.map((r) => h('tr', { class: 'row', onclick: () => location.hash = `#/${key}/${r.id}` },
      ent.cols.map((c) => h('td', {}, cell(c, r))))));
    count.textContent = `${shown.length} of ${rows.length}`;
    empty.hidden = shown.length > 0;
  };
  const count = h('span', { class: 'muted' });
  const empty = h('div', { class: 'empty' }, rows.length ? 'Nothing matches.' : `No ${ent.label.toLowerCase()} yet.`);
  search.addEventListener('input', draw);
  setView(
    h('div', { class: 'head' }, titled(key, ent.label),
      h('div', { class: 'tools' }, count, search, exportButton(key, () => shown),
        ['accounts', 'contacts'].includes(key) && can(ent.perm, 'create') ? h('button', { class: 'small', onclick: () => openImport(key) }, 'Import CSV') : null,
        can(ent.perm, 'create') ? h('button', { class: 'primary', onclick: () => openCreate(key) }, 'New ' + ent.one.toLowerCase()) : null)),
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
  setView(h('div', { class: 'head' }, titled('deals', 'Deals'),
    h('div', { class: 'tools' }, search, exportButton('deals', () => deals), can('opportunity', 'create') ? h('button', { class: 'primary', onclick: () => openCreate('deals') }, 'New deal') : null)), board);
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
        h('td', {}, h('span', { class: 'pill' }, cap(a.type))),
        h('td', { style: a.completed_at ? 'text-decoration:line-through;color:var(--muted)' : '' }, a.subject),
        h('td', { class: 'muted' }, a.due_at ? 'due ' + fmtDateTime(a.due_at) : fmtDateTime(a.created_at)),
        h('td', { class: 'muted' }, userName(a.owner_user_id)))))) : h('div', { class: 'muted' }, 'Nothing logged yet.'));
  };
  await draw();
  return wrap;
}

async function viewDetail(key, id) {
  const ent = ENT[key];
  const seq = routeSeq;
  let rec;
  try { rec = await api('GET', `/${ent.path}/${id}`); if (seq !== routeSeq) return; } catch (e) {
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
    titled(key, ent.title(rec))),
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

  const add = (node) => { if (seq === routeSeq) view().append(node); };
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
  const [comments, emails] = await Promise.all([
    listAll('/case-comments?case_id=' + rec.id),
    can('case', 'read') ? api('GET', `/cases/${rec.id}/emails`).then((r) => r.data).catch(() => []) : [],
  ]);
  const thread = h('div', { class: 'thread' }, comments.length ? comments.map((c) => {
    const customer = !c.author_user_id;
    return h('div', { class: 'msg ' + (!c.is_public ? 'internal' : customer ? 'customer' : '') },
      h('div', { class: 'who' }, `${customer ? 'Customer' : userName(c.author_user_id) || 'Agent'} · ${c.is_public ? (customer ? 'wrote in' : 'public reply') : 'internal note'} · ${fmtDateTime(c.created_at)}`),
      h('div', { class: 'body' }, c.body));
  }) : h('div', { class: 'muted' }, 'No messages yet.'));
  let composer = null;
  if (can('case_comment', 'create')) {
    const contact = cache.contacts.find((c) => c.id === rec.contact_id);
    const emailOn = !!cache.workspace?.email?.configured;
    const emailOk = emailOn && !!contact?.email && !contact.do_not_contact && can('contact', 'read');
    const modes = [];
    if (emailOk) modes.push(['email', `Reply by email to ${ENT.contacts.title(contact)}`]);
    modes.push(['public', emailOk ? 'Post a reply without emailing' : 'Reply to customer (not emailed)'], ['internal', 'Internal note'], ['customer', 'Customer wrote in']);
    const mode = selectOf(modes, modes[0][0], { blank: false });
    const body = h('textarea', { placeholder: 'Write a message' });
    const subject = h('input', { type: 'text', value: `Re: [Case #${rec.case_number}] ${rec.subject}` });
    const after = selectOf(optList(OPTS.caseStatus), ['new', 'open'].includes(rec.status) ? 'pending customer' : rec.status, { blank: false });
    const emailRow = h('div', { class: 'inline', style: 'margin-top:8px;align-items:flex-end' },
      h('label', { class: 'f', style: 'flex:1;min-width:220px' }, h('span', {}, 'Subject'), subject),
      can('case', 'edit') ? h('label', { class: 'f' }, h('span', {}, 'Then set the case to'), after) : null);
    const send = h('button', { class: 'primary', onclick: async (e) => {
      if (!body.value.trim()) return body.focus();
      e.target.disabled = true;
      try {
        if (mode.value === 'email') {
          await api('POST', `/cases/${rec.id}/reply`, { body: body.value.trim(), subject: subject.value.trim(), ...(can('case', 'edit') ? { status: after.value } : {}) });
          toast('Email sent to ' + contact.email);
        } else {
          const payload = { case_id: rec.id, body: body.value.trim(), is_public: mode.value !== 'internal' };
          if (mode.value !== 'customer') payload.author_user_id = me.user.id;
          await api('POST', '/case-comments', payload);
          toast('Saved');
        }
        await viewDetail('cases', rec.id);
      } catch (err) { toast(errText(err), true); e.target.disabled = false; }
    } }, modes[0][0] === 'email' ? 'Send email' : 'Send');
    const sync = () => { const em = mode.value === 'email'; emailRow.hidden = !em; send.textContent = em ? 'Send email' : mode.value === 'internal' ? 'Add note' : 'Save'; };
    mode.addEventListener('change', sync);
    sync();
    const why = emailOk ? null
      : !emailOn ? 'Email is not set up yet. Turn it on in Settings to reply from here.'
      : !rec.contact_id ? 'Add a contact with an email address to reply by email.'
      : !contact?.email ? 'This contact has no email address, so a reply cannot be emailed.'
      : contact.do_not_contact ? 'This contact is marked Do Not Contact.' : null;
    composer = h('div', { style: 'margin-top:12px' }, body, emailRow, h('div', { class: 'inline', style: 'margin-top:8px' }, mode, send),
      why ? h('div', { class: 'muted', style: 'margin-top:6px;font-size:12px' }, why) : null);
  }
  const emailLog = emails.length ? related('Emails sent', h('div', { class: 'tablewrap' }, h('table', {}, h('tbody', {}, emails.map((m) => h('tr', {},
    h('td', { class: 'muted' }, fmtDateTime(m.sent_at || m.created_at)), h('td', {}, m.to_email), h('td', {}, m.subject),
    h('td', {}, h('span', { class: 'pill ' + (m.status === 'sent' ? 'ok' : m.status === 'failed' ? 'bad' : ''), title: m.error || null }, cap(m.status)))))))))
    : null;
  return h('div', {}, related('Conversation', h('div', {}, thread, composer)), emailLog);
}

// ---------- small shared pieces ----------
const nf = new Intl.NumberFormat();
const fmtDay = (iso) => { const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); };
const fmtMonth = (iso) => { const [y, m] = String(iso).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }); };
const minutesText = (m) => m == null ? 'None yet' : m < 90 ? `${m} min` : m < 2880 ? `${Math.round(m / 6) / 10} hours` : `${Math.round(m / 144) / 10} days`;
const pctText = (v) => v == null ? 'None yet' : v + '%';
const tile = (n, label, note) => h('div', { class: 'stat' }, h('div', { class: 'n' }, n), h('div', { class: 'l' }, label), note ? h('div', { class: 'l' }, note) : null);

const SVGNS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs, ...kids) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) e.setAttribute(k, v);
  for (const kid of kids.flat()) if (kid != null) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return e;
}

// Saves a table as a CSV file. Text that starts with = + - @ gets a leading quote so a spreadsheet never runs it as a formula.
function downloadCsv(name, cols, rows) {
  const esc = (v) => {
    let s = v == null ? '' : String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [cols.map((c) => esc(c[0])).join(','), ...rows.map((r) => cols.map((c) => esc(c[1](r))).join(','))];
  const url = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const csvButton = (name, cols, rows) => rows.length ? h('button', { class: 'small', onclick: () => downloadCsv(name, cols, rows) }, 'Download CSV') : null;

// Horizontal bars. One color, the value at the tip, the hover text carries the detail.
function barRows(rows, { value, label = (r) => r.label, fmt = (v) => nf.format(v), tip }) {
  if (!rows.length) return h('div', { class: 'muted' }, 'Nothing to show yet.');
  const max = Math.max(...rows.map(value), 0) || 1;
  return h('div', { class: 'bars' }, rows.map((r) => {
    const v = value(r);
    return h('div', { class: 'brow', title: tip ? tip(r) : null },
      h('div', { class: 'bl' }, label(r)),
      h('div', { class: 'bt' }, h('i', { style: `width:${v > 0 ? Math.max((v / max) * 100, 1.5) : 0}%` })),
      h('div', { class: 'bv' }, fmt(v)));
  }));
}

// Two lines over time. Direct values on hover, a legend underneath, and the numbers are in the CSV.
function trendChart(points, defs) {
  const W = 720, H = 240, L = 38, R = 16, T = 12, B = 28;
  const max = Math.max(1, ...points.flatMap((p) => defs.map((d) => p[d.key])));
  const top = Math.max(4, Math.ceil(max / 4) * 4);
  const x = (i) => L + (points.length < 2 ? (W - L - R) / 2 : (i * (W - L - R)) / (points.length - 1));
  const y = (v) => T + (H - T - B) * (1 - v / top);
  const step = points.length < 2 ? W - L - R : (W - L - R) / (points.length - 1);
  const kids = [];
  for (let i = 0; i <= 4; i++) {
    const v = (top / 4) * i;
    kids.push(svg('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'grid' }), svg('text', { x: L - 8, y: y(v) + 4, class: 'tick', 'text-anchor': 'end' }, nf.format(v)));
  }
  const labelAt = [0, Math.floor((points.length - 1) / 2), points.length - 1];
  [...new Set(labelAt)].forEach((i, n, arr) => kids.push(svg('text', { x: x(i), y: H - 8, class: 'tick', 'text-anchor': n === 0 ? 'start' : n === arr.length - 1 ? 'end' : 'middle' }, fmtDay(points[i].bucket))));
  for (const d of defs) {
    kids.push(svg('path', { d: points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[d.key]).toFixed(1)}`).join(' '), class: 'line ' + d.cls }));
    const last = points.length - 1;
    kids.push(svg('circle', { cx: x(last), cy: y(points[last][d.key]), r: 4, class: 'dot ' + d.cls }));
  }
  points.forEach((p, i) => kids.push(svg('rect', { x: x(i) - step / 2, y: T, width: step, height: H - T - B, class: 'hit' },
    svg('title', {}, `${fmtDay(p.bucket)}: ${defs.map((d) => `${p[d.key]} ${d.label.toLowerCase()}`).join(', ')}`))));
  return h('div', {},
    svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': defs.map((d) => d.label).join(' and ') + ' over time' }, kids),
    h('div', { class: 'legend' }, defs.map((d) => h('span', {}, h('i', { class: 'sw ' + d.cls }), d.label))));
}

const card = (title, body, action) => h('div', { class: 'card' }, h('div', { class: 'sectionhead' }, h('h2', {}, title), action || null), body);
function tableCard(title, cols, rows, csvName, empty) {
  const body = rows.length
    ? h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, cols.map((c) => h('th', {}, c[0])))),
        h('tbody', {}, rows.map((r) => h('tr', {}, cols.map((c) => h('td', {}, c[2] ? c[2](r) : c[1](r))))))))
    : h('div', { class: 'muted' }, empty || 'Nothing to show yet.');
  return card(title, body, csvButton(csvName, cols, rows));
}

// ---------- reports ----------
let reportDays = 30;
const RANGES = [[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days'], [365, 'Last 12 months']];

async function reportSupport() {
  const r = await api('GET', '/reports/support?days=' + reportDays);
  const t = r.totals;
  const per = r.unit === 'week' ? 'week' : 'day';
  return [
    h('div', { class: 'stats' },
      tile(nf.format(t.opened), 'Cases opened'), tile(nf.format(t.solved), 'Cases solved'),
      tile(nf.format(t.open_now), 'Open right now'), tile(nf.format(t.past_sla_now), 'Open and past an SLA target'),
      tile(pctText(t.first_response_met_pct), 'First response on time', 'Cases opened in this period'),
      tile(pctText(t.resolution_met_pct), 'Resolved on time', 'Cases opened in this period'),
      tile(minutesText(t.avg_first_response_minutes), 'Average first response'), tile(t.avg_resolution_hours == null ? 'None yet' : `${t.avg_resolution_hours} hours`, 'Average time to resolve')),
    card(`Opened and solved, by ${per}`, r.series.some((p) => p.opened || p.solved)
      ? trendChart(r.series, [{ key: 'opened', label: 'Opened', cls: 's1' }, { key: 'solved', label: 'Solved', cls: 's2' }])
      : h('div', { class: 'muted' }, 'No cases in this period.'),
      csvButton('cases-by-' + per + '.csv', [[per === 'week' ? 'Week starting' : 'Date', (p) => p.bucket], ['Opened', (p) => p.opened], ['Solved', (p) => p.solved]], r.series)),
    h('div', { class: 'cols2' },
      card('Opened, by priority', barRows(r.by_priority, { value: (x) => x.n, label: (x) => cap(x.label) })),
      card('Open cases, by status', barRows(r.by_status, { value: (x) => x.n, label: (x) => cap(x.label) }))),
    card('Open cases, by assignee', barRows(r.open_by_assignee, { value: (x) => x.n })),
  ];
}

async function reportPipeline() {
  const r = await api('GET', '/reports/pipeline?days=' + reportDays);
  const c = r.closed;
  return [
    h('div', { class: 'stats' },
      tile(money(r.open.amount) || '$0', 'Open pipeline', `${r.open.count} open ${r.open.count === 1 ? 'deal' : 'deals'}`),
      tile(money(r.open.weighted) || '$0', 'Weighted pipeline', 'Amount times probability'),
      tile(`${c.won_count} won`, money(c.won_amount) || '$0', 'By close date, this period'),
      tile(`${c.lost_count} lost`, money(c.lost_amount) || '$0', 'By close date, this period'),
      tile(pctText(c.win_rate_pct), 'Win rate', 'Won out of won and lost'),
      tile(c.avg_won_size == null ? 'None yet' : money(c.avg_won_size), 'Average deal won')),
    h('div', { class: 'cols2' },
      card('Open pipeline, by stage', barRows(r.open_by_stage, { value: (x) => x.amount, fmt: (v) => money(v) || '$0', tip: (x) => `${x.n} deals, ${money(x.weighted) || '$0'} weighted` }),
        csvButton('pipeline-by-stage.csv', [['Stage', (x) => x.label], ['Deals', (x) => x.n], ['Amount', (x) => x.amount], ['Weighted', (x) => x.weighted]], r.open_by_stage)),
      card('Expected close, by month', barRows(r.forecast_by_month, { value: (x) => x.amount, fmt: (v) => money(v) || '$0',
        label: (x) => x.past_due ? `${fmtMonth(x.month)} (past due)` : fmtMonth(x.month), tip: (x) => `${x.n} deals, ${money(x.weighted) || '$0'} weighted` }),
        csvButton('forecast-by-month.csv', [['Month', (x) => x.month.slice(0, 7)], ['Deals', (x) => x.n], ['Amount', (x) => x.amount], ['Weighted', (x) => x.weighted]], r.forecast_by_month))),
    h('div', { class: 'cols2' },
      card('Open pipeline, by owner', barRows(r.open_by_owner, { value: (x) => x.amount, fmt: (v) => money(v) || '$0', tip: (x) => `${x.n} deals, ${money(x.weighted) || '$0'} weighted` })),
      card('Why deals were lost', barRows(r.loss_reasons, { value: (x) => x.n }))),
    tableCard('Biggest open deals',
      [['Deal', (d) => d.name, (d) => h('a', { href: '#/deals/' + d.id }, d.name)], ['Account', (d) => d.account || ''], ['Stage', (d) => d.stage], ['Amount', (d) => d.amount, (d) => money(d.amount)], ['Expected close', (d) => d.close_date, (d) => fmtDate(d.close_date)]],
      r.top_open_deals, 'biggest-open-deals.csv', 'No open deals.'),
  ];
}

async function reportAccounts() {
  const r = await api('GET', '/reports/accounts');
  const t = r.totals;
  const ownerCol = ['Owner', (a) => a.owner || ''];
  return [
    h('div', { class: 'stats' },
      tile(nf.format(t.total), 'Accounts'), tile(nf.format(t.customers), 'Customers'),
      tile(t.avg_health == null ? 'None yet' : t.avg_health, 'Average health score'),
      tile(nf.format(t.at_risk), 'At risk (health under 40)'),
      tile(nf.format(r.customer_renewals_past_due), 'Customer renewals past due'),
      tile(nf.format(r.renewals_next_90_days.length), 'Renewals in the next 90 days')),
    h('div', { class: 'cols2' },
      card('Accounts, by health', barRows(r.health, { value: (x) => x.n })),
      card('Accounts, by type', barRows(r.by_type, { value: (x) => x.n, label: (x) => cap(x.label) }))),
    tableCard('At risk accounts',
      [['Account', (a) => a.name, (a) => h('a', { href: '#/accounts/' + a.id }, a.name)], ['Health', (a) => a.health_score, (a) => h('span', { class: 'pill bad' }, a.health_score)], ['Renewal', (a) => a.renewal_date || '', (a) => fmtDate(a.renewal_date)], ownerCol],
      r.at_risk, 'at-risk-accounts.csv', 'No accounts are at risk.'),
    tableCard('Renewals in the next 90 days',
      [['Account', (a) => a.name, (a) => h('a', { href: '#/accounts/' + a.id }, a.name)], ['Renewal', (a) => a.renewal_date, (a) => fmtDate(a.renewal_date)], ['Days left', (a) => a.days_left],
       ['Health', (a) => a.health_score ?? '', (a) => a.health_score == null ? '' : h('span', { class: 'pill ' + (a.health_score < 40 ? 'bad' : a.health_score < 70 ? 'warn' : 'ok') }, a.health_score)], ownerCol],
      r.renewals_next_90_days, 'renewals-next-90-days.csv', 'No renewals in the next 90 days.'),
  ];
}

const REPORT_TABS = [
  ['support', 'Support', () => can('case', 'read'), reportSupport, true],
  ['pipeline', 'Sales pipeline', () => can('opportunity', 'read'), reportPipeline, true],
  ['accounts', 'Accounts and renewals', () => can('account', 'read'), reportAccounts, false],
];

async function viewReports(tabKey) {
  const tabs = REPORT_TABS.filter((t) => t[2]());
  if (!tabs.length) return setView(h('div', { class: 'card empty' }, 'Your role does not include any reports.'));
  const tab = tabs.find((t) => t[0] === tabKey) || tabs[0];
  const body = h('div', {}, h('div', { class: 'muted' }, 'Loading…'));
  const range = selectOf(RANGES, String(reportDays), { blank: false });
  range.value = String(reportDays);
  if (range.selectedIndex < 0) range.selectedIndex = 1;
  range.addEventListener('change', () => { reportDays = Number(range.value); draw(); });
  async function draw() {
    body.replaceChildren(h('div', { class: 'muted' }, 'Loading…'));
    try { body.replaceChildren(...(await tab[3]())); }
    catch (e) { if (e.status === 401) return; body.replaceChildren(h('div', { class: 'banner' }, errText(e))); }
  }
  setView(
    h('div', { class: 'head' }, titled('reports', 'Reports'), h('div', { class: 'tools' }, tab[4] ? range : null)),
    h('div', { class: 'tabs' }, tabs.map((t) => h('a', { class: 'tab' + (t === tab ? ' on' : ''), href: '#/reports/' + t[0] }, t[1]))),
    body);
  await draw();
}

// ---------- settings ----------
const THEMES = [['system', 'Match my device'], ['light', 'Light'], ['dark', 'Dark']];
const STATUS_LABEL = { active: 'Active', invited: 'Invited', disabled: 'Turned off' };

const SETTINGS_TABS = [['general', 'General', () => true], ['people', 'People', () => can('app_user', 'read')], ['changelog', 'Change log', () => true]];

function releaseList(list) {
  return h('div', {}, list.map((r, i) => h('div', { class: 'release' },
    h('h3', {}, r.title, i === 0 && r.id === RELEASES[0].id ? h('span', { class: 'tag' }, 'Newest') : null),
    h('div', { class: 'when' }, 'Version ' + r.id + ' · ' + fmtDate(r.date)),
    h('ul', {}, r.items.map((t) => h('li', {}, t))))));
}

async function viewSettings(tabKey) {
  const ws = cache.workspace || { name: '', email: { configured: false } };
  const canEditUsers = can('app_user', 'edit');
  const tabs = SETTINGS_TABS.filter((t) => t[2]());
  const tab = (tabs.find((t) => t[0] === tabKey) || tabs[0])[0];
  const parts = [h('div', { class: 'head' }, h('h1', {}, 'Settings')),
    h('div', { class: 'tabs' }, tabs.map((t) => h('a', { class: 'tab' + (t[0] === tab ? ' on' : ''), href: '#/settings/' + t[0] }, t[1])))];

  if (tab === 'general') {
  // appearance
  const cur = getTheme();
  parts.push(card('Appearance', h('div', {},
    h('div', { class: 'radios' }, THEMES.map(([v, l]) =>
      h('label', { class: 'radio' }, h('input', { type: 'radio', name: 'theme', value: v, checked: v === cur, onchange: () => setTheme(v) }), l))),
    h('h2', { style: 'margin:16px 0 8px' }, 'Color'),
    h('div', { class: 'swatches' }, ACCENTS.map(([v, l]) =>
      h('label', { class: 'swatch' }, h('input', { type: 'radio', name: 'accent', value: v, checked: v === (prefs.accent || 'green'),
        onchange: async () => { applyAccent(v); try { await savePrefs({ accent: v }); } catch (e) { toast(errText(e), true); } } }),
        h('i', { class: 'sw-' + v }), l))))));

  // left menu order
  const menuList = h('div', { class: 'menuedit' });
  const drawMenu = () => {
    const list = navVisible();
    fill(menuList, list.map((n, i) => h('div', { class: 'menurow' }, icon(n.icon, 18), h('span', { class: 'grow' }, n.label),
      h('button', { class: 'small', disabled: i === 0, 'aria-label': `Move ${n.label} up`, onclick: () => { moveNav(n.key, -1); drawMenu(); } }, 'Up'),
      h('button', { class: 'small', disabled: i === list.length - 1, 'aria-label': `Move ${n.label} down`, onclick: () => { moveNav(n.key, 1); drawMenu(); } }, 'Down'))));
  };
  drawMenu();
  parts.push(card('Left menu', h('div', {},
    h('p', { class: 'muted', style: 'margin:0 0 10px' }, 'Put the pages you use most at the top. You can also drag items in the menu itself, or focus one and press Alt with the up or down arrow. The arrow button at the top of the menu collapses it to icons.'),
    menuList,
    h('div', { class: 'actions' }, h('button', { onclick: async () => { prefs = { ...prefs, nav_order: null }; drawNavList(); drawMenu(); try { await savePrefs({ nav_order: null }); } catch (e) { toast(errText(e), true); } } }, 'Back to the standard order')))));

  // welcome tour
  parts.push(card('Welcome tour', h('div', { class: 'inline' },
    h('p', { style: 'margin:0;flex:1;min-width:220px' }, 'A one minute walk through the main parts of Tally. Play it again any time.'),
    h('button', { onclick: () => runTour({ required: false }) }, 'Take the tour'))));

  // workspace
  const nameInput = h('input', { type: 'text', value: ws.name, disabled: !canEditUsers });
  const saveName = h('button', { class: 'primary', onclick: async (e) => {
    e.target.disabled = true;
    try { const r = await api('PATCH', '/settings/workspace', { name: nameInput.value }); cache.workspace = { ...ws, name: r.name }; toast('Saved'); }
    catch (err) { toast(errText(err), true); }
    e.target.disabled = false;
  } }, 'Save');
  parts.push(card('Workspace', h('div', { class: 'inline' }, h('label', { class: 'f', style: 'flex:1;min-width:220px' }, h('span', {}, 'Workspace name'), nameInput), canEditUsers ? saveName : null)));

  // email
  const emailBody = ws.email.configured
    ? h('div', {}, h('p', { style: 'margin-top:0' }, 'Email is on. Replies on a case go out from ', h('b', {}, ws.email.from), '.'),
        canEditUsers ? h('button', { onclick: async (e) => {
          e.target.disabled = true;
          try { const r = await api('POST', '/settings/email-test', {}); toast('Test email sent to ' + r.sent_to); }
          catch (err) { toast(errText(err), true); }
          e.target.disabled = false;
        } }, 'Send me a test email') : null)
    : h('div', {}, h('p', { style: 'margin-top:0' }, 'Email is not set up yet, so replies cannot be sent from a case.'),
        h('p', { class: 'muted', style: 'margin-bottom:0' }, 'To turn it on, add two settings in Render under Environment: RESEND_API_KEY and EMAIL_FROM. Then come back here and send yourself a test.'));
  parts.push(card('Email', emailBody));
  }

  // users
  if (tab === 'people' && can('app_user', 'read')) {
    const wrap = h('div', {}, h('div', { class: 'muted' }, 'Loading…'));
    parts.push(card('People', wrap, canEditUsers ? h('button', { class: 'small primary', onclick: () => invite() }, 'Invite someone') : null));
    parts.push(h('p', { class: 'muted', style: 'margin-top:-6px' }, ws.signin?.google
      ? 'People sign in with Google, using the email address you add here. Anyone not on this list cannot get in.' + (ws.signin.key ? ' The shared access key still works as a backup, so remove it from Render once you no longer need it.' : '')
      : 'Everyone signs in with the shared access key for now, so only add people you trust with it. Google sign in is the next step.'));
    let roles = [];
    const draw = async () => {
      const [users, rl] = await Promise.all([api('GET', '/settings/users').then((r) => r.data), can('role', 'read') ? api('GET', '/settings/roles').then((r) => r.data) : []]);
      roles = rl;
      wrap.replaceChildren(h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Name', 'Email', 'Role', 'Status', ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, users.map((u) => {
          const mine = u.id === me.user.id;
          const roleCell = canEditUsers && !mine && roles.length
            ? (() => { const s = selectOf(roles.map((r) => [r.id, r.name]), u.role_id, { blank: false }); s.addEventListener('change', () => patch(u, { role_id: s.value }, s)); return s; })()
            : (u.role_name || '');
          return h('tr', {},
            h('td', {}, u.display_name, mine ? h('span', { class: 'muted' }, ' (you)') : null), h('td', { class: 'muted' }, u.email), h('td', {}, roleCell),
            h('td', {}, h('span', { class: 'pill ' + (u.status === 'active' ? 'ok' : u.status === 'disabled' ? 'bad' : '') }, STATUS_LABEL[u.status] || u.status)),
            h('td', { style: 'text-align:right' }, canEditUsers && !mine ? h('button', { class: 'small', onclick: () => patch(u, { status: u.status === 'disabled' ? 'active' : 'disabled' }) }, u.status === 'disabled' ? 'Turn on' : 'Turn off') : null));
        })))));
    };
    async function patch(u, change, control) {
      try { await api('PATCH', '/settings/users/' + u.id, { version: u.version, ...change }); toast('Saved'); cache.users = (await api('GET', '/users')).data; }
      catch (e) { toast(errText(e), true); }
      await draw();
    }
    function invite() {
      const name = h('input', { type: 'text', placeholder: 'Full name' });
      const email = h('input', { type: 'email', placeholder: 'name@company.com' });
      const role = selectOf(roles.map((r) => [r.id, r.name]), roles.find((r) => r.name === 'Read Only')?.id, { blank: false });
      modal('Invite someone', h('div', { class: 'grid2', style: 'grid-template-columns:1fr' },
        h('label', { class: 'f' }, h('span', {}, 'Name'), name), h('label', { class: 'f' }, h('span', {}, 'Email'), email), h('label', { class: 'f' }, h('span', {}, 'Role'), role)), [
        { label: 'Cancel' },
        { label: 'Invite', primary: true, run: async (dlg) => {
          await api('POST', '/settings/users', { display_name: name.value, email: email.value, role_id: role.value });
          dlg.close(); toast('Added'); cache.users = (await api('GET', '/users')).data; await draw();
        } },
      ]);
    }
    draw().catch((e) => wrap.replaceChildren(h('div', { class: 'banner' }, errText(e))));
  }

  if (tab === 'changelog') parts.push(h('div', { class: 'card' }, releaseList(RELEASES)));
  setView(parts);
}

// ---------- welcome tour and what's new ----------
const TOUR = [
  { title: 'Welcome to Tally', text: ['This is one place for your customers, your deals, and your support cases.', 'The tour takes about a minute.'] },
  { title: 'Accounts and contacts', target: '#/accounts', text: ['Accounts are the companies you work with. Contacts are the people at those companies.', 'Open any record to see everything about it in one place.'] },
  { title: 'Deals', target: '#/deals', text: ['Deals are the sales you are working on.', 'Drag a deal from one stage to the next as it moves along.'] },
  { title: 'Cases', target: '#/cases', text: ['Cases are customer questions and problems. Each one has a clock for the first reply and for solving it.', 'You can reply to the customer by email from inside the case once email is turned on.'] },
  { title: 'Reports', target: '#/reports', text: ['Reports show how support and sales are doing.', 'Every report has a Download CSV button if you want the numbers in a spreadsheet.'] },
  { title: 'Settings', target: '#/settings', text: ['The gear at the bottom left opens Settings.', 'Pick your color, switch between light and dark, add people, replay this tour, and read the Change log.'] },
  { title: 'You are all set', text: ['That is everything. Click around, nothing here can break.', 'When something new is added, you will see a short note about it the next time you sign in.'] },
];

// Walks through the tour in a pop up. When required, there is no way out until the last step.
function runTour({ required }) {
  const steps = TOUR.filter((t) => !t.target || document.querySelector(`[data-nav="${t.target}"]`));
  let i = 0;
  return new Promise((resolve) => {
    const body = h('div', { class: 'tourstep' });
    const dots = h('div', { class: 'tourdots' });
    const back = h('button', { type: 'button', onclick: () => { i--; draw(); } }, 'Back');
    const next = h('button', { type: 'button', class: 'primary', onclick: () => { if (i === steps.length - 1) return finish(true); i++; draw(); } }, 'Next');
    const close = required ? null : h('button', { type: 'button', onclick: () => finish(false) }, 'Close');
    const dlg = h('dialog', { class: 'tour', 'aria-label': 'Welcome tour' }, h('div', { class: 'db' }, body), h('div', { class: 'df' }, dots, close, back, next));
    const clearHl = () => document.querySelectorAll('.tourhl').forEach((n) => n.classList.remove('tourhl'));
    function draw() {
      const st = steps[i];
      body.replaceChildren(h('h3', {}, st.title), ...st.text.map((t) => h('p', {}, t)));
      dots.replaceChildren(...steps.map((_, k) => h('i', { class: k === i ? 'on' : '' })));
      back.hidden = i === 0;
      next.textContent = i === steps.length - 1 ? 'Finish' : 'Next';
      clearHl();
      if (st.target) document.querySelector(`[data-nav="${st.target}"]`)?.classList.add('tourhl');
    }
    let done = false;
    function finish(ok) { if (done) return; done = true; clearHl(); dlg.close(); dlg.remove(); resolve(ok); }
    if (required) dlg.addEventListener('cancel', (e) => e.preventDefault()); // Esc does nothing on the first tour
    else dlg.addEventListener('cancel', () => finish(false));
    document.body.append(dlg);
    draw();
    dlg.showModal();
  });
}

const unseenReleases = () => {
  const i = RELEASES.findIndex((r) => r.id === prefs.last_seen_release);
  return i === -1 ? RELEASES : RELEASES.slice(0, i);
};

// Shows the notes for anything shipped since the last time this person looked. Closing it in any way counts as seen.
function showWhatsNew(list) {
  let saved = false;
  const markSeen = async () => { if (saved) return; saved = true; try { await savePrefs({ last_seen_release: RELEASES[0].id }); } catch { /* shown again next time */ } };
  const dlg = modal("What's new", releaseList(list), [
    { label: 'Take the tour', run: async (d) => { d.close(); await runTour({ required: false }); } },
    { label: 'Got it', primary: true },
  ]);
  dlg.addEventListener('close', markSeen);
}

// Runs once after sign in. The first tour cannot be skipped. After that, new updates show once.
async function welcome() {
  if (!prefs.tour_done_at) {
    await runTour({ required: true });
    try { await savePrefs({ tour_done: true, last_seen_release: RELEASES[0].id }); } catch (e) { toast(errText(e), true); }
    return;
  }
  const list = unseenReleases();
  if (list.length) showWhatsNew(list);
}

// ---------- shell, sign in, routing ----------
const LOGIN_ERRORS = {
  not_invited: 'That Google account has not been added to Tally yet. Ask an admin to add your email under Settings, People.',
  disabled: 'This account has been turned off. Ask an admin to turn it back on.',
  unverified: 'Google says that email address is not verified, so it cannot be used to sign in.',
  cancelled: 'Google sign in was cancelled.',
  failed: 'Google sign in did not work. Please try again.',
};

async function renderLogin(msg) {
  const cfg = await fetch('/v1/auth/config').then((r) => r.json()).catch(() => ({ google: false, key: true }));
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
  const keyForm = h('div', {},
    h('form', { class: 'card', onsubmit: go }, h('h1', { style: 'margin-bottom:12px' }, cfg.google ? 'Use the access key' : 'Sign in'), cfg.google ? null : err,
      h('div', { class: 'grid2', style: 'grid-template-columns:1fr' },
        h('label', { class: 'f' }, h('span', {}, 'Email'), email), h('label', { class: 'f' }, h('span', {}, 'Access key'), key)),
      h('div', { class: 'actions' }, btn)),
    h('details', { class: 'muted', style: 'margin-top:8px' }, h('summary', {}, 'Have an access token instead?'),
      h('div', { style: 'margin-top:8px' }, pasted, h('div', { class: 'actions' }, h('button', { type: 'button', onclick: async () => {
        const t = pasted.value.trim().replace(/^Bearer\s+/i, ''); if (!t) return pasted.focus();
        try { await enter(t); } catch (x) { fail(x.status === 401 ? 'That token was not accepted. It may have expired.' : errText(x)); }
      } }, 'Use token')))));
  const googleCard = () => h('div', { class: 'card' }, h('h1', { style: 'margin-bottom:12px' }, 'Sign in'), err,
    h('a', { class: 'btn primary wide', href: '/v1/auth/google/start' }, 'Sign in with Google'),
    h('p', { class: 'muted', style: 'margin:12px 0 0' }, 'Use the Google account for the email address you were invited with.'));
  // Built only when needed: an element can sit in one place, and err is shared by whichever card is shown.
  const nothing = () => h('div', { class: 'card' }, h('h1', { style: 'margin-bottom:12px' }, 'Sign in'), err, h('p', { class: 'muted', style: 'margin:0' }, 'No way to sign in is turned on for this server yet.'));
  $('#app').replaceChildren(h('div', { class: 'login' },
    h('div', { class: 'brand', style: 'padding-left:0' }, logoMark(26), 'Tally'),
    cfg.google ? googleCard() : null,
    cfg.google && cfg.key ? h('details', { style: 'margin-top:12px' }, h('summary', { class: 'muted' }, 'Use the shared access key instead'), h('div', { style: 'margin-top:8px' }, keyForm)) : null,
    !cfg.google && cfg.key ? keyForm : null,
    !cfg.google && !cfg.key ? nothing() : null));
}
function signOut() { token = ''; me = null; prefs = { accent: null, tour_done_at: null, last_seen_release: null, nav_order: null, nav_collapsed: false }; localStorage.removeItem(TOKEN_KEY); renderLogin(); }

function gearIcon() {
  return svg('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
    svg('circle', { cx: 12, cy: 12, r: 3 }),
    svg('path', { d: 'M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z' }));
}


// ---------- CSV: export and import ----------
function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const rows = []; let row = [], f = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else inQ = false; } else f += c; }
    else if (c === '"') inQ = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); f = ''; rows.push(row); row = []; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

// What a person expects to see in a spreadsheet cell for each kind of field.
function exportValue(f, r) {
  const v = r[f.k];
  switch (f.t) {
    case 'user': return userName(v);
    case 'account': return cache.accounts.find((a) => a.id === v)?.name || '';
    case 'contact': { const c = cache.contacts.find((x) => x.id === v); return c ? ENT.contacts.title(c) : ''; }
    case 'stage': return stageOf(v)?.name || '';
    case 'assignee': return r.owner_user_id ? userName(r.owner_user_id) : (cache.queues.find((x) => x.id === r.queue_id)?.name || '');
    case 'bool': return v ? 'yes' : 'no';
    case 'select': return v ?? '';
    default: return v ?? '';
  }
}
function exportList(key, rows) {
  const ent = ENT[key];
  const cols = [...ent.fields.map((f) => [f.l, (r) => exportValue(f, r)]), ['Created', (r) => String(r.created_at || '').slice(0, 10)]];
  const day = new Date().toISOString().slice(0, 10);
  downloadCsv(`tally-${key}-${day}.csv`, cols, rows);
}
const exportButton = (key, getRows) => h('button', { class: 'small', onclick: () => {
  const rows = getRows();
  if (!rows.length) return toast('Nothing to download yet', true);
  exportList(key, rows);
} }, 'Download CSV');

// Other names people use for the same column in a spreadsheet.
const IMPORT_ALIASES = {
  accounts: { name: ['accountname', 'company', 'companyname', 'organization'], domain: ['website domain'], annual_revenue: ['revenue'], number_of_employees: ['employees', 'employeecount', 'size'], description: ['notes', 'note', 'description'], owner_user_id: ['owner', 'accountowner', 'owneremail'] },
  contacts: { last_name: ['lastname', 'surname', 'last'], first_name: ['firstname', 'first', 'givenname'], email: ['emailaddress', 'mail'], title: ['jobtitle', 'position'], account_id: ['account', 'accountname', 'company', 'companyname'], owner_user_id: ['owner', 'contactowner', 'owneremail'], description: ['notes', 'note'] },
};
const normHead = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
function matchColumns(key, headers) {
  const ent = ENT[key];
  const aliases = IMPORT_ALIASES[key] || {};
  const used = new Set();
  return headers.map((hd) => {
    const n = normHead(hd);
    const f = ent.fields.find((x) => !used.has(x.k) && (normHead(x.k) === n || normHead(x.l) === n || (aliases[x.k] || []).map(normHead).includes(n)));
    if (f) used.add(f.k);
    return f || null;
  });
}
// Turns one cell into the value the server expects, or says what is wrong with it.
function coerceCell(f, raw) {
  let s = String(raw ?? '').trim();
  if (s === '') return { skip: true };
  if (/^'[=+\-@]/.test(s)) s = s.slice(1); // undo the guard our own export adds against spreadsheet formulas
  switch (f.t) {
    case 'number': {
      const n = Number(s.replace(/[$,\s]/g, ''));
      return Number.isFinite(n) ? { value: n } : { error: `${f.l} must be a number` };
    }
    case 'date': {
      const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s), us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
      const [y, m, d] = iso ? [+iso[1], +iso[2], +iso[3]] : us ? [+us[3], +us[1], +us[2]] : [];
      const dt = y ? new Date(y, m - 1, d) : null;
      if (!dt || dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return { error: `${f.l} must be a date like 2026-12-31 or 12/31/2026` };
      return { value: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` };
    }
    case 'bool': {
      const v = s.toLowerCase();
      if (['yes', 'y', 'true', '1'].includes(v)) return { value: true };
      if (['no', 'n', 'false', '0'].includes(v)) return { value: false };
      return { error: `${f.l} must be yes or no` };
    }
    case 'select': {
      const v = s.toLowerCase();
      return f.opts.includes(v) ? { value: v } : { error: `${f.l} must be one of: ${f.opts.join(', ')}` };
    }
    case 'user': {
      const v = s.toLowerCase();
      const u = cache.users.find((x) => x.email.toLowerCase() === v || x.display_name.toLowerCase() === v);
      return u ? { value: u.id } : { error: `Owner "${s}" is not a person in Tally. Use their email` };
    }
    case 'account': {
      const a = cache.accounts.find((x) => x.name.toLowerCase() === s.toLowerCase());
      return a ? { value: a.id } : { error: `Account "${s}" was not found. Import accounts first` };
    }
    default:
      if (f.k === 'email') return { value: s.toLowerCase() };
      if (f.k === 'domain') return { value: s.toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '') };
      return { value: s };
  }
}
function planImport(key, table) {
  const ent = ENT[key];
  const [head, ...data] = table;
  const map = matchColumns(key, head);
  const problems = [], rows = [];
  const mappedKeys = map.filter(Boolean).map((f) => f.k);
  for (const f of ent.fields.filter((x) => x.req)) if (!mappedKeys.includes(f.k)) problems.push(`There is no "${f.l}" column. It is required`);
  data.forEach((cells, i) => {
    const out = {};
    map.forEach((f, c) => {
      if (!f) return;
      const r = coerceCell(f, cells[c]);
      if (r.error) problems.push(`Row ${i + 2}: ${r.error}`);
      else if (!r.skip) out[f.k] = r.value;
    });
    for (const f of ent.fields.filter((x) => x.req)) if (mappedKeys.includes(f.k) && out[f.k] === undefined && !problems.some((p) => p.startsWith(`Row ${i + 2}:`))) problems.push(`Row ${i + 2}: ${f.l} is empty`);
    rows.push(out);
  });
  return { map, head, rows, problems };
}
function openImport(key) {
  const ent = ENT[key];
  let plan = null;
  const info = h('div', { class: 'muted', style: 'margin-top:10px' }, 'Pick a CSV file. The first row must be the column names.');
  const skip = h('input', { type: 'checkbox' });
  const file = h('input', { type: 'file', accept: '.csv,text/csv' });
  const template = h('a', { href: '#', onclick: (e) => { e.preventDefault(); downloadCsv(`tally-${key}-template.csv`, ent.fields.map((f) => [f.l, () => '']), []); } }, 'Download a blank template');
  file.addEventListener('change', async () => {
    plan = null;
    const f = file.files[0];
    if (!f) return;
    if (f.size > 2_000_000) { info.replaceChildren('That file is too large. Keep it under 2 MB.'); return; }
    const table = parseCsv(await f.text());
    if (table.length < 2) { info.replaceChildren('That file has no rows to import.'); return; }
    plan = planImport(key, table);
    const matched = plan.map.map((m, i) => [plan.head[i], m]);
    info.replaceChildren(
      h('div', {}, h('b', {}, `${plan.rows.length} row${plan.rows.length === 1 ? '' : 's'}`), plan.rows.length > 500 ? h('span', { class: 'pill bad', style: 'margin-left:8px' }, 'Over 500. Split the file') : null),
      h('table', { style: 'margin-top:8px' }, h('tbody', {}, matched.map(([col, m]) => h('tr', {}, h('td', {}, col), h('td', { class: 'muted' }, '→'), h('td', {}, m ? m.l : h('span', { class: 'muted' }, 'Ignored (no matching field)')))))),
      plan.problems.length ? h('div', { class: 'banner', style: 'margin-top:10px' }, h('b', {}, `${plan.problems.length} problem${plan.problems.length === 1 ? '' : 's'} to fix in the file:`),
        h('ul', { style: 'margin:6px 0 0 18px;padding:0' }, plan.problems.slice(0, 10).map((p) => h('li', {}, p))), plan.problems.length > 10 ? h('div', {}, `and ${plan.problems.length - 10} more`) : null) : h('div', { class: 'pill ok', style: 'margin-top:10px' }, 'Looks good'));
  });
  modal(`Import ${ent.label.toLowerCase()} from CSV`, h('div', {}, file, h('div', { style: 'margin-top:6px' }, template),
    info, h('label', { class: 'inline', style: 'margin-top:12px;gap:8px' }, skip, 'Skip rows that already exist (same ' + (key === 'accounts' ? 'domain' : 'email') + ')')), [
    { label: 'Cancel' },
    { label: 'Import', primary: true, run: async (dlg) => {
      if (!plan) throw new ApiErr(400, { message: 'Choose a CSV file first' });
      if (plan.problems.length) throw new ApiErr(400, { message: 'Fix the problems listed, then choose the file again' });
      if (plan.rows.length > 500) throw new ApiErr(400, { message: 'Import up to 500 rows at a time. Split the file in parts' });
      let res;
      try { res = await api('POST', `/${ent.path}/import`, { rows: plan.rows, skip_duplicates: skip.checked }); }
      catch (e) {
        const list = e.details?.errors;
        if (list) throw new ApiErr(422, { message: `${e.message}. ` + list.slice(0, 5).map((x) => `Row ${x.row + 1}: ${x.message}`).join('. ') });
        throw e;
      }
      dlg.close();
      await refreshRef(key);
      toast(`Imported ${res.created} ${(res.created === 1 ? ent.one : ent.label).toLowerCase()}` + (res.skipped ? `, skipped ${res.skipped} that already existed` : ''));
      await route();
    } },
  ]);
}

// ---------- my tasks ----------
const relatedLink = (a, names) => {
  if (a.case_id) return ['Case', '#/cases/' + a.case_id, names.cases.get(a.case_id)];
  if (a.opportunity_id) return ['Deal', '#/deals/' + a.opportunity_id, names.deals.get(a.opportunity_id)];
  if (a.contact_id) { const c = cache.contacts.find((x) => x.id === a.contact_id); return ['Contact', '#/contacts/' + a.contact_id, c ? ENT.contacts.title(c) : '']; }
  if (a.account_id) return ['Account', '#/accounts/' + a.account_id, cache.accounts.find((x) => x.id === a.account_id)?.name || ''];
  return null;
};
async function viewTasks() {
  const mine = await listAll(`/activities?type=task&owner_user_id=${me.user.id}`);
  const names = { cases: new Map(), deals: new Map() };
  const [cs, ds] = await Promise.all([
    mine.some((a) => a.case_id) && can('case', 'read') ? listAll('/cases') : [],
    mine.some((a) => a.opportunity_id) && can('opportunity', 'read') ? listAll('/opportunities') : [],
  ]);
  cs.forEach((c) => names.cases.set(c.id, ENT.cases.title(c)));
  ds.forEach((d) => names.deals.set(d.id, d.name));
  let showDone = false;
  const body = h('div');
  const row = (a) => {
    const rel = relatedLink(a, names);
    return h('tr', {},
      h('td', { style: 'width:28px' }, can('activity', 'edit') ? h('input', { type: 'checkbox', checked: !!a.completed_at, title: a.completed_at ? 'Mark not done' : 'Mark done',
        onchange: async (e) => {
          try {
            const next = await api('PATCH', '/activities/' + a.id, { version: a.version, completed_at: e.target.checked ? new Date().toISOString() : null });
            mine[mine.findIndex((x) => x.id === a.id)] = next; draw();
          } catch (err) { toast(errText(err), true); e.target.checked = !e.target.checked; }
        } }) : null),
      h('td', { style: a.completed_at ? 'text-decoration:line-through;color:var(--muted)' : '' }, a.subject),
      h('td', { class: 'muted' }, rel ? h('a', { href: rel[1] }, rel[2] ? `${rel[0]}: ${rel[2]}` : rel[0]) : ''),
      h('td', {}, a.completed_at ? h('span', { class: 'muted' }, 'done ' + fmtDateTime(a.completed_at)) : a.due_at ? [dueBadge(a.due_at, false), ' ', h('span', { class: 'muted' }, fmtDateTime(a.due_at))] : ''));
  };
  const draw = () => {
    const open = mine.filter((a) => !a.completed_at).sort((a, b) => (a.due_at || '9').localeCompare(b.due_at || '9'));
    const t0 = new Date(); t0.setHours(0, 0, 0, 0);
    const t1 = new Date(t0); t1.setDate(t1.getDate() + 1);
    const groups = [['Overdue', open.filter((a) => a.due_at && new Date(a.due_at) < t0)],
      ['Today', open.filter((a) => a.due_at && new Date(a.due_at) >= t0 && new Date(a.due_at) < t1)],
      ['Later', open.filter((a) => a.due_at && new Date(a.due_at) >= t1)],
      ['No due date', open.filter((a) => !a.due_at)]];
    const done = mine.filter((a) => a.completed_at).sort((a, b) => b.completed_at.localeCompare(a.completed_at)).slice(0, 30);
    const section = (title, list) => list.length ? h('div', { class: 'card tablewrap', style: 'margin-bottom:14px' },
      h('div', { style: 'padding:14px 16px 4px' }, h('h2', {}, `${title} (${list.length})`)), h('table', {}, h('tbody', {}, list.map(row)))) : null;
    body.replaceChildren(...[
      ...groups.map(([t, l]) => section(t, l)),
      open.length ? null : h('div', { class: 'card empty' }, mine.length ? 'You are all caught up.' : 'No tasks yet. Open any account, contact, deal or case, pick Task under Activity, and add one.'),
      showDone ? section('Done recently', done) : null].filter(Boolean));
  };
  const toggle = h('input', { type: 'checkbox', onchange: (e) => { showDone = e.target.checked; draw(); } });
  setView(h('div', { class: 'head' }, titled('tasks', 'My tasks'), h('label', { class: 'inline', style: 'gap:8px' }, toggle, 'Show done')), body);
  draw();
}

// ---------- icons: a small set drawn for Tally, one for each kind of record ----------
const ICONS = {
  home: [['path', { d: 'M4 11l8-7 8 7' }], ['path', { d: 'M6 10v9a1 1 0 0 0 1 1h3.5v-5h3v5H17a1 1 0 0 0 1-1v-9' }]],
  tasks: [['rect', { x: 4, y: 4, width: 16, height: 16, rx: 4 }], ['path', { d: 'M8.5 12.5l2.5 2.5 4.5-5.5' }]],
  accounts: [['path', { d: 'M5 20V6a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v14' }], ['path', { d: 'M15 10h3a1 1 0 0 1 1 1v9' }], ['path', { d: 'M3 20h18' }], ['path', { d: 'M8.5 9h3M8.5 12.5h3M8.5 16h3' }]],
  contacts: [['circle', { cx: 12, cy: 8.5, r: 3.5 }], ['path', { d: 'M5 20c.6-3.6 3.4-5.5 7-5.5s6.4 1.9 7 5.5' }]],
  deals: [['path', { d: 'M3.5 4.5h8l9 9a1.5 1.5 0 0 1 0 2.1l-5 5a1.5 1.5 0 0 1-2.1 0L3.5 10.7z' }], ['circle', { cx: 8, cy: 9, r: 1.3 }]],
  cases: [['circle', { cx: 12, cy: 12, r: 8.5 }], ['circle', { cx: 12, cy: 12, r: 3.5 }], ['path', { d: 'M6 6l3.5 3.5M18 6l-3.5 3.5M6 18l3.5-3.5M18 18l-3.5-3.5' }]],
  reports: [['path', { d: 'M4 4v16h16' }], ['rect', { x: 8, y: 11, width: 3, height: 6, rx: .8 }], ['rect', { x: 13.5, y: 7, width: 3, height: 10, rx: .8 }]],
  note: [['path', { d: 'M6.5 3.5H15l4 4V19a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19V5a1.5 1.5 0 0 1 1.5-1.5z' }], ['path', { d: 'M15 3.5V8h4' }], ['path', { d: 'M8.5 12.5h7M8.5 16h5' }]],
  chat: [['path', { d: 'M5 5h14a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 17h-8l-4.5 3.5V17H5a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 5 5z' }]],
  search: [['circle', { cx: 11, cy: 11, r: 6.5 }], ['path', { d: 'M16 16l4 4' }]],
  panel: [['rect', { x: 3.5, y: 4.5, width: 17, height: 15, rx: 2.5 }], ['path', { d: 'M9.5 4.5v15' }]],
  logout: [['path', { d: 'M9 4H6.5A1.5 1.5 0 0 0 5 5.5v13A1.5 1.5 0 0 0 6.5 20H9' }], ['path', { d: 'M14 8l4 4-4 4M18 12H9' }]],
  grip: [['circle', { cx: 9, cy: 7, r: 1.2 }], ['circle', { cx: 15, cy: 7, r: 1.2 }], ['circle', { cx: 9, cy: 12, r: 1.2 }], ['circle', { cx: 15, cy: 12, r: 1.2 }], ['circle', { cx: 9, cy: 17, r: 1.2 }], ['circle', { cx: 15, cy: 17, r: 1.2 }]],
};
// replaceChildren does not flatten lists, so every list of nodes goes through here.
const fill = (el, ...nodes) => el.replaceChildren(...nodes.flat(Infinity).filter((n) => n != null && n !== false));
function icon(name, size = 18) {
  return svg('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'ico' },
    (ICONS[name] || []).map(([t, a]) => svg(t, a)));
}
const titled = (name, text) => h('h1', { class: 'titled' }, icon(name, 22), text);

// The Tally mark takes the person's color, so it changes when they pick a new one.
function logoMark(size = 24) {
  return svg('svg', { viewBox: '0 0 64 64', width: size, height: size, class: 'logo', role: 'img', 'aria-label': 'Tally' },
    svg('rect', { class: 'lg-bg', width: 64, height: 64, rx: 14 }),
    svg('g', { class: 'lg-fg' }, svg('rect', { x: 15, y: 14, width: 34, height: 11, rx: 4 }), svg('rect', { x: 26.5, y: 14, width: 11, height: 22, rx: 4 }), svg('circle', { cx: 32, cy: 47, r: 5.5 })));
}

// ---------- left menu: order and collapsed state belong to each person ----------
const NAV = [
  { key: 'home', href: '#/', label: 'Home', icon: 'home', show: () => true },
  { key: 'tasks', href: '#/tasks', label: 'My tasks', icon: 'tasks', show: () => can('activity', 'read') },
  { key: 'accounts', href: '#/accounts', label: 'Accounts', icon: 'accounts', show: () => can('account', 'read') },
  { key: 'contacts', href: '#/contacts', label: 'Contacts', icon: 'contacts', show: () => can('contact', 'read') },
  { key: 'deals', href: '#/deals', label: 'Deals', icon: 'deals', show: () => can('opportunity', 'read') },
  { key: 'cases', href: '#/cases', label: 'Cases', icon: 'cases', show: () => can('case', 'read') },
  { key: 'reports', href: '#/reports', label: 'Reports', icon: 'reports', show: () => can('case', 'read') || can('opportunity', 'read') || can('account', 'read') },
];
function navOrdered() {
  const saved = Array.isArray(prefs.nav_order) ? prefs.nav_order : [];
  const rank = (k) => { const i = saved.indexOf(k); return i < 0 ? 1000 + NAV.findIndex((n) => n.key === k) : i; };
  return [...NAV].sort((a, b) => rank(a.key) - rank(b.key));
}
const navVisible = () => navOrdered().filter((n) => n.show());
let navCollapsed = false;
function setCollapsed(v, save = true) {
  navCollapsed = v;
  document.querySelector('.shell')?.classList.toggle('collapsed', v);
  const b = $('#navtoggle');
  if (b) { b.title = v ? 'Expand menu' : 'Collapse menu'; b.setAttribute('aria-label', b.title); b.setAttribute('aria-expanded', String(!v)); }
  try { localStorage.setItem('crm_nav_collapsed', v ? '1' : '0'); } catch { /* private window */ }
  if (save) savePrefs({ nav_collapsed: v }).catch(() => {});
}
function markNav() {
  const section = (location.hash || '#/').split('/')[1] || '';
  document.querySelectorAll('[data-nav]').forEach((n) => n.classList.toggle('on', n.dataset.nav === '#/' + section || (section === '' && n.dataset.nav === '#/')));
}
function saveNavOrder(keys) {
  prefs = { ...prefs, nav_order: keys };
  drawNavList();
  savePrefs({ nav_order: keys }).catch((e) => toast(errText(e), true));
}
function moveNav(key, delta) {
  const keys = navVisible().map((n) => n.key);
  const i = keys.indexOf(key), j = i + delta;
  if (i < 0 || j < 0 || j >= keys.length) return false;
  [keys[i], keys[j]] = [keys[j], keys[i]];
  saveNavOrder(keys);
  return true;
}
function dropNav(dragKey, targetKey, after) {
  const keys = navVisible().map((n) => n.key).filter((k) => k !== dragKey);
  const t = keys.indexOf(targetKey);
  if (t < 0 || dragKey === targetKey) return;
  keys.splice(after ? t + 1 : t, 0, dragKey);
  saveNavOrder(keys);
}
function navItem(n) {
  const a = h('a', { class: 'item', href: n.href, 'data-nav': n.href, 'data-key': n.key, title: n.label, draggable: 'true' },
    icon(n.icon, 18), h('span', { class: 'lbl' }, n.label), h('span', { class: 'grip', 'aria-hidden': 'true' }, icon('grip', 14)));
  a.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', n.key); e.dataTransfer.effectAllowed = 'move'; a.classList.add('dragging'); });
  a.addEventListener('dragend', () => { a.classList.remove('dragging'); document.querySelectorAll('.drop-before,.drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after')); });
  a.addEventListener('dragover', (e) => {
    e.preventDefault(); e.dataTransfer.dropEffect = 'move';
    const r = a.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
    a.classList.toggle('drop-after', after); a.classList.toggle('drop-before', !after);
  });
  a.addEventListener('dragleave', () => a.classList.remove('drop-before', 'drop-after'));
  a.addEventListener('drop', (e) => {
    e.preventDefault();
    const r = a.getBoundingClientRect();
    a.classList.remove('drop-before', 'drop-after');
    dropNav(e.dataTransfer.getData('text/plain'), n.key, e.clientY > r.top + r.height / 2);
  });
  // Keyboard: Alt plus the up or down arrow moves the focused item.
  a.addEventListener('keydown', (e) => {
    if (!e.altKey || !['ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    if (moveNav(n.key, e.key === 'ArrowUp' ? -1 : 1)) document.querySelector(`.navlist a[data-key="${n.key}"]`)?.focus();
  });
  return a;
}
function drawNavList() {
  const list = $('.navlist');
  if (!list) return;
  fill(list, navVisible().map(navItem));
  markNav();
}

// ---------- search: one box at the top, with a live results panel ----------
const SEARCH_TYPES = {
  accounts: { one: 'Account', many: 'Accounts', icon: 'accounts', perm: 'account', hint: 'Names, websites and notes' },
  contacts: { one: 'Contact', many: 'Contacts', icon: 'contacts', perm: 'contact', hint: 'Names, emails, titles and notes' },
  deals: { one: 'Deal', many: 'Deals', icon: 'deals', perm: 'opportunity', hint: 'Names, next steps and notes' },
  cases: { one: 'Case', many: 'Cases', icon: 'cases', perm: 'case', hint: 'Subjects, descriptions and case numbers' },
  activities: { one: 'Activity', many: 'Tasks and notes', icon: 'note', perm: 'activity', hint: 'Tasks, calls, meetings and notes' },
  replies: { one: 'Case reply', many: 'Case replies', icon: 'chat', perm: 'case_comment', hint: 'Messages written on cases' },
};
const searchTypes = () => Object.entries(SEARCH_TYPES).filter(([, t]) => can(t.perm, 'read'));
function highlight(text, terms) {
  const t = [...terms].filter(Boolean).sort((a, b) => b.length - a.length).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!t.length) return [String(text)];
  return String(text).split(new RegExp('(' + t.join('|') + ')', 'ig')).map((part, i) => i % 2 ? h('mark', {}, part) : part);
}
function resultRow(key, r, terms) {
  const T = SEARCH_TYPES[key];
  const isAct = key === 'activities';
  const label = isAct ? cap(r.sub || 'activity') : T.one;
  const ico = isAct && r.sub === 'task' ? 'tasks' : T.icon;
  const side = [];
  if (r.sub_kind === 'status' && r.sub) side.push(h('span', { class: 'pill ' + (['solved', 'closed'].includes(r.sub) ? 'ok' : r.sub === 'escalated' ? 'bad' : '') }, cap(r.sub)));
  if (r.sub_kind === 'money' && r.sub != null) side.push(h('span', { class: 'muted' }, money(r.sub)));
  return h('a', { class: 'sr', href: `#/${r.href}/${r.id}`, role: 'option' },
    h('span', { class: 'sr-ico' }, icon(ico, 18)),
    h('span', { class: 'sr-main' },
      h('span', { class: 'sr-title' }, ...highlight(r.title, terms), r.sub_kind === 'plain' && r.sub && !isAct ? h('span', { class: 'sr-sub' }, ...highlight(r.sub, terms)) : null),
      r.snippet ? h('span', { class: 'sr-snip' }, h('b', {}, r.matched + ': '), ...highlight(r.snippet, terms)) : null),
    h('span', { class: 'sr-side' }, side, h('span', { class: 'tag' }, label)));
}
function groupBlock(g, terms) {
  const T = SEARCH_TYPES[g.key];
  return h('div', { class: 'sg' }, h('div', { class: 'sg-head' }, icon(T.icon, 15), T.many), g.rows.map((r) => resultRow(g.key, r, terms)));
}

function buildSearch() {
  const input = h('input', { id: 'gsearch', type: 'search', placeholder: 'Search accounts, contacts, deals, cases and notes', autocomplete: 'off', maxlength: 80,
    role: 'combobox', 'aria-expanded': 'false', 'aria-controls': 'gpanel', 'aria-label': 'Search everything' });
  const panel = h('div', { id: 'gpanel', class: 'sresults', role: 'listbox', hidden: true });
  let scope = null, seq = 0, timer = null, active = -1, stale = false;
  const rows = () => [...panel.querySelectorAll('a.sr')];
  const open = () => { panel.hidden = false; input.setAttribute('aria-expanded', 'true'); };
  const close = () => { panel.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; };
  const setActive = (i) => {
    const list = rows();
    if (!list.length) return;
    active = (i + list.length) % list.length;
    list.forEach((r, k) => { r.classList.toggle('active', k === active); r.setAttribute('aria-selected', String(k === active)); });
    list[active].scrollIntoView({ block: 'nearest' });
  };
  const chips = (counts) => h('div', { class: 'schips', role: 'group', 'aria-label': 'Search only in' },
    h('button', { type: 'button', class: 'chip' + (scope ? '' : ' on'), 'aria-pressed': String(!scope), onclick: () => { scope = null; run(true); } }, 'All'),
    searchTypes().map(([k, t]) => h('button', { type: 'button', class: 'chip' + (scope === k ? ' on' : ''), 'aria-pressed': String(scope === k), onclick: () => { scope = scope === k ? null : k; run(true); } },
      icon(t.icon, 14), t.many, counts?.[k] ? h('i', {}, counts[k]) : null)));
  const help = () => fill(panel, chips(),
    h('div', { class: 'shelp' }, h('p', {}, 'Type at least two letters. Try a name, an email, a case number like #12, or any words from a note or description.'),
      h('div', { class: 'shelp-list' }, searchTypes().map(([k, t]) => h('div', {}, icon(t.icon, 16), h('b', {}, t.many), h('span', { class: 'muted' }, t.hint))))));
  async function run(immediate) {
    clearTimeout(timer);
    const q = input.value.trim().replace(/\s+/g, ' ');
    open();
    if (q.length < 2) { seq++; stale = false; panel.classList.remove('stale'); return help(); }
    // Until the new answer arrives, the old rows are dimmed and cannot be picked by mistake.
    stale = true; active = -1; panel.classList.add('stale');
    const mine = ++seq; // from this moment any older answer that arrives late is thrown away
    const go = async () => {
      try {
        const res = await api('GET', `/search?q=${encodeURIComponent(q)}&limit=5${scope ? '&types=' + scope : ''}`);
        if (mine !== seq) return;
        const counts = Object.fromEntries(res.groups.map((g) => [g.key, g.rows.length]));
        fill(panel, chips(counts),
          res.groups.length ? res.groups.map((g) => groupBlock(g, res.terms)) : h('div', { class: 'shelp' }, h('p', {}, `Nothing found for "${q}".`), h('p', { class: 'muted' }, 'Try fewer words, or check the spelling.')),
          h('a', { class: 'sr-all', href: '#/search/' + encodeURIComponent(q) }, `See all results for "${q}"`));
        active = -1; stale = false; panel.classList.remove('stale');
      } catch (e) { if (mine === seq && e.status !== 401) fill(panel, h('div', { class: 'shelp' }, h('p', {}, errText(e)))); }
    };
    if (immediate) go(); else timer = setTimeout(go, 180);
  }
  input.addEventListener('input', () => run(false));
  input.addEventListener('focus', () => { if (panel.hidden || !panel.children.length) run(true); else open(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); open(); if (!stale) setActive(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (!stale) setActive(active - 1); }
    else if (e.key === 'Escape') { if (!panel.hidden) { close(); e.preventDefault(); } else input.blur(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const list = rows();
      if (!stale && active >= 0 && list[active]) { const href = list[active].getAttribute('href'); input.value = ''; close(); input.blur(); location.hash = href; return; }
      const q = input.value.trim();
      if (q.length >= 2) { close(); location.hash = '#/search/' + encodeURIComponent(q); }
    }
  });
  panel.addEventListener('click', (e) => { if (e.target.closest('a')) { input.value = ''; close(); } });
  const box = h('form', { class: 'searchbox', role: 'search', onsubmit: (e) => e.preventDefault() }, h('span', { class: 'si' }, icon('search', 18)), input, h('kbd', { class: 'kbd', title: 'Press / to search' }, '/'), panel);
  box.closePanel = close;
  return box;
}
// One listener each for the whole page: click away closes the panel, "/" and Ctrl or Cmd plus K jump to the box.
document.addEventListener('mousedown', (e) => { const b = document.querySelector('.searchbox'); if (b && !b.contains(e.target)) b.closePanel?.(); });
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '') || document.activeElement?.isContentEditable;
  if (document.querySelector('dialog[open]') || !document.querySelector('#gsearch')) return;
  if ((e.key === '/' && !typing) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) { e.preventDefault(); $('#gsearch').focus(); $('#gsearch').select(); }
});

// The full results page: the same rows as the panel, with more of them.
async function viewSearch(enc) {
  const qText = decodeURIComponent(enc || '').trim();
  const box = $('#gsearch');
  if (box) box.value = qText;
  if (qText.length < 2) return setView(h('div', { class: 'head' }, titled('search', 'Search')), h('div', { class: 'card empty' }, 'Type at least two letters in the search box at the top.'));
  const res = await api('GET', '/search?q=' + encodeURIComponent(qText) + '&limit=20');
  let scope = null;
  const out = h('div');
  const draw = () => {
    const shown = res.groups.filter((g) => !scope || g.key === scope);
    fill(out,
      h('div', { class: 'schips page' },
        h('button', { type: 'button', class: 'chip' + (scope ? '' : ' on'), onclick: () => { scope = null; draw(); } }, 'All'),
        res.groups.map((g) => h('button', { type: 'button', class: 'chip' + (scope === g.key ? ' on' : ''), onclick: () => { scope = g.key; draw(); } }, icon(SEARCH_TYPES[g.key].icon, 14), SEARCH_TYPES[g.key].many, h('i', {}, g.rows.length)))),
      shown.length ? shown.map((g) => h('div', { class: 'card sresults-page' }, groupBlock(g, res.terms))) : h('div', { class: 'card empty' }, `Nothing found for "${qText}". Try fewer words, or check the spelling.`));
  };
  setView(h('div', { class: 'head' }, titled('search', `Results for "${qText}"`)), out);
  draw();
}

function signOutIcon() { return icon('logout', 18); }
function renderShell() {
  navCollapsed = prefs.nav_collapsed === true || (prefs.nav_collapsed === undefined && (() => { try { return localStorage.getItem('crm_nav_collapsed') === '1'; } catch { return false; } })());
  $('#app').replaceChildren(h('div', { class: 'shell' + (navCollapsed ? ' collapsed' : '') },
    h('nav', { class: 'side', 'aria-label': 'Main menu' },
      h('div', { class: 'navtop' },
        h('div', { class: 'brand' }, logoMark(26), h('span', { class: 'lbl' }, 'Tally')),
        h('button', { id: 'navtoggle', class: 'iconbtn', type: 'button', onclick: () => setCollapsed(!navCollapsed) }, icon('panel', 18))),
      h('div', { class: 'navlist' }),
      h('div', { class: 'bottombar' },
        h('div', { class: 'who' }, h('b', {}, me.user.display_name), h('span', { class: 'muted' }, me.user.email), h('div', {}, h('a', { href: '#', onclick: (e) => { e.preventDefault(); signOut(); } }, 'Sign out'))),
        h('a', { class: 'gear', href: '#/settings', 'data-nav': '#/settings', title: 'Settings', 'aria-label': 'Settings' }, gearIcon()),
        h('button', { class: 'iconbtn signout', type: 'button', title: 'Sign out', 'aria-label': 'Sign out', onclick: signOut }, signOutIcon()))),
    h('div', { class: 'mainwrap' },
      h('header', { class: 'topbar' }, buildSearch()),
      h('main', {}, h('div', { id: 'view' })))));
  drawNavList();
  setCollapsed(navCollapsed, false);
}

async function route() {
  if (!me) return;
  routeSeq++;
  const [, a, id] = (location.hash || '#/').split('/');
  const section = a || '';
  markNav();
  document.querySelector('.searchbox')?.closePanel?.();
  try {
    setView(h('div', { class: 'muted' }, 'Loading…'));
    if (section === '') await viewHome();
    else if (section === 'reports') await viewReports(id);
    else if (section === 'settings') await viewSettings(id);
    else if (section === 'tasks') await viewTasks();
    else if (section === 'search') await viewSearch(id);
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
  // A failure here must never block sign in: Tally just shows the default look.
  prefs = await api('GET', '/me/preferences').catch(() => ({ accent: null, tour_done_at: 'unknown', last_seen_release: RELEASES[0].id }));
  applyAccent(prefs.accent);
  await loadRefs();
  renderShell();
  await route();
  welcome();
}
window.addEventListener('hashchange', route);
// Coming back from Google: the address carries a new sign in token after the #, or a short reason after ?login_error=
const back = /^#token=([\w.-]+)$/.exec(location.hash);
const backError = new URLSearchParams(location.search).get('login_error');
if (back) { token = back[1]; try { localStorage.setItem(TOKEN_KEY, token); } catch { /* private window: signed in until reload */ } }
if (back || backError) history.replaceState(null, '', location.pathname);
if (token) boot().catch(() => renderLogin()); else renderLogin(backError ? (LOGIN_ERRORS[backError] || LOGIN_ERRORS.failed) : undefined);
