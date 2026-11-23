// 위하고 로그인 창을 일반 Chrome으로 띄운다(자동화 아님 → 구글 로그인 가능).
// 아이디·비밀번호·2차인증은 사용자가 창에서 직접 입력하고, 로그인 후 창을 닫으면 된다.
// 실행: npm run wehago:login

import { launchForLogin, STATE_FILE } from './wehago-browser.js';

console.log('위하고 Chrome 창을 엽니다. 로그인(2차인증 포함)을 마친 뒤 창을 닫아 주세요.');
const { savedCookies } = await launchForLogin();
console.log(`창이 닫혔습니다. 위하고 쿠키 ${savedCookies}개를 ${STATE_FILE} 에 저장했습니다.`);
