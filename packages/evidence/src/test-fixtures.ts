import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** 테스트 전용. fixtures/README.md 의 가짜 비밀 값(scripts/record-fixtures.sh 와 같아야 한다) */
export const FAKE_ACCOUNT_ID = "qa-fixture-id-7f3a";
export const FAKE_ACCOUNT_PW = 'fixture"Pw&2026';
export const FAKE_SECRETS = [FAKE_ACCOUNT_ID, FAKE_ACCOUNT_PW] as const;

export const FIXTURES = resolve(__dirname, "..", "fixtures");
export const FIXTURE_NAMES = ["ios-pass", "ios-fail", "android-pass", "android-fail", "ios-driver-timeout"] as const;
export type FixtureName = (typeof FIXTURE_NAMES)[number];

export const fixtureDir = (name: FixtureName) => join(FIXTURES, name);

/** 픽스처를 임시 폴더로 복사한다(원본 픽스처를 바꾸는 테스트용) */
export function copyFixture(name: FixtureName): string {
  const dir = join(mkdtempSync(join(tmpdir(), "qa-evidence-")), name);
  cpSync(fixtureDir(name), dir, { recursive: true });
  return dir;
}
