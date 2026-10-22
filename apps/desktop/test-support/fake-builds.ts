import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 시뮬레이터용 .app 흉내: Info.plist 만 있는 폴더 */
export function makeFakeApp(dir: string, opts: { name?: string; bundleId?: string; version?: string; build?: string; platform?: string } = {}): string {
  const app = join(dir, `${opts.name ?? "Fake"}.app`);
  mkdirSync(app, { recursive: true });
  writeFileSync(
    join(app, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${opts.bundleId ?? "net.example.fake"}</string>
<key>CFBundleShortVersionString</key><string>${opts.version ?? "1.2.3"}</string>
<key>CFBundleVersion</key><string>${opts.build ?? "45"}</string>
<key>CFBundleSupportedPlatforms</key><array><string>${opts.platform ?? "iPhoneSimulator"}</string></array>
</dict></plist>
`,
  );
  writeFileSync(join(app, "Fake"), "binary");
  return app;
}

/** QA_BUILD_INFO 에 결과를 적는 가짜 빌드 스크립트 */
export function makeScript(dir: string, body: string): string {
  const file = join(dir, "build.sh");
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}
