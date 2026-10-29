import { app, autoUpdater } from "electron";
import { accessSync, constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { startUpdateFeed } from "./update-feed";
import { UpdateError, type AppInstaller } from "./update-service";

const PREPARE_TIMEOUT_MS = 10 * 60_000;

/**
 * 실행 중인 .app 을 Electron autoUpdater(Squirrel.Mac)로 바꿔 끼운다(ADR 0027).
 * 받기·SHA-256·서명 확인은 UpdateService 가 하고, 여기서는 확인을 마친 .zip 을 127.0.0.1 피드로 넘긴다.
 * Squirrel.Mac 도 받은 앱이 지금 앱과 같은 서명 요건(팀 ID)을 만족하는지 다시 본다
 */
export function createSquirrelInstaller(): AppInstaller {
  return {
    blocker() {
      if (process.platform !== "darwin" || !app.isPackaged) return "패키징한 macOS 앱에서만 재시작해서 업데이트한다";
      if (!app.isInApplicationsFolder()) return "응용 프로그램 폴더에서 실행하지 않아 재시작해서 업데이트할 수 없다. 설치 파일(.dmg)로 받는다";
      // exe 는 <앱>.app/Contents/MacOS/<이름>. 앱을 바꿔 끼우려면 앱이 든 폴더에 쓸 수 있어야 한다
      const folder = dirname(resolve(app.getPath("exe"), "../../.."));
      try {
        accessSync(folder, constants.W_OK);
      } catch {
        return `${folder} 에 쓸 권한이 없어 재시작해서 업데이트할 수 없다. 설치 파일(.dmg)로 받는다`;
      }
      return null;
    },
    async prepare(zipFile) {
      const feed = await startUpdateFeed(zipFile);
      try {
        await new Promise<void>((done, fail) => {
          const finish = (error?: Error) => {
            clearTimeout(timer);
            autoUpdater.removeListener("update-downloaded", onDownloaded);
            autoUpdater.removeListener("update-not-available", onNotAvailable);
            autoUpdater.removeListener("error", onError);
            if (error) fail(error);
            else done();
          };
          const onDownloaded = () => finish();
          const onNotAvailable = () => finish(new UpdateError("업데이트를 준비하지 못했다: 피드에서 받을 것이 없다고 했다"));
          const onError = (error: Error) => finish(new UpdateError(`업데이트를 준비하지 못했다: ${error.message}`));
          const timer = setTimeout(() => finish(new UpdateError("업데이트 준비가 10분 안에 끝나지 않았다")), PREPARE_TIMEOUT_MS);
          autoUpdater.on("update-downloaded", onDownloaded);
          autoUpdater.on("update-not-available", onNotAvailable);
          autoUpdater.on("error", onError);
          autoUpdater.setFeedURL({ url: feed.url, serverType: "default" });
          autoUpdater.checkForUpdates();
        });
      } finally {
        await feed.close();
      }
    },
    quitAndInstall() {
      // IPC 응답이 화면에 닿은 뒤 끝낸다. Squirrel 이 앱을 바꿔 끼우고 다시 연다
      setTimeout(() => autoUpdater.quitAndInstall(), 300);
    },
  };
}
