import { TargetSchema, type Target } from "./schemas";

/**
 * 워크스페이스 폴더 구조(ADR 0032). 경로는 여기서만 만든다(순수 모듈, 파일·Node API 없음).
 * - 1: 종류별. testcases/<앱>/, flows/<앱>/<타깃>/
 * - 2: 앱별. apps/<앱>/testcases/, apps/<앱>/flows/<타깃>/
 * 앱 설정(apps/<앱>/app.yaml·accounts.yaml)과 workspace.yaml 은 두 구조에서 같다.
 */
export type LayoutVersion = 1 | 2;
export const LATEST_LAYOUT: LayoutVersion = 2;

/** 워크스페이스 파일 경로가 가리키는 것 */
export type WorkspacePathInfo =
  | { kind: "testcase"; app: string; id: string }
  | { kind: "flow"; app: string; target: Target; id: string; meta: boolean }
  | { kind: "subflow"; app: string; target: Target; name: string };

export interface WorkspaceLayout {
  version: LayoutVersion;
  /** 앱의 테스트 케이스 폴더 */
  testcaseDir(app: string): string;
  testcasePath(app: string, id: string): string;
  /** 앱의 플로우 폴더(그 아래 타깃 폴더가 있다) */
  flowsDir(app: string): string;
  flowDir(app: string, target: string): string;
  flowPath(app: string, target: string, id: string): string;
  metaPath(app: string, target: string, id: string): string;
  commonDir(app: string, target: string): string;
  /** 이 구조에서 테스트 케이스·플로우·meta·공통 서브플로우 파일이면 그 정보. 아니면 null */
  parse(path: string): WorkspacePathInfo | null;
}

const APP = "[a-z0-9][a-z0-9-]{0,39}";
const TC = "TC-\\d{4,}";

function build(version: LayoutVersion, testcaseDir: (app: string) => string, flowsDir: (app: string) => string, testcaseRe: RegExp, flowRe: RegExp, subflowRe: RegExp): WorkspaceLayout {
  const flowDir = (app: string, target: string) => `${flowsDir(app)}/${target}`;
  return {
    version,
    testcaseDir,
    testcasePath: (app, id) => `${testcaseDir(app)}/${id}.md`,
    flowsDir,
    flowDir,
    flowPath: (app, target, id) => `${flowDir(app, target)}/${id}.yaml`,
    metaPath: (app, target, id) => `${flowDir(app, target)}/${id}.meta.yaml`,
    commonDir: (app, target) => `${flowDir(app, target)}/common`,
    parse(path) {
      const tc = testcaseRe.exec(path);
      if (tc) return { kind: "testcase", app: tc[1] ?? "", id: tc[2] ?? "" };
      const flow = flowRe.exec(path);
      const flowTarget = TargetSchema.safeParse(flow?.[2]);
      if (flow && flowTarget.success) return { kind: "flow", app: flow[1] ?? "", target: flowTarget.data, id: flow[3] ?? "", meta: flow[4] !== undefined };
      const sub = subflowRe.exec(path);
      const subTarget = TargetSchema.safeParse(sub?.[2]);
      if (sub && subTarget.success) return { kind: "subflow", app: sub[1] ?? "", target: subTarget.data, name: sub[3] ?? "" };
      return null;
    },
  };
}

const LAYOUTS: Record<LayoutVersion, WorkspaceLayout> = {
  1: build(
    1,
    (app) => `testcases/${app}`,
    (app) => `flows/${app}`,
    new RegExp(`^testcases/(${APP})/(${TC})\\.md$`),
    new RegExp(`^flows/(${APP})/([^/]+)/(${TC})(\\.meta)?\\.yaml$`),
    new RegExp(`^flows/(${APP})/([^/]+)/common/([^/]+\\.ya?ml)$`),
  ),
  2: build(
    2,
    (app) => `apps/${app}/testcases`,
    (app) => `apps/${app}/flows`,
    new RegExp(`^apps/(${APP})/testcases/(${TC})\\.md$`),
    new RegExp(`^apps/(${APP})/flows/([^/]+)/(${TC})(\\.meta)?\\.yaml$`),
    new RegExp(`^apps/(${APP})/flows/([^/]+)/common/([^/]+\\.ya?ml)$`),
  ),
};

export function layout(version: LayoutVersion): WorkspaceLayout {
  return LAYOUTS[version];
}

/** workspace.yaml 의 schemaVersion 으로 구조를 고른다. 2 가 아니면(없거나 읽지 못해도) 예전 구조로 본다 */
export function layoutForSchemaVersion(schemaVersion: unknown): WorkspaceLayout {
  return layout(schemaVersion === 2 ? 2 : 1);
}
