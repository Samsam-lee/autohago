// 위하고 "담당 수임처" 목록 조회
//
// 위하고 API 요청은 서명(wehago-sign)이 붙어 있어 직접 호출할 수 없다.
// 그래서 위하고 메인 화면이 스스로 보내는 목록 요청(Tmain)의 응답을 읽는다.
// 한 페이지 20건 제한만 늘려서 한 번에 전체를 받는다.

const TMAIN = '/taxagent/com/Tmain/';
const MAIN_URL = 'https://www.wehago.com/#/main';

/**
 * 웹 화면에 내보낼 필드만 고른다(화이트리스트).
 * 대표자 주민번호(no_ceosoc), 주소, 전화번호 등은 의도적으로 제외한다.
 */
function pick(r) {
  return {
    code: r.code, // 위하고 회사코드
    name: r.nm_krcom,
    bizNo: r.no_biz,
    ceo: r.nm_ceo,
    isPrivate: r.yn_private === 1, // 1: 개인사업자
    bizCond: r.nm_bizcond,
    item: r.nm_item,
    fiscalBegin: r.da_accbegin,
    fiscalEnd: r.da_accend,
    addTaxType: r.ty_addtax, // 부가세 유형 코드(의미 확인 전)
    tags: r.str_comtag || '',
  };
}

let routed = new WeakSet();

/** 로그인된 page로 전체 수임처를 가져온다. 로그인이 안 돼 있으면 { loggedIn: false } */
export async function fetchClients(page) {
  if (!routed.has(page)) {
    await page.route(`**${TMAIN}`, async (route) => {
      const p = new URLSearchParams(route.request().postData() ?? '');
      p.set('limit', '1000');
      await route.continue({ postData: p.toString() });
    });
    routed.add(page);
  }

  const resp = page.waitForResponse((r) => r.url().includes(TMAIN), { timeout: 30000 }).catch(() => null);
  // 로그인이 안 돼 있으면 목록 요청 없이 랜딩·로그인 화면으로 간다
  const landed = page
    .waitForURL((u) => /landing|#\/login/.test(u.href), { timeout: 30000 })
    .then(() => null)
    .catch(() => null);
  // 같은 해시 URL이면 다시 로드되지 않으므로 빈 페이지를 거친다
  await page.goto('about:blank');
  await page.goto(MAIN_URL, { waitUntil: 'domcontentloaded' });

  const res = await Promise.race([resp, landed]);
  if (!res || !page.url().includes('#/main')) return { loggedIn: false, clients: [] };

  const body = await res.json();
  const rows = Array.isArray(body.grp1) ? body.grp1 : [];
  return {
    loggedIn: true,
    total: body.grp8?.[0]?.total ?? rows.length,
    clients: rows.map(pick),
  };
}
