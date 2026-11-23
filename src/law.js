// 법제처 국가법령정보 Open API 클라이언트
// OC 값은 환경변수 LAW_OC 에서만 읽는다.

const SEARCH_URL = 'https://www.law.go.kr/DRF/lawSearch.do';
const SERVICE_URL = 'https://www.law.go.kr/DRF/lawService.do';

function getOC() {
  const oc = process.env.LAW_OC;
  if (!oc) throw new Error('LAW_OC 환경변수가 없습니다. .env 파일을 확인하세요.');
  return oc;
}

async function callApi(baseUrl, params) {
  // URLSearchParams가 한글 검색어를 UTF-8 퍼센트 인코딩한다
  const qs = new URLSearchParams({ OC: getOC(), type: 'JSON', ...params });
  const res = await fetch(`${baseUrl}?${qs}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`법제처 API HTTP ${res.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    // 인증 실패(OC 미승인, IP 미등록 등) 시 HTML/텍스트가 온다
    throw new Error(`법제처 API가 JSON이 아닌 응답을 보냈습니다: ${text.replace(/\s+/g, ' ').slice(0, 300)}`);
  }
}

const toArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

// ---------- 법령 검색 ----------

/** 법령명으로 현행 법령 목록을 검색한다. */
export async function searchLaws(query, { display = 20 } = {}) {
  const data = await callApi(SEARCH_URL, { target: 'law', query, display: String(display) });
  return toArray(data?.LawSearch?.law).map((l) => ({
    name: l['법령명한글'],
    mst: l['법령일련번호'],
    lawId: l['법령ID'],
    kind: l['법령구분명'],
    ministry: l['소관부처명'],
    promulgationDate: l['공포일자'],
    effectiveDate: l['시행일자'],
    status: l['현행연혁코드'],
  }));
}

/** 법령명과 정확히 일치하는 법령을 찾는다. 없으면 후보 목록과 함께 에러. */
export async function resolveLaw(name) {
  const laws = await searchLaws(name);
  const norm = (s) => String(s).replace(/\s+/g, '');
  const exact = laws.find((l) => norm(l.name) === norm(name));
  if (exact) return exact;
  const candidates = laws.map((l) => l.name).join(', ') || '없음';
  throw new Error(`'${name}'과 정확히 일치하는 법령이 없습니다. 검색 후보: ${candidates}`);
}

// ---------- 법령 본문 ----------

const bodyCache = new Map(); // mst -> Promise<body>

/** 법령 본문(JSON)을 MST 기준으로 가져온다. 프로세스 내에서 캐시한다. */
export function getLawBody(mst) {
  if (!bodyCache.has(mst)) {
    const p = callApi(SERVICE_URL, { target: 'law', MST: String(mst) });
    p.catch(() => bodyCache.delete(mst));
    bodyCache.set(mst, p);
  }
  return bodyCache.get(mst);
}

export function getLawInfo(body) {
  const info = body?.['법령']?.['기본정보'] ?? {};
  return {
    name: info['법령명_한글'],
    kind: info['법종구분']?.content,
    ministry: info['소관부처']?.content,
    effectiveDate: info['시행일자'],
    promulgationNo: info['공포번호'],
  };
}

/** 본문의 실제 조문(장·절 제목 제외) 목록 */
export function getArticles(body) {
  return toArray(body?.['법령']?.['조문']?.['조문단위']).filter((u) => u['조문여부'] === '조문');
}

/** "12", "제12조", "12의2", "제12조의2" 형태를 {no, branch}로 해석 */
export function parseArticleNo(input) {
  const m = String(input).replace(/\s+/g, '').match(/^제?(\d+)(?:조)?(?:의(\d+))?$/);
  if (!m) throw new Error(`조문 번호 형식을 알 수 없습니다: '${input}' (예: 12, 제12조, 12의2)`);
  return { no: m[1], branch: m[2] ?? null };
}

export function articleLabel(unit) {
  const branch = unit['조문가지번호'];
  return `제${unit['조문번호']}조${branch ? `의${branch}` : ''}`;
}

export function findArticle(body, input) {
  const { no, branch } = parseArticleNo(input);
  return getArticles(body).find(
    (u) => u['조문번호'] === no && String(u['조문가지번호'] ?? '') === String(branch ?? '')
  );
}

/** 조문 객체를 읽기 쉬운 텍스트로 변환 (조문 > 항 > 호 > 목) */
export function formatArticle(unit) {
  const lines = [];
  if (unit['조문내용']) lines.push(unit['조문내용']);
  for (const hang of toArray(unit['항'])) {
    if (hang['항내용']) lines.push(toArray(hang['항내용']).flat().join('\n'));
    for (const ho of toArray(hang['호'])) {
      if (ho['호내용']) lines.push('  ' + toArray(ho['호내용']).flat().join('\n  '));
      for (const mok of toArray(ho['목'])) {
        lines.push('    ' + toArray(mok['목내용']).flat().join('\n    '));
      }
    }
  }
  if (unit['조문참고자료']) lines.push(unit['조문참고자료']);
  return lines.map((l) => String(l).trimEnd()).filter(Boolean).join('\n');
}

/** 조문 제목: 조문제목 필드가 없으면 본문 첫 줄의 괄호에서 추출 */
export function articleTitle(unit) {
  if (unit['조문제목']) return unit['조문제목'];
  const text = String(unit['조문내용'] ?? toArray(unit['항'])[0]?.['항내용'] ?? '');
  return text.match(/^\s*제\d+조(?:의\d+)?\(([^)]+)\)/)?.[1] ?? '';
}

/** 법령 본문 안에서 키워드가 들어간 조문을 찾는다. */
export function searchArticles(body, keyword, { limit = 20 } = {}) {
  const words = String(keyword).split(/\s+/).filter(Boolean);
  const hits = [];
  for (const unit of getArticles(body)) {
    const text = formatArticle(unit);
    if (!words.every((w) => text.includes(w))) continue;
    const idx = text.indexOf(words[0]);
    const start = Math.max(0, idx - 60);
    hits.push({
      article: articleLabel(unit),
      title: articleTitle(unit),
      snippet: (start > 0 ? '…' : '') + text.slice(start, idx + 140).replace(/\s+/g, ' ') + '…',
    });
    if (hits.length >= limit) break;
  }
  return hits;
}
