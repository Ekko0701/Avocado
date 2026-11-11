# 개발

Avocado 를 소스에서 빌드하고 검사하는 방법과 저장소 구조입니다.

## 준비

- Apple Silicon Mac, Xcode
- Node 22.12 이상(24 LTS 권장), pnpm(corepack)

개발 Mac 점검은 `scripts/bootstrap-mac.sh` 로 합니다. 기본은 읽기 전용이고 `--all` 을 주면 설치·부팅까지 합니다.

## 빌드와 실행

```bash
corepack enable
pnpm install
pnpm dev            # 개발 실행
pnpm package        # .app·dmg 만들기 (apps/desktop/dist)
```

## 앱 아이콘

아이콘 원본은 `apps/desktop/build/icon-source.svg` 입니다(1024×1024, 여백 없이 꽉 채운 그림. 둥근 모서리는 시스템이 깎습니다). 고친 뒤 아래 명령으로 Icon Composer 묶음(`apps/desktop/build/icon.icon`)의 그림을 다시 만듭니다. 패키징할 때 electron-builder 가 `actool`(Xcode 26 이상)로 아이콘을 컴파일합니다.

```bash
pnpm --filter @qa/desktop exec electron ../../scripts/render-app-icon.cjs
```

## 검사

```bash
pnpm lint && pnpm typecheck && pnpm test
pnpm test:e2e       # Electron 빌드 후 Playwright E2E (창이 잠깐 뜬다)
```

화면을 사용자처럼 몰아 확인하는 여정은 `apps/desktop/verify` 에 있습니다. 격리된 앱 데이터와 가짜 GitHub 으로 돌고, 스크린샷을 `out/verify` 에 남깁니다.

```bash
pnpm --filter @qa/desktop verify home
```

README 의 화면은 `readme` 여정이 예시 워크스페이스와 실제 Maestro 산출물 픽스처로 찍습니다. 결과는 `out/readme` 에 나오고, 고른 것을 `docs/images` 로 옮깁니다.

```bash
pnpm --filter @qa/desktop verify readme
```

## 구조

```
apps/desktop          Electron 앱 (main: 서비스·IPC, preload: window.qa, renderer: React 화면)
packages/shared       Zod 스키마·타입
packages/workspace    워크스페이스 파일·린트
packages/maestro      Maestro CLI 래퍼·플로우 규약
packages/evidence     산출물 파서·가림·요약 묶음
packages/agent        MCP 브리지·프롬프트
packages/remote       GitHub 연동
examples/qa-workspace 예시 워크스페이스(가상 앱)
```

새 워크스페이스 저장소는 `scripts/workspace/create-workspace-repo.sh` 로 `examples/qa-workspace` 를 복사해 만듭니다.

## 보안 원칙

- API 키·GitHub 토큰·테스트 계정 값은 macOS 키체인(Electron safeStorage)으로만 암호화해 저장하고, 화면에는 저장 여부만 보냅니다.
- 렌더러는 Node·파일·네트워크에 직접 접근하지 않고 정해진 IPC 만 씁니다.
- 플로우 실행 때 계정 값은 앱이 넘기고, 증적은 가린 사본만 보이고 올립니다.
- 재생 경로에는 LLM 호출이 없습니다.
