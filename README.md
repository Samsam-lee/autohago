# autohago

법제처 국가법령정보 Open API로 현행 법령·조문을 조회하는 MCP 서버(`korean-law`)입니다.
Claude Code에서 세법 등 법령 질문에 답할 때 실제 조문을 근거로 확인할 수 있습니다.

## 제공 도구

| 도구 | 설명 |
| --- | --- |
| `search_laws` | 법령명으로 현행 법령 검색 |
| `get_article` | 특정 조문 원문(항·호·목 포함) 조회 |
| `search_articles` | 법령 안에서 키워드가 들어간 조문 검색 |

## 설치

필요: [Node.js](https://nodejs.org) 20.12 이상, [Claude Code](https://claude.com/claude-code)

```bash
git clone https://github.com/Samsam-lee/autohago.git
cd autohago
npm install
```

### 법제처 OC 발급 및 설정

1. [국가법령정보 공동활용](https://open.law.go.kr)에 가입하고 OPEN API 사용을 신청합니다.
2. `.env.example`을 복사해 `.env`를 만들고, 발급받은 OC 값을 넣습니다.

```bash
cp .env.example .env   # Windows PowerShell: Copy-Item .env.example .env
```

```
LAW_OC=발급받은_OC값
```

> OC 값은 각자 본인 것을 사용하세요. `.env`는 `.gitignore`에 포함되어 커밋되지 않습니다.

## 사용

이 폴더에서 Claude Code를 실행하면 `.mcp.json`에 등록된 `korean-law` 서버가 자동으로 실행됩니다.
처음 실행할 때 프로젝트 MCP 서버 사용을 승인하라는 안내가 나오면 승인하세요.
`/mcp` 명령으로 연결 상태를 확인할 수 있습니다.
