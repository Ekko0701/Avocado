# 예시 워크스페이스

`qa-workspace` 저장소 구조(앱별 폴더, `schemaVersion: 2`)를 따른 예시다. 한 앱의 설정·테스트 케이스·플로우가 `apps/<앱>/` 아래에 모여 있다. 두 앱 모두 예시용 가상 앱이라 실제로 빌드·재생하지 않는다. 앱의 테스트와 템플릿 저장소의 출발점으로 쓴다.

- **Demo (메모 앱).** `apps/demo/accounts.yaml`(키 이름만), `apps/demo/testcases/TC-0101.md`(이메일 회원가입 → 홈 화면), `apps/demo/flows/ios/TC-0101.yaml`·`TC-0101.meta.yaml`, `common/launch-clean.yaml`.
- **Sample (로그인 앱).** `apps/sample/testcases/TC-0002.md`(학생 계정 로그인), `apps/sample/flows/ios/TC-0002.yaml`, 공통 서브플로우(`common/`: 상태를 지운 실행과 첫 실행 팝업·온보딩, 앱 키보드 막대 닫기, 암호 저장 팝업).

계정 값은 키 이름(`${DEMO_TEST_PASSWORD}`, `${SAMPLE_TEST_STUDENT_ID}`)만 쓰고, 앱이 키체인의 `account:<앱>:<KEY>` 에서 읽어 넘긴다.

새 워크스페이스는 `scripts/workspace/create-workspace-repo.sh` 로 이 폴더를 복사해 만든다(`--template` 으로 다른 폴더를 줄 수 있다).
