# Avocado

모바일 앱 E2E 테스트를 위한 macOS 데스크톱 앱입니다. 기획자가 자연어로 쓴 TC(테스트 케이스)를 각자의 Claude 가 Maestro 플로우로 만들고, 승인된 플로우는 LLM 없이 재생해 스텝마다 증적(캡처·로그)을 남깁니다.

## 흐름

1. **TC 작성**: TC 메뉴에서 쓰면 규칙 검사(린트)를 거쳐 그 TC 의 작업 브랜치에 커밋됩니다.
2. **플로우 만들기**: Claude(데스크톱 앱 또는 Claude Code)가 시뮬레이터에서 TC 를 직접 따라가며 플로우를 씁니다. Avocado 가 같은 기기에서 두 번 재생해 둘 다 통과하면 커밋하고, 마지막 재생을 골든 런(기준 실행)으로 남깁니다.
3. **PR 작성**: 작업 브랜치를 PR 로 올립니다. 리뷰어가 머지하면 승인입니다.
4. **실행**: 승인된 플로우를 Claude 없이 재생합니다. 결과 화면에서 스텝 타임라인, 실패 캡처, 로그를 봅니다.
5. **화면 판정**(선택): Claude 가 캡처를 보고 정상 화면인지 배지로 표시합니다.

서버는 없습니다. TC·플로우는 팀의 GitHub 워크스페이스 저장소로, 증적 요약은 연도별 증적 저장소로 공유하고, 원본 증적은 각자의 Mac 에만 둡니다.

## 요구 사항

- macOS (Apple Silicon)
- Xcode (iOS 시뮬레이터). Android 는 선택(Android SDK·에뮬레이터)
- Claude 데스크톱 앱 또는 Claude Code (플로우 만들기·화면 판정)
- GitHub 저장소 2개: 워크스페이스(TC·플로우), 증적(이름이 연도로 끝남, 예: `…-qa-evidence-2026`)
- Maestro 와 JRE 는 Avocado 의 설정 마법사가 고정 버전으로 내려받습니다.

## 설치와 사용

- [설치와 첫 실행](docs/user-guide/install.md)
- [내 Claude 로 플로우 만들기](docs/user-guide/claude-connect.md)
- [TC 쓰기](docs/user-guide/testcase.md)

## 소스에서 빌드

Node 22.12 이상(24 LTS 권장), pnpm(corepack).

```bash
corepack enable
pnpm install
pnpm dev            # 개발 실행
pnpm package        # .app·dmg 만들기 (apps/desktop/dist)
```

검사:

```bash
pnpm lint && pnpm typecheck && pnpm test
pnpm test:e2e       # Electron 빌드 후 Playwright E2E
```

개발 Mac 점검은 `scripts/bootstrap-mac.sh`(기본은 읽기 전용)로 합니다. 새 워크스페이스 저장소는 `scripts/workspace/create-workspace-repo.sh` 로 `examples/qa-workspace` 를 복사해 만듭니다.

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

## 보안

- API 키·GitHub 토큰·테스트 계정 값은 macOS 키체인(Electron safeStorage)에만 저장하고 화면에는 저장 여부만 보입니다.
- 플로우 실행 때 계정 값은 앱이 넘기고, 증적에서는 가린 사본만 보이고 올립니다.
- 렌더러는 Node·파일·네트워크에 직접 접근하지 않고, 정해진 IPC 만 씁니다.
