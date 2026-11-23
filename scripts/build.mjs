// 배포 파일 빌드
//   dist/korean-law.mcpb            : Claude 데스크톱 확장 파일
//   dist/korean-tax-law-skill.zip   : Claude Skill 업로드 파일
// 실행: npm run build

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = path.join(root, 'build', 'korean-law');
const distDir = path.join(root, 'dist');
const run = (cmd, cwd = root) => execSync(cmd, { cwd, stdio: 'inherit' });
const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj[k]]));

const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));

// 1. 확장 폴더 구성 (OC 값은 넣지 않는다: 설치할 때 사용자가 입력)
fs.rmSync(path.join(root, 'build'), { recursive: true, force: true });
fs.mkdirSync(path.join(buildDir, 'server'), { recursive: true });
fs.mkdirSync(distDir, { recursive: true });

fs.copyFileSync(path.join(root, 'extension', 'manifest.json'), path.join(buildDir, 'manifest.json'));
fs.copyFileSync(path.join(root, 'src', 'mcp-server.js'), path.join(buildDir, 'server', 'index.js'));
fs.copyFileSync(path.join(root, 'src', 'law.js'), path.join(buildDir, 'server', 'law.js'));
fs.writeFileSync(
  path.join(buildDir, 'package.json'),
  JSON.stringify(
    {
      name: manifest.name,
      version: manifest.version,
      private: true,
      type: 'module',
      // 확장에는 MCP 서버 실행에 필요한 패키지만 넣는다 (playwright 등 다른 의존성 제외)
      dependencies: pick(rootPkg.dependencies, ['@modelcontextprotocol/sdk', 'zod']),
    },
    null,
    2
  )
);

// 2. 실행에 필요한 패키지만 설치
run('npm install --omit=dev --no-audit --no-fund', buildDir);

// 3. 확장 파일 패킹
const mcpb = path.join(distDir, 'korean-law.mcpb');
fs.rmSync(mcpb, { force: true });
run(`npx mcpb validate "${path.join(buildDir, 'manifest.json')}"`);
run(`npx mcpb pack "${buildDir}" "${mcpb}"`);

// 4. Skill zip (zip 안에 korean-tax-law/SKILL.md 구조)
const skillZip = path.join(distDir, 'korean-tax-law-skill.zip');
fs.rmSync(skillZip, { force: true });
// Windows 기본 bsdtar 사용 (Git의 GNU tar는 zip을 못 만들고 C: 경로를 원격으로 오인한다)
const zipCmd =
  process.platform === 'win32'
    ? `"${path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')}" -a -c -f ../dist/korean-tax-law-skill.zip korean-tax-law`
    : `zip -r ../dist/korean-tax-law-skill.zip korean-tax-law`;
run(zipCmd, path.join(root, 'skill'));

console.log(`\n완료:\n  ${mcpb}\n  ${skillZip}`);
