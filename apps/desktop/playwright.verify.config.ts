import { defineConfig } from "@playwright/test";

// 검증 하네스(.claude/skills/verify-avocado). 사용자처럼 앱을 몰고 증적을 out/verify 에 남긴다. pnpm test:e2e 에는 들어가지 않는다
export default defineConfig({
  testDir: "./verify",
  testMatch: "**/*.verify.ts",
  timeout: 180_000,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
});
