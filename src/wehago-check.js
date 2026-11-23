// 저장된 프로필·쿠키로 위하고에 접속해 로그인이 유지되는지 확인한다(창 없이 실행).
// 로그인돼 있으면 https://www.wehago.com/ 이 #/main 으로, 아니면 랜딩·로그인 화면으로 간다.
// 실행: npm run wehago:check

import path from 'node:path';
import { openWehago, WEHAGO_URL, LOG_DIR } from './wehago-browser.js';

const { page, close } = await openWehago({ headless: true });
try {
  await page.goto(WEHAGO_URL, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(3000);

  const loggedIn = page.url().includes('#/main');
  const shot = path.join(LOG_DIR, 'wehago-check.png');
  await page.screenshot({ path: shot });

  console.log(`URL: ${page.url()}`);
  console.log(`로그인 상태: ${loggedIn ? '유지됨' : '로그인 필요 (npm run wehago:login)'}`);
  console.log(`스크린샷: ${shot}`);
  process.exitCode = loggedIn ? 0 : 1;
} finally {
  await close();
}
