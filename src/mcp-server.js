// 법제처 국가법령정보 MCP 서버 (stdio)
// Claude Code가 자동으로 실행/종료한다. 직접 켜둘 필요 없음.

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  searchLaws,
  resolveLaw,
  getLawBody,
  getLawInfo,
  findArticle,
  formatArticle,
  articleLabel,
  searchArticles,
} from './law.js';

// 프로젝트 루트의 .env 에서 LAW_OC 로드
const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (fs.existsSync(envPath)) process.loadEnvFile(envPath);

// 서버 instructions: Claude가 연결 시 자동으로 읽는 답변 규칙 (별도 Skill 없이도 적용)
const INSTRUCTIONS = `한국 세법·법령 질문(소득세, 법인세, 부가가치세, 상속·증여세, 국세기본법, 조세특례제한법, 지방세 등의 과세 요건·비과세·공제·세율·신고기한 등)에는 기억에 의존하지 말고 이 서버의 도구로 현행 법령 원문을 조회한 뒤 답한다. 세법은 매년 개정되므로 학습된 기억은 틀리거나 오래됐을 수 있다.

절차:
1. 법령명이 불확실하면 search_laws로 정확한 법령명을 찾는다.
2. 조 번호를 알면 get_article, 모르면 search_articles로 키워드를 바꿔가며 찾는다.
3. 법률 조문에 "대통령령으로 정하는", "재정경제부령으로 정하는" 등이 있으면 시행령·시행규칙도 조회한다. 금액·한도·요건 같은 세부 내용은 대부분 시행령에 있다.
4. 조회한 원문만 근거로 답한다. 원문에 없는 내용(실무 관행, 예규·판례 등)은 "원문 외 참고"로 구분한다.
5. 필요한 조문만 골라 조회한다(사용량 절약).

답변 형식:
1. 결론: 한두 문장
2. 근거 조문: 법령명·조·항·호·목 (예: 소득세법 제12조제3호러목, 같은 법 시행령 제17조의2제1항)
3. 원문 발췌: 판단에 쓴 부분만
4. 시행일: 조회 결과의 법령 시행일·조문 시행일
5. 주의사항: 해석이 갈리거나 사실관계에 따라 달라지는 부분, 전문가 확인이 필요한 부분

조회에 실패하면 실패 사실과 오류 메시지를 알리고, 조회 없이 답하는 내용은 "원문 미확인"으로 표시한다.`;

const server = new McpServer({ name: 'korean-law', version: '1.1.0' }, { instructions: INSTRUCTIONS });

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const fail = (e) => ({ content: [{ type: 'text', text: `오류: ${e.message}` }], isError: true });
const fmtDate = (d) => (d && /^\d{8}$/.test(d) ? `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6)}` : d ?? '');

server.registerTool(
  'search_laws',
  {
    title: '법령 검색',
    description:
      '법제처 국가법령정보에서 법령명으로 현행 법령(법률·시행령·시행규칙 등)을 검색한다. 정확한 법령명을 모를 때 먼저 사용한다.',
    inputSchema: {
      query: z.string().describe('법령명 또는 그 일부. 예: "소득세법", "부가가치세법 시행령"'),
    },
  },
  async ({ query }) => {
    try {
      const laws = await searchLaws(query);
      if (laws.length === 0) return text(`'${query}' 검색 결과가 없습니다.`);
      const lines = laws.map(
        (l) => `- ${l.name} (${l.kind}, ${l.ministry}) 공포 ${fmtDate(l.promulgationDate)}, 시행 ${fmtDate(l.effectiveDate)}`
      );
      return text(`'${query}' 검색 결과 ${laws.length}건\n${lines.join('\n')}`);
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  'get_article',
  {
    title: '조문 조회',
    description:
      '현행 법령의 특정 조문 원문(항·호·목 포함)을 가져온다. 세법 질문에 답할 때 근거 조문을 확인하는 데 사용한다.',
    inputSchema: {
      law_name: z.string().describe('정확한 법령명. 예: "소득세법", "소득세법 시행령"'),
      article: z.string().describe('조문 번호. 예: "12", "제12조", "12의2"'),
    },
  },
  async ({ law_name, article }) => {
    try {
      const law = await resolveLaw(law_name);
      const body = await getLawBody(law.mst);
      const unit = findArticle(body, article);
      if (!unit) return fail(new Error(`${law.name}에 ${article} 조문이 없습니다.`));
      const info = getLawInfo(body);
      const header =
        `[${info.name ?? law.name} ${articleLabel(unit)}] ` +
        `법령 시행 ${fmtDate(law.effectiveDate)} · 공포 ${fmtDate(law.promulgationDate)} · 이 조문 시행 ${fmtDate(unit['조문시행일자'])}`;
      return text(`${header}\n\n${formatArticle(unit)}`);
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  'search_articles',
  {
    title: '조문 키워드 검색',
    description:
      '특정 법령 안에서 키워드가 들어간 조문을 찾는다. 조문 번호를 모를 때 사용한 뒤 get_article로 원문을 확인한다. 공백으로 구분한 여러 단어는 모두 포함된 조문만 찾는다.',
    inputSchema: {
      law_name: z.string().describe('정확한 법령명. 예: "소득세법 시행령"'),
      keyword: z.string().describe('찾을 단어. 예: "식사대", "자녀 보육"'),
    },
  },
  async ({ law_name, keyword }) => {
    try {
      const law = await resolveLaw(law_name);
      const body = await getLawBody(law.mst);
      const hits = searchArticles(body, keyword);
      if (hits.length === 0) return text(`${law.name}에서 '${keyword}'가 들어간 조문이 없습니다.`);
      const lines = hits.map((h) => `- ${h.article}${h.title ? `(${h.title})` : ''}: ${h.snippet}`);
      return text(`${law.name}에서 '${keyword}' 포함 조문 ${hits.length}건\n${lines.join('\n')}`);
    } catch (e) {
      return fail(e);
    }
  }
);

await server.connect(new StdioServerTransport());
