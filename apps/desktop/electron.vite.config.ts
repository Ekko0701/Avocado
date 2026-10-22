import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import { PROD_CSP } from "./src/main/security";

/** 운영 빌드의 index.html 에만 엄격한 CSP 메타 태그를 넣는다. 개발 서버는 main 이 응답 헤더로 붙인다. */
function productionCsp(): Plugin {
  return {
    name: "qa-production-csp",
    apply: "build",
    transformIndexHtml(html) {
      return html.replace(
        "<head>",
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${PROD_CSP}" />`,
      );
    },
  };
}

// 앱 코드가 쓰는 라이브러리는 devDependencies 에 두어 번들에 포함한다.
// dependencies 는 SQLite 같은 네이티브 모듈 전용으로 남겨 둔다(PLAN 3.3).
export default defineConfig({
  main: {
    build: {
      externalizeDeps: true,
    },
  },
  preload: {
    build: {
      // 샌드박스 preload 는 require 할 수 있는 모듈이 제한되므로 전부 번들한다.
      externalizeDeps: false,
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    plugins: [react(), productionCsp()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/renderer/index.html"),
      },
    },
  },
});
