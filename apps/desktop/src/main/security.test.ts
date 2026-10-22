import { describe, expect, it } from "vitest";
import { devCsp, isAllowedAppUrl, isAllowedExternalUrl, PROD_CSP, secureWebPreferences } from "./security";

describe("secureWebPreferences", () => {
  it("격리·샌드박스를 켜고 Node 통합을 끈다", () => {
    const prefs = secureWebPreferences("/app/preload.js");
    expect(prefs).toMatchObject({
      preload: "/app/preload.js",
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    });
  });
});

describe("isAllowedAppUrl", () => {
  const prod = { devServerUrl: undefined, rendererIndexUrl: "file:///Applications/QA%20Tool.app/out/renderer/index.html" };
  const dev = { devServerUrl: "http://localhost:5173/", rendererIndexUrl: prod.rendererIndexUrl };

  it("운영: renderer index.html 만 허용한다", () => {
    expect(isAllowedAppUrl(prod.rendererIndexUrl, prod)).toBe(true);
    expect(isAllowedAppUrl(`${prod.rendererIndexUrl}#/runs`, prod)).toBe(true);
    expect(isAllowedAppUrl("file:///etc/passwd", prod)).toBe(false);
    expect(isAllowedAppUrl("http://localhost:5173/", prod)).toBe(false);
  });

  it("개발: Vite 서버 출처만 추가로 허용한다", () => {
    expect(isAllowedAppUrl("http://localhost:5173/index.html", dev)).toBe(true);
    expect(isAllowedAppUrl("http://localhost:5174/", dev)).toBe(false);
    expect(isAllowedAppUrl("http://127.0.0.1:5173/", dev)).toBe(false);
  });

  it("외부 URL 과 이상한 스킴을 거부한다", () => {
    for (const url of ["https://github.com", "javascript:alert(1)", "data:text/html,hi", "not a url", ""]) {
      expect(isAllowedAppUrl(url, dev)).toBe(false);
    }
  });
});

describe("CSP", () => {
  it("운영 CSP 는 인라인·eval 스크립트를 허용하지 않는다", () => {
    expect(PROD_CSP).toContain("script-src 'self'");
    expect(PROD_CSP).not.toContain("unsafe-eval");
    expect(PROD_CSP).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(PROD_CSP).toContain("object-src 'none'");
  });

  it("개발 CSP 는 eval 을 허용하지 않고 HMR 웹소켓을 허용한다", () => {
    const csp = devCsp("http://localhost:5173/");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toContain("ws://localhost:5173");
  });
});

describe("isAllowedExternalUrl", () => {
  it("https://github.com 만 연다", () => {
    expect(isAllowedExternalUrl("https://github.com/acme/qa-evidence-2026/blob/abc/runs/report.md")).toBe(true);
    for (const url of [
      "http://github.com/acme",
      "https://github.com.evil.example/x",
      "https://evil.example/github.com",
      "https://user:pw@github.com/acme",
      "https://github.com:444/acme",
      "https://gist.github.com/x",
      "file:///etc/hosts",
      "javascript:alert(1)",
      "not a url",
    ]) {
      expect(isAllowedExternalUrl(url), url).toBe(false);
    }
  });
});
