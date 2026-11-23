// autohago 웹 화면 서버
// - 이 PC에서만 접속 가능(127.0.0.1). 수임처 정보가 사내망에 노출되지 않는다.
// - 위하고는 이 PC의 전용 Chrome 프로필(각자 본인 계정)로 접속한다.
// 실행: npm run web  →  http://localhost:4310

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openWehago, launchVisible, WEHAGO_URL } from '../wehago-browser.js';
import { fetchClients } from '../wehago-clients.js';

const PORT = Number(process.env.PORT ?? 4310);
const HOST = '127.0.0.1';
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const IDLE_CLOSE_MS = 10 * 60 * 1000;

// 위하고에서 할 작업 목록. 기능은 아직 구현 전이라 버튼만 노출한다.
const TASKS = [
  { id: 'vat', name: '부가세 자동화', ready: false },
  { id: 'tax-adjust', name: '세무조정 자동화', ready: false },
  { id: 'bookkeeping', name: '기장 자동화', ready: false },
];

// ---------- 위하고 브라우저(창 없는 Chrome) 하나를 재사용 ----------

let session = null; // { page, close }
let idleTimer = null;
let windowOpen = null; // 사람이 보는 위하고 창: null | 'login' | 'wehago'
let queue = Promise.resolve(); // 브라우저 작업은 한 번에 하나씩

function withBrowser(fn) {
  const run = queue.then(async () => {
    if (windowOpen) throw httpError(409, '위하고 창이 열려 있습니다. 창을 닫으면 목록을 다시 불러올 수 있습니다.');
    if (!session) session = await openWehago({ headless: true });
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => enqueueClose(), IDLE_CLOSE_MS);
    return fn(session.page);
  });
  queue = run.catch(() => {});
  return run;
}

async function closeSession() {
  clearTimeout(idleTimer);
  if (session) {
    const s = session;
    session = null;
    await s.close().catch(() => {});
  }
}

function enqueueClose() {
  queue = queue.then(closeSession).catch(() => {});
  return queue;
}

// ---------- 상태 ----------

let clientsCache = null; // { loggedIn, total, clients, fetchedAt }

async function loadClients(force = false) {
  if (clientsCache && !force) return clientsCache;
  const result = await withBrowser((page) => fetchClients(page));
  const data = { ...result, fetchedAt: new Date().toISOString() };
  clientsCache = result.loggedIn ? data : null;
  return data;
}

/** 사람이 보는 위하고 창을 연다. 같은 프로필을 쓰므로 창 없는 Chrome은 먼저 닫는다. */
async function startVisible(kind) {
  if (windowOpen) return false;
  windowOpen = kind;
  await enqueueClose();
  if (kind === 'login') clientsCache = null;
  launchVisible(kind === 'login' ? WEHAGO_URL : `${WEHAGO_URL}#/main`)
    .catch((e) => console.error('위하고 창 오류:', e.message))
    .finally(() => {
      windowOpen = null;
    });
  return true;
}

// ---------- HTTP ----------

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  if (!(req.headers['content-type'] ?? '').includes('application/json')) throw httpError(415, 'JSON 요청만 받습니다.');
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1e6) throw httpError(413, '요청이 너무 큽니다.');
  }
  return body ? JSON.parse(body) : {};
}

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

function serveStatic(req, res, pathname) {
  const file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('Not found');
    return;
  }
  res.writeHead(200, {
    'content-type': `${MIME[path.extname(file)] ?? 'application/octet-stream'}; charset=utf-8`,
    'cache-control': 'no-cache', // 업데이트 후 예전 화면 파일이 남지 않도록
  });
  fs.createReadStream(file).pipe(res);
}

const routes = {
  'GET /api/clients': async (req, url) => {
    const data = await loadClients(url.searchParams.get('refresh') === '1');
    return [data.loggedIn ? 200 : 401, data];
  },
  'GET /api/status': async () => [200, { windowOpen, tasks: TASKS }],
  'POST /api/login': async () => {
    const started = await startVisible('login');
    return [started ? 202 : 409, { windowOpen, message: started ? undefined : '위하고 창이 이미 열려 있습니다.' }];
  },
  'POST /api/open-wehago': async () => {
    const started = await startVisible('wehago');
    return [started ? 202 : 409, { windowOpen, message: started ? undefined : '위하고 창이 이미 열려 있습니다.' }];
  },
  'POST /api/tasks': async (req) => {
    const { task, clients = [] } = await readJson(req);
    const def = TASKS.find((t) => t.id === task);
    if (!def) throw httpError(400, '알 수 없는 작업입니다.');
    if (!Array.isArray(clients) || clients.length === 0) throw httpError(400, '수임처를 선택해 주세요.');
    if (!def.ready) return [501, { message: `'${def.name}' 기능은 아직 준비 중입니다. (선택 ${clients.length}곳)`, task, count: clients.length }];
    return [501, { message: '준비 중' }];
  },
};

const server = http.createServer(async (req, res) => {
  // 다른 사이트가 이 서버를 이용하지 못하도록 Host 확인(DNS 리바인딩 방지)
  const host = (req.headers.host ?? '').replace(/:\d+$/, '');
  if (!['localhost', '127.0.0.1'].includes(host)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const handler = routes[`${req.method} ${url.pathname}`];
  if (!handler) {
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
    return sendJson(res, 404, { message: '없는 주소입니다.' });
  }
  try {
    const [status, data] = await handler(req, url);
    sendJson(res, status, data);
  } catch (e) {
    console.error(`${req.method} ${url.pathname}:`, e.message);
    sendJson(res, e.status ?? 500, { message: e.status ? e.message : `오류가 발생했습니다: ${e.message}` });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`autohago 웹 화면: http://localhost:${PORT}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await closeSession();
    process.exit(0);
  });
}
