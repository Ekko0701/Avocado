import type { Session, WebContents, WebPreferences } from "electron";

/**
 * Electron 보안 기본값 (PLAN 10.4, CLAUDE.md 5장).
 * 이 파일의 함수는 electron 런타임 없이 단위 테스트할 수 있게 순수하게 유지한다.
 */

export function secureWebPreferences(preloadPath: string): WebPreferences {
  return {
    preload: preloadPath,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    spellcheck: false,
  };
}

/** 운영 빌드의 renderer index.html 에 넣는 CSP. */
export const PROD_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join("; ");

/** 개발 서버(Vite) 응답에 붙이는 CSP. React Refresh 프리앰블과 HMR 웹소켓만 추가로 허용한다. */
export function devCsp(devServerUrl: string): string {
  const origin = new URL(devServerUrl).origin;
  const ws = origin.replace(/^http/, "ws");
  return [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline' ${origin}`,
    `style-src 'self' 'unsafe-inline' ${origin}`,
    `img-src 'self' data: ${origin}`,
    `font-src 'self' ${origin}`,
    `connect-src 'self' ${origin} ${ws}`,
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join("; ");
}

export interface AppUrlPolicy {
  /** 개발 모드의 Vite 서버 URL. 운영에서는 undefined. */
  devServerUrl: string | undefined;
  /** 운영 빌드의 renderer index.html file:// URL. */
  rendererIndexUrl: string;
}

/** 앱 창이 로드하거나 IPC를 보내도 되는 URL인지 판단한다. */
export function isAllowedAppUrl(url: string, policy: AppUrlPolicy): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (policy.devServerUrl) {
    const dev = new URL(policy.devServerUrl);
    if (parsed.origin === dev.origin) return true;
  }
  if (parsed.protocol === "file:") {
    const index = new URL(policy.rendererIndexUrl);
    return parsed.pathname === index.pathname;
  }
  return false;
}

/** 모든 WebContents 에 탐색·새 창·webview 차단을 건다. */
export function hardenWebContents(contents: WebContents, isAllowed: (url: string) => boolean): void {
  contents.on("will-navigate", (event, url) => {
    if (!isAllowed(url)) event.preventDefault();
  });
  contents.on("will-redirect", (event, url) => {
    if (!isAllowed(url)) event.preventDefault();
  });
  contents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
}

/** shell.openExternal 로 열 수 있는 곳(CLAUDE.md 5장). https 의 정확한 호스트만 */
export const EXTERNAL_HOSTS: readonly string[] = ["github.com"];

export function isAllowedExternalUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "" && parsed.port === "" && EXTERNAL_HOSTS.includes(parsed.hostname);
}

/** 세션 단위 보안: 모든 권한 요청 거부, 개발 서버 응답에 CSP 부착. */
export function hardenSession(session: Session, devServerUrl: string | undefined): void {
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  if (devServerUrl) {
    const csp = devCsp(devServerUrl);
    const origin = new URL(devServerUrl).origin;
    session.webRequest.onHeadersReceived((details, callback) => {
      if (!details.url.startsWith(origin)) {
        callback({ responseHeaders: details.responseHeaders });
        return;
      }
      callback({
        responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [csp] },
      });
    });
  }
}
