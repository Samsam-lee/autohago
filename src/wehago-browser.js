// 위하고 전용 Chrome 프로필 공통 모듈
//
// - 로그인: Playwright 없이 "일반 Chrome"으로 띄운다. 자동화 플래그(--no-sandbox, webdriver 등)가 없어서
//   구글 로그인·보안 경고 문제가 생기지 않는다.
// - 자동화: 같은 프로필로 Chrome을 원격 디버깅 포트와 함께 띄운 뒤 Playwright가 붙는다(connectOverCDP).
// - 로그인 정보(쿠키 등)는 profile/ 아래에만 저장되며 git에 올라가지 않는다.

import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PROFILE_DIR = path.join(ROOT, 'profile', 'wehago');
export const STATE_FILE = path.join(ROOT, 'profile', 'wehago-cookies.json');
export const LOG_DIR = path.join(ROOT, 'logs');
export const WEHAGO_URL = 'https://www.wehago.com/';
const DEBUG_PORT = 9333;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  path.join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
].filter(Boolean);

export function findChrome() {
  const found = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!found) throw new Error('Chrome을 찾을 수 없습니다. CHROME_PATH 환경변수로 chrome.exe 경로를 지정하세요.');
  return found;
}

/**
 * 프로필 기본 설정. 비정상 종료 복구 안내가 뜨지 않도록 exit_type을 정상으로 맞춘다.
 */
function prepareProfile() {
  const prefDir = path.join(PROFILE_DIR, 'Default');
  const prefFile = path.join(prefDir, 'Preferences');
  fs.mkdirSync(prefDir, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });

  let prefs = {};
  try {
    prefs = JSON.parse(fs.readFileSync(prefFile, 'utf8'));
  } catch {
    // 새 프로필
  }
  // 로그인 쿠키는 STATE_FILE로 직접 관리하므로, 이전 탭 복원은 끈다(5: 새 탭으로 시작)
  prefs.session = { ...prefs.session, restore_on_startup: 5 };
  prefs.profile = { ...prefs.profile, exit_type: 'Normal' };
  fs.writeFileSync(prefFile, JSON.stringify(prefs));
}

function chromeArgs(extra = []) {
  return [`--user-data-dir=${PROFILE_DIR}`, '--no-first-run', '--no-default-browser-check', ...extra];
}

const debugArgs = () => [`--remote-debugging-port=${DEBUG_PORT}`, '--remote-debugging-address=127.0.0.1'];
const isWehagoCookie = (c) => /(^|\.)(wehago\.com|douzone\.com)$/i.test(c.domain.replace(/^\./, ''));

/** 브라우저 단위 CDP 명령 1회 호출. 페이지에는 붙지 않으므로 사이트에서 자동화로 감지되지 않는다. */
async function browserCdp(method, params = {}) {
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  try {
    return await new Promise((resolve, reject) => {
      ws.onerror = () => reject(new Error('CDP 연결 실패'));
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id !== 1) return;
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      };
    });
  } finally {
    ws.close();
  }
}

/** CDP 쿠키 → Playwright addCookies 형식 */
function toPlaywrightCookie(c) {
  const cookie = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.session ? -1 : c.expires,
    httpOnly: c.httpOnly,
    secure: c.secure,
  };
  if (['Strict', 'Lax', 'None'].includes(c.sameSite)) cookie.sameSite = c.sameSite;
  return cookie;
}

/** Playwright 쿠키 → CDP Storage.setCookies 형식 */
function toCdpCookie(c) {
  const cookie = { name: c.name, value: c.value, domain: c.domain, path: c.path, httpOnly: c.httpOnly, secure: c.secure };
  if (c.expires > 0) cookie.expires = c.expires;
  if (c.sameSite) cookie.sameSite = c.sameSite;
  return cookie;
}

/**
 * 사람이 쓰는 일반 Chrome 창을 띄우고, 사용자가 창을 모두 닫을 때까지 기다린다(로그인·위하고 열기 공용).
 * - 저장된 로그인 쿠키를 먼저 넣은 뒤 url을 연다 → 로그인이 살아 있으면 바로 로그인된 화면이 뜬다.
 * - 창이 열려 있는 동안 5초마다 위하고 쿠키(창을 닫으면 사라지는 세션 쿠키 포함)를 STATE_FILE에 저장한다.
 * - 페이지에는 붙지 않고 브라우저 단위 명령만 쓰므로 구글 로그인 등에서 자동화로 감지되지 않는다.
 */
export async function launchVisible(url = WEHAGO_URL) {
  prepareProfile();
  const child = spawn(findChrome(), chromeArgs([...debugArgs(), '--new-window', 'about:blank']), { stdio: 'ignore' });
  try {
    await waitForDebugger();
    const saved = loadSavedCookies();
    if (saved.length) await browserCdp('Storage.setCookies', { cookies: saved.map(toCdpCookie) });
    const blank = (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()).filter(
      (t) => t.type === 'page' && t.url === 'about:blank'
    );
    await browserCdp('Target.createTarget', { url });
    for (const t of blank) await browserCdp('Target.closeTarget', { targetId: t.id }).catch(() => {});
  } catch (e) {
    // 쿠키 주입에 실패해도 창은 열어 둔다(사용자가 직접 로그인하면 됨)
    await browserCdp('Target.createTarget', { url }).catch(() => {});
    console.error('위하고 창 준비 중 오류:', e.message);
  }
  let exited = child.exitCode != null;
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => {
      exited = true;
      resolve(code);
    });
  });

  let saved = 0;
  while (!exited) {
    await Promise.race([done, new Promise((r) => setTimeout(r, 5000))]);
    if (exited) break;
    try {
      const { cookies } = await browserCdp('Storage.getCookies');
      const wehago = cookies.filter(isWehagoCookie).map(toPlaywrightCookie);
      if (wehago.length) {
        fs.writeFileSync(STATE_FILE, JSON.stringify({ savedAt: new Date().toISOString(), cookies: wehago }));
        saved = wehago.length;
      }
    } catch {
      // Chrome이 뜨는 중이거나 닫히는 중
    }
  }
  return { savedCookies: saved };
}

/** 로그인용(기존 이름 유지) */
export const launchForLogin = (url = WEHAGO_URL) => launchVisible(url);

function loadSavedCookies() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).cookies ?? [];
  } catch {
    return [];
  }
}

async function waitForDebugger(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (res.ok) return;
    } catch {
      // 아직 안 뜸
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('Chrome 원격 디버깅 포트에 연결하지 못했습니다. 위하고 Chrome 창이 이미 열려 있다면 닫고 다시 실행하세요.');
}

/** 자동화용: 같은 프로필로 Chrome을 띄우고 Playwright로 연결한다. */
export async function openWehago({ headless = false } = {}) {
  // 이전 실행이 강제 종료돼 같은 프로필의 Chrome이 남아 있으면 그대로 재사용한다
  const alreadyUp = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`).then((r) => r.ok).catch(() => false);
  let child = null;
  if (!alreadyUp) {
    prepareProfile();
    const extra = debugArgs();
    if (headless) extra.push('--headless=new', '--window-size=1400,900');
    child = spawn(findChrome(), chromeArgs([...extra, 'about:blank']), { stdio: 'ignore' });
    await waitForDebugger();
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
  const context = browser.contexts()[0];
  const saved = loadSavedCookies();
  if (saved.length) await context.addCookies(saved);
  const page = context.pages()[0] ?? (await context.newPage());

  const close = async () => {
    // 사용 중 갱신된 로그인 토큰을 다시 저장해 둔다(로그인된 상태일 때만)
    try {
      const fresh = (await context.cookies()).filter(isWehagoCookie);
      if (fresh.some((c) => c.name === 'AUTH_A_TOKEN')) {
        fs.writeFileSync(STATE_FILE, JSON.stringify({ savedAt: new Date().toISOString(), cookies: fresh }));
      }
    } catch {
      // 이미 닫힌 경우
    }
    // Chrome을 정상 종료해야 프로필이 "비정상 종료"로 남지 않는다
    const cdp = await browser.newBrowserCDPSession().catch(() => null);
    await cdp?.send('Browser.close').catch(() => {});
    if (child) await new Promise((r) => (child.exitCode != null ? r() : child.once('exit', r)));
  };
  return { browser, context, page, close };
}

/** 로그인 화면(비밀번호 입력칸)이 보이는지 확인한다. */
export async function isLoginScreen(page) {
  return page
    .locator('input[type="password"]')
    .first()
    .isVisible()
    .catch(() => false);
}
