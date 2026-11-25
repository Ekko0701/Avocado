// 앱 아이콘 원본(apps/desktop/build/icon-source.svg)을 1024×1024 PNG 로 그려 Icon Composer 묶음에 넣는다.
//
// 사용법(저장소 루트에서):
//   pnpm --filter @qa/desktop exec electron ../../scripts/render-app-icon.cjs [출력 PNG 경로]
// 기본 출력은 apps/desktop/build/icon.icon/Assets/avocado.png 이다.
//
// Electron 의 화면 밖 창으로 그린다(창이 뜨지 않는다). 흐림·그림자 같은 SVG 필터를 Chromium 그대로 그리려고 이렇게 한다.
// 로컬 파일 하나만 읽고 네트워크는 쓰지 않는다.
const { app, BrowserWindow } = require("electron");
const { readFileSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const SIZE = 1024;
const root = resolve(__dirname, "..");
const source = join(root, "apps/desktop/build/icon-source.svg");
const output = process.argv[2] ? resolve(process.argv[2]) : join(root, "apps/desktop/build/icon.icon/Assets/avocado.png");

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    useContentSize: true,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false },
  });
  // 화면 밖 창은 배율 1 로 그린다. 그림 한 장만 여백 없이 올린다
  const svg = readFileSync(source, "utf8");
  const page = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:${SIZE}px;height:${SIZE}px;overflow:hidden}svg{display:block}</style></head><body>${svg.replace(/<\?xml[^>]*\?>/, "")}</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
  // 첫 그리기가 끝난 뒤에 찍는다
  await new Promise((done) => setTimeout(done, 800));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
  const { width, height } = image.getSize();
  if (width !== SIZE || height !== SIZE) throw new Error(`그림 크기가 ${width}×${height} 이다(${SIZE}×${SIZE} 이어야 한다)`);
  writeFileSync(output, image.toPNG());
  console.log(`${output} (${width}×${height})`);
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
