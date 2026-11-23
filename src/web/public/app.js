const $ = (s) => document.querySelector(s);
const state = { clients: [], selected: new Set(), filter: 'all', query: '', tasks: [], loggedIn: null, loading: false };

// ---------- 표시 형식 ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtBizNo = (n) => {
  const d = String(n ?? '').replace(/\D/g, '');
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}` : n ?? '';
};
const fmtMd = (s) => {
  const d = String(s ?? '').replace(/\D/g, '');
  if (d.length === 8) return `${d.slice(4, 6)}.${d.slice(6)}`;
  if (d.length === 4) return `${d.slice(0, 2)}.${d.slice(2)}`;
  return s ?? '';
};

function toast(msg, isErr = false) {
  const el = document.createElement('div');
  el.className = `toast${isErr ? ' err' : ''}`;
  el.textContent = msg;
  $('#log').append(el);
  setTimeout(() => el.remove(), 5000);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// ---------- 로그인 상태 ----------

const PILL = {
  ok: ['pill-ok', '위하고 로그인됨'],
  need: ['pill-warn', '로그인 필요'],
  login: ['pill-wait', '로그인 창 열림'],
  wehago: ['pill-ok', '위하고 창 열림'],
  check: ['pill-wait', '확인 중…'],
};

/** 상단 상태 표시와 버튼 활성화를 한곳에서 맞춘다. */
function setLogin(s) {
  state.loggedIn = s;
  const [cls, text] = PILL[s] ?? PILL.check;
  $('#loginState').className = `pill ${cls}`;
  $('#loginState').textContent = text;
  const windowOpen = s === 'login' || s === 'wehago';
  $('#loginBtn').hidden = s !== 'need';
  $('#openBtn').hidden = s === 'need';
  $('#openBtn').disabled = windowOpen;
  $('#refreshBtn').disabled = windowOpen || state.loading;
}

function setRefreshBusy(busy) {
  const btn = $('#refreshBtn');
  btn.disabled = busy || state.loggedIn === 'login' || state.loggedIn === 'wehago';
  btn.innerHTML = busy ? '<span class="spinner"></span>불러오는 중…' : '목록 새로고침';
}

/** 사람이 보는 위하고 창(로그인/열기)을 열고, 닫히면 목록을 다시 불러온다. */
async function openWindow(kind) {
  const { status, data } = await api(kind === 'login' ? '/api/login' : '/api/open-wehago', { method: 'POST', body: '{}' });
  if (status !== 202) {
    toast(data.message ?? `창을 열지 못했습니다 (${status})`, true);
    return;
  }
  setLogin(kind);
  if (kind === 'login') {
    showEmpty('위하고 로그인 창을 열었습니다.<br>로그인(2차인증 포함)을 마친 뒤 <b>창을 닫으면</b> 목록을 불러옵니다.', true);
  } else {
    toast('위하고 창을 열었습니다. 창을 닫으면 목록 새로고침을 다시 쓸 수 있습니다.');
  }
  watchWindow();
}

let watching = null;
function watchWindow() {
  if (watching) return;
  watching = setInterval(async () => {
    const { data } = await api('/api/status').catch(() => ({ data: {} }));
    if (data.windowOpen) return;
    clearInterval(watching);
    watching = null;
    setLogin('check');
    loadClients({ refresh: true, quiet: true });
  }, 2000);
}

// ---------- 수임처 목록 ----------

function showEmpty(html, spinning = false) {
  $('#rows').innerHTML = '';
  const el = $('#empty');
  el.hidden = false;
  el.innerHTML = (spinning ? '<span class="spinner"></span>' : '') + html;
}

/**
 * 수임처 목록을 불러온다.
 * 이미 목록이 있으면 표는 그대로 두고 버튼에만 진행 표시를 한다(새로고침 중에도 계속 볼 수 있게).
 */
async function loadClients({ refresh = false, quiet = false } = {}) {
  if (state.loading) {
    if (!quiet) toast('이미 불러오는 중입니다. 잠시만 기다려 주세요.');
    return;
  }
  state.loading = true;
  setRefreshBusy(true);
  const hadList = state.clients.length > 0;
  if (!hadList) showEmpty('위하고에서 수임처 목록을 불러오는 중입니다…', true);
  try {
    const { status, data } = await api(`/api/clients${refresh ? '?refresh=1' : ''}`);
    if (status === 401) {
      state.clients = [];
      setLogin('need');
      showEmpty('위하고 로그인이 필요합니다.<br><button class="btn btn-primary" id="emptyLogin">위하고 로그인</button>');
      $('#emptyLogin').onclick = () => openWindow('login');
      return;
    }
    if (status === 409) {
      toast(data.message, true);
      if (!hadList) showEmpty(esc(data.message));
      return;
    }
    if (status !== 200) throw new Error(data.message ?? `오류 ${status}`);
    setLogin('ok');
    state.clients = data.clients;
    const codes = new Set(data.clients.map((c) => String(c.code)));
    state.selected = new Set([...state.selected].filter((c) => codes.has(c)));
    const t = new Date(data.fetchedAt);
    $('#updated').textContent = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')} 기준`;
    render();
    if (refresh && !quiet) toast(`수임처 목록을 새로 불러왔습니다. (${data.clients.length}곳)`);
  } catch (e) {
    toast(`목록을 불러오지 못했습니다: ${e.message}`, true);
    if (!hadList) showEmpty(`목록을 불러오지 못했습니다.<br><span class="sub">${esc(e.message)}</span>`);
  } finally {
    state.loading = false;
    setRefreshBusy(false);
  }
}

function visibleClients() {
  const q = state.query.trim().toLowerCase();
  const qDigits = q.replace(/\D/g, '');
  return state.clients.filter((c) => {
    if (state.filter === 'corp' && c.isPrivate) return false;
    if (state.filter === 'private' && !c.isPrivate) return false;
    if (!q) return true;
    return (
      String(c.name ?? '').toLowerCase().includes(q) ||
      String(c.ceo ?? '').toLowerCase().includes(q) ||
      (qDigits.length >= 3 && String(c.bizNo ?? '').replace(/\D/g, '').includes(qDigits))
    );
  });
}

function render() {
  const list = visibleClients();
  $('#count').textContent = `${list.length} / ${state.clients.length}곳`;
  if (list.length === 0) {
    showEmpty(state.clients.length ? '검색 결과가 없습니다.' : '담당 수임처가 없습니다.');
  } else {
    $('#empty').hidden = true;
    $('#rows').innerHTML = list
      .map((c) => {
        const code = String(c.code);
        const sel = state.selected.has(code);
        const fiscal = c.fiscalBegin || c.fiscalEnd ? `${fmtMd(c.fiscalBegin)} ~ ${fmtMd(c.fiscalEnd)}` : '';
        return `<tr data-code="${esc(code)}" class="${sel ? 'sel' : ''}">
          <td class="chk"><input type="checkbox" ${sel ? 'checked' : ''} aria-label="${esc(c.name)} 선택" /></td>
          <td class="name">${esc(c.name)}</td>
          <td class="mono nowrap">${esc(fmtBizNo(c.bizNo))}</td>
          <td class="nowrap">${esc(c.ceo)}</td>
          <td class="nowrap ${c.isPrivate ? 'kind-private' : 'kind-corp'}">${c.isPrivate ? '개인' : '법인'}</td>
          <td>${esc(c.bizCond)}<div class="sub">${esc(c.item)}</div></td>
          <td class="mono sub nowrap">${esc(fiscal)}</td>
          <td>${c.tags ? `<span class="tag">${esc(c.tags)}</span>` : ''}</td>
        </tr>`;
      })
      .join('');
  }
  const allSel = list.length > 0 && list.every((c) => state.selected.has(String(c.code)));
  $('#checkAll').checked = allSel;
  $('#checkAll').indeterminate = !allSel && list.some((c) => state.selected.has(String(c.code)));
  renderActions();
}

// ---------- 작업 버튼 ----------

function renderActions() {
  $('#selCount').textContent = state.selected.size;
  $('#tasks').innerHTML = state.tasks
    .map(
      (t) =>
        `<button class="btn btn-primary" data-task="${esc(t.id)}" ${state.selected.size ? '' : 'disabled'}>${esc(t.name)}${
          t.ready ? '' : '<span class="soon">준비 중</span>'
        }</button>`
    )
    .join('');
}

async function runTask(taskId) {
  const { status, data } = await api('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ task: taskId, clients: [...state.selected] }),
  });
  toast(data.message ?? `처리됨 (${status})`, status >= 400 && status !== 501);
}

// ---------- 이벤트 ----------

$('#rows').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-code]');
  if (!tr) return;
  const code = tr.dataset.code;
  state.selected.has(code) ? state.selected.delete(code) : state.selected.add(code);
  render();
});
$('#checkAll').addEventListener('change', (e) => {
  for (const c of visibleClients()) e.target.checked ? state.selected.add(String(c.code)) : state.selected.delete(String(c.code));
  render();
});
$('#search').addEventListener('input', (e) => {
  state.query = e.target.value;
  render();
});
document.querySelectorAll('.seg button').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x === b));
    state.filter = b.dataset.filter;
    render();
  })
);
$('#tasks').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-task]');
  if (b) runTask(b.dataset.task);
});
$('#refreshBtn').addEventListener('click', () => loadClients({ refresh: true }));
$('#loginBtn').addEventListener('click', () => openWindow('login'));
$('#openBtn').addEventListener('click', () => openWindow('wehago'));

// ---------- 시작 ----------

const { data: status } = await api('/api/status');
state.tasks = status.tasks ?? [];
renderActions();
if (status.windowOpen) {
  setLogin(status.windowOpen);
  showEmpty('위하고 창이 열려 있습니다. 창을 닫으면 목록을 불러옵니다.', true);
  watchWindow();
} else {
  setLogin('check');
  loadClients();
}
