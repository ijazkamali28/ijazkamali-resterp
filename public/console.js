const API = '/api/v1';
const USERS = [
  ['owner@demo.ae','Owner (all branches)'],['gm@demo.ae','General Manager'],['bm.jbr@demo.ae','Branch Manager — JBR'],
  ['bm.khl@demo.ae','Branch Manager — Khalidiya'],['cashier.jbr@demo.ae','Cashier — JBR'],['waiter.jbr@demo.ae','Waiter — JBR'],
  ['chef.jbr@demo.ae','Chef — JBR'],['inventory@demo.ae','Inventory Controller'],['procurement@demo.ae','Procurement Officer'],
  ['accountant@demo.ae','Accountant'],['marketing@demo.ae','Marketing Manager'],['rider.jbr@demo.ae','Rider — JBR'],
  ['owner@other.ae','Owner of a DIFFERENT company'],['superadmin@platform.local','Platform Super Admin'],
];
const PW = (e) => (e === 'superadmin@platform.local' ? 'Admin@Pass2026' : 'Demo@Pass2026');
let token = null, me = null, branchIds = {};
const $ = (id) => document.getElementById(id);

async function call(method, path, body) {
  const headers = {};
  if (token) headers.authorization = 'Bearer ' + token;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null; try { data = await r.json(); } catch {}
  return { status: r.status, data };
}
function show(method, path, res) {
  $('status').innerHTML = `<b>${method} ${path}</b> → <span class="badge ${res.status < 300 ? 'ok' : 'bad'}">HTTP ${res.status}</span>`;
  $('out').textContent = JSON.stringify(res.data, null, 2);
}

async function loadBranchIds() {
  // look up branch ids as the owner, so scenarios can target JBR / KHL regardless of who is logged in
  const r = await fetch(API + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@demo.ae', password: 'Demo@Pass2026' }) }).then((x) => x.json());
  const b = await fetch(API + '/org/branches', { headers: { authorization: 'Bearer ' + r.token } }).then((x) => x.json());
  for (const x of b.data) branchIds[x.code] = x.id;
  await fetch(API + '/auth/logout', { method: 'POST', headers: { authorization: 'Bearer ' + r.token } });
}

async function login() {
  const email = $('user').value;
  if (token) await call('POST', '/auth/logout');
  token = null;
  const res = await call('POST', '/auth/login', { email, password: PW(email) });
  show('POST', '/auth/login', res);
  if (res.status !== 200) { $('who').textContent = 'login failed'; return; }
  token = res.data.token;
  await refreshMe();
}
async function refreshMe() {
  const r = await call('GET', '/auth/me');
  if (r.status !== 200) { me = null; $('me').textContent = 'Not logged in.'; $('who').textContent = 'not logged in'; return; }
  me = r.data;
  const nav = await call('GET', '/meta/navigation');
  $('who').textContent = `${me.user.full_name} · ${me.grants.map((g) => g.role).join(', ') || 'platform'}`;
  const menu = (nav.data?.data ?? []).map((n) => n.label + (n.children ? ` (${n.children.map((c) => c.label).join(', ')})` : ''));
  $('me').innerHTML = `
    <div><b>${me.user.full_name}</b> <span class="muted">${me.user.email}</span></div>
    <div class="small muted">Roles: ${me.grants.map((g) => `${g.role}${g.branchId ? ' @ ' + (Object.entries(branchIds).find(([, v]) => v === g.branchId)?.[0] ?? 'branch') : ' (all branches)'}`).join(', ') || 'platform super admin'}</div>
    <div class="small muted">Visible branches: ${me.branches.map((b) => b.code).join(', ') || '—'} · ${me.permissions.length} permissions</div>
    <div class="small" style="margin-top:6px"><b>Menu this user gets:</b></div>
    <div class="chips">${menu.map((m) => `<span class="chip">${m}</span>`).join('') || '<span class="muted small">none</span>'}</div>`;
}

const can = (p) => !!me && (me.isPlatformAdmin || me.permissions.includes(p));
const SCENARIOS = [
  { t: 'List branches', e: 'Owner/GM see all 3; branch managers & cashiers only their own; other company sees only its own.',
    run: () => call('GET', '/org/branches'), expect: (r) => r.status === 200 || (!can('org.branch.view') && r.status === 403) },
  { t: 'Open the Khalidiya branch record', e: 'Allowed for company-wide roles; JBR staff get 404 (cannot even see it exists); other company gets 404.',
    run: () => call('GET', `/org/branches/${branchIds.KHL}`),
    expect: (r) => (me && (me.branches.some((b) => b.code === 'KHL')) && can('org.branch.view')) ? r.status === 200 : [403, 404].includes(r.status) },
  { t: 'List users', e: 'Needs iam.user.view. Branch managers only see users of their branch. Cashier/waiter → 403.',
    run: () => call('GET', '/iam/users'), expect: (r) => (can('iam.user.view') ? r.status === 200 : r.status === 403) },
  { t: 'Create a new branch', e: 'Only owner (company-wide branch.manage). Everyone else → 403. Second click → 409 duplicate code.',
    run: () => call('POST', '/org/branches', { code: 'TEST' + Math.floor(Math.random() * 900 + 100), name: 'Console test branch', emirate: 'Dubai' }),
    expect: (r) => (can('org.branch.manage') && me?.grants.some((g) => !g.branchId) ? r.status === 201 : r.status === 403) },
  { t: 'Send invalid data (bad code, unknown emirate, smuggled company_id)', e: 'Server-side validation must reject with 400 (or 403 if you lack permission first).',
    run: () => call('POST', '/org/branches', { code: 'bad code!', name: 'x', emirate: 'Paris', companyId: '00000000-0000-0000-0000-000000000000' }),
    expect: (r) => [400, 403].includes(r.status) },
  { t: 'Give myself the OWNER role', e: 'Nobody may change their own roles → 403.',
    run: async () => { const roles = await call('GET', '/iam/roles'); const owner = roles.data?.data?.find((x) => x.code === 'OWNER');
      return owner ? call('POST', `/iam/users/${me.user.id}/roles`, { roleId: owner.id, branchId: null }) : roles; },
    expect: (r) => r.status === 403 },
  { t: 'Read the audit log', e: 'Owner, GM, branch manager (own branch), accountant. Others → 403. Shows logins, role changes, row before/after values.',
    run: () => call('GET', '/audit/logs?limit=20'), expect: (r) => (can('audit.log.view') ? r.status === 200 : r.status === 403) },
  { t: 'Register a POS terminal in JBR', e: 'Branch manager JBR / owner / GM: 201 with a one-time device secret. Khalidiya manager & cashier → 403.',
    run: () => call('POST', '/sync/devices', { branchId: branchIds.JBR, code: 'POS-' + Math.floor(Math.random() * 9000 + 1000), name: 'Console test till', deviceType: 'pos_terminal' }),
    expect: (r) => (me && me.branches.some((b) => b.code === "JBR") && (me.grants.some((g) => !g.branchId || g.branchId === branchIds.JBR)) && can("sync.device.register") ? r.status === 201 : [403, 404].includes(r.status)) },
  { t: 'Sync / offline indicator data', e: 'Pending events, failed events, last successful sync, open conflicts.',
    run: () => call('GET', '/sync/status'), expect: (r) => (can('sync.status.view') ? r.status === 200 : r.status === 403) },
  { t: 'Permission matrix', e: 'All 12 roles × 104 permissions (needs iam.role.view).',
    run: () => call('GET', '/meta/permission-matrix'), expect: (r) => (can('iam.role.view') ? r.status === 200 : r.status === 403) },
  { t: 'Call the API without logging in', e: 'Must be 401.',
    run: async () => { const t = token; token = null; const r = await call('GET', '/auth/me'); token = t; return r; }, expect: (r) => r.status === 401 },
];

function renderScenarios() {
  $('scenarios').innerHTML = SCENARIOS.map((s, i) => `
    <div class="sc"><div><div class="t">${s.t}</div><div class="e">${s.e}</div></div>
    <span class="badge" id="b${i}">not run</span><button data-i="${i}">Run</button></div>`).join('');
  $('scenarios').querySelectorAll('button').forEach((btn) => btn.addEventListener('click', async () => {
    const i = Number(btn.dataset.i); const s = SCENARIOS[i];
    if (!token && i !== SCENARIOS.length - 1) { $('status').textContent = 'Log in first.'; return; }
    const r = await s.run(); show('RUN', s.t, r);
    const ok = s.expect(r); const b = $('b' + i);
    b.className = 'badge ' + (ok ? 'ok' : 'bad'); b.textContent = (ok ? 'as expected' : 'UNEXPECTED') + ` · ${r.status}`;
  }));
}

$('user').innerHTML = USERS.map(([e, l]) => `<option value="${e}">${l} — ${e}</option>`).join('');
$('loginBtn').addEventListener('click', login);
$('logoutBtn').addEventListener('click', async () => { if (token) show('POST', '/auth/logout', await call('POST', '/auth/logout')); token = null; await refreshMe(); });
$('sendBtn').addEventListener('click', async () => {
  let body; const raw = $('body').value.trim();
  if (raw) { try { body = JSON.parse(raw); } catch { $('status').textContent = 'Body is not valid JSON'; return; } }
  const m = $('method').value, p = $('path').value.trim();
  show(m, p, await call(m, p, m === 'GET' ? undefined : body));
});
renderScenarios();
loadBranchIds().catch(() => {});
