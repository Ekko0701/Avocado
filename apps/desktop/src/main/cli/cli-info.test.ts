import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cliInfo } from "./cli-info";

let dir: string;
let home: string;
let resources: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qa-cli-info-"));
  home = join(dir, "home");
  resources = join(dir, "Avocado's.app", "Contents", "Resources");
  mkdirSync(join(resources, "bin"), { recursive: true });
  writeFileSync(join(resources, "bin", "avocado"), "#!/bin/sh\n");
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("터미널 명령 정보(T-122)", () => {
  it("패키징한 앱: 거는 명령은 앱 경로를 따옴표로 감싸고, 링크가 없으면 none", () => {
    const info = cliInfo({ packaged: true, resourcesPath: resources, home });
    expect(info).toMatchObject({ available: true, link: "none", linkPath: "~/.local/bin/avocado" });
    expect(info.linkCommand).toBe(`mkdir -p ~/.local/bin && ln -sf '${join(dir, "Avocado'\\''s.app", "Contents", "Resources", "bin", "avocado")}' ~/.local/bin/avocado`);
  });

  it("링크가 이 앱의 명령이면 this, 다른 파일이나 깨진 링크면 other", () => {
    const link = join(home, ".local", "bin", "avocado");
    symlinkSync(join(resources, "bin", "avocado"), link);
    expect(cliInfo({ packaged: true, resourcesPath: resources, home }).link).toBe("this");
    rmSync(link);
    symlinkSync(join(dir, "gone"), link);
    expect(cliInfo({ packaged: true, resourcesPath: resources, home }).link).toBe("other");
    rmSync(link);
    writeFileSync(link, "#!/bin/sh\n");
    expect(cliInfo({ packaged: true, resourcesPath: resources, home }).link).toBe("other");
  });

  it("개발 실행은 번들 명령이 없다(pnpm avocado)", () => {
    expect(cliInfo({ packaged: false, resourcesPath: resources, home })).toMatchObject({ available: false, scriptPath: null, linkCommand: null });
  });
});
