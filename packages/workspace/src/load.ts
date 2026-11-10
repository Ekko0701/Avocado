import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import { AccountsSchema, AppConfigSchema, type Accounts, FlowMetaSchema, TargetSchema, TC_ID, WorkspaceConfigSchema, type AppConfig, type FlowMeta, type Target, type WorkspaceConfig } from "./schemas";
import { layoutForSchemaVersion, type WorkspaceLayout } from "./layout";
import { parseTestcase, type Issue, type TestcaseDoc } from "./testcase";

export interface TestcaseEntry {
  path: string;
  app: string;
  id: string;
  doc: TestcaseDoc | null;
}

export interface FlowEntry {
  path: string;
  app: string;
  target: Target;
  /** 파일 이름의 TC id. 공통 서브플로우(common/)는 null */
  tcId: string | null;
  meta: FlowMeta | null;
}

export interface LoadedWorkspace {
  config: WorkspaceConfig | null;
  /** 이 워크스페이스의 폴더 구조(ADR 0032). workspace.yaml 을 읽지 못하면 예전 구조로 본다 */
  layout: WorkspaceLayout;
  apps: Record<string, { config: AppConfig | null; accounts: Accounts }>;
  testcases: TestcaseEntry[];
  flows: FlowEntry[];
  issues: Issue[];
}

const rel = (root: string, p: string) => relative(root, p).split(sep).join("/");

function readYaml<T>(root: string, file: string, schema: z.ZodType<T>, issues: Issue[]): T | null {
  const path = rel(root, file);
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, "utf8"));
  } catch (error) {
    issues.push({ path, line: null, message: `YAML 오류: ${error instanceof Error ? error.message : String(error)}` });
    return null;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    for (const i of parsed.error.issues) issues.push({ path, line: null, message: `${i.path.join(".") || "(전체)"}: ${i.message}` });
    return null;
  }
  return parsed.data;
}

const list = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : []);
const isDir = (p: string) => statSync(p).isDirectory();

/** 워크스페이스 폴더의 구조. workspace.yaml 의 schemaVersion 만 본다(형식이 틀려도 그 값은 읽는다) */
export function layoutOf(root: string): WorkspaceLayout {
  const wsFile = join(root, "workspace.yaml");
  if (!existsSync(wsFile)) return layoutForSchemaVersion(undefined);
  try {
    const raw: unknown = parseYaml(readFileSync(wsFile, "utf8"));
    return layoutForSchemaVersion(raw !== null && typeof raw === "object" ? (raw as { schemaVersion?: unknown }).schemaVersion : undefined);
  } catch {
    // YAML 오류는 loadWorkspace 가 문제 목록에 넣는다
    return layoutForSchemaVersion(undefined);
  }
}

/**
 * 워크스페이스 폴더를 읽고 검증한다(PLAN 4.1). 문제는 issues 에 모으고 버리지 않는다.
 * 잘못된 파일도 목록에는 남겨(doc·meta 가 null) 화면이 고칠 대상을 보여 줄 수 있게 한다.
 */
export function loadWorkspace(root: string): LoadedWorkspace {
  const issues: Issue[] = [];
  const wsFile = join(root, "workspace.yaml");
  const config = existsSync(wsFile) ? readYaml(root, wsFile, WorkspaceConfigSchema, issues) : null;
  if (!existsSync(wsFile)) issues.push({ path: "workspace.yaml", line: null, message: "workspace.yaml 이 없다" });

  const apps: LoadedWorkspace["apps"] = {};
  for (const app of config?.apps ?? []) {
    const appFile = join(root, "apps", app, "app.yaml");
    const accFile = join(root, "apps", app, "accounts.yaml");
    const appConfig = existsSync(appFile) ? readYaml(root, appFile, AppConfigSchema, issues) : null;
    if (!existsSync(appFile)) issues.push({ path: `apps/${app}/app.yaml`, line: null, message: "앱 설정이 없다" });
    const accounts = existsSync(accFile) ? readYaml(root, accFile, AccountsSchema, issues) : {};
    apps[app] = { config: appConfig, accounts: accounts ?? {} };
  }
  const known = new Set(Object.keys(apps));

  const lay = layoutOf(root);
  // 앱 폴더 이름: 예전 구조는 testcases/·flows/ 아래, 새 구조는 apps/ 아래에서 그 폴더를 가진 것
  const appDirs = (kind: "testcases" | "flows") =>
    lay.version === 1
      ? list(join(root, kind)).filter((a) => isDir(join(root, kind, a)))
      : list(join(root, "apps")).filter((a) => isDir(join(root, "apps", a)) && existsSync(join(root, "apps", a, kind)) && isDir(join(root, "apps", a, kind)));
  // 다른 구조의 자리에 남은 폴더는 읽지 않으므로 문제로 알린다(조용히 무시하지 않는다)
  if (lay.version === 2) {
    for (const kind of ["testcases", "flows"]) {
      if (existsSync(join(root, kind))) issues.push({ path: kind, line: null, message: `예전 위치의 폴더다. 새 구조(schemaVersion 2)에서는 apps/<앱>/${kind} 에 둔다` });
    }
  } else {
    for (const app of list(join(root, "apps")).filter((a) => isDir(join(root, "apps", a)))) {
      for (const kind of ["testcases", "flows"]) {
        if (existsSync(join(root, "apps", app, kind))) issues.push({ path: `apps/${app}/${kind}`, line: null, message: `새 구조의 폴더다. 지금 구조(schemaVersion 1)에서는 ${kind}/${app} 에 둔다` });
      }
    }
  }

  const testcases: TestcaseEntry[] = [];
  for (const app of appDirs("testcases")) {
    const tcDir = lay.testcaseDir(app);
    if (!known.has(app)) issues.push({ path: tcDir, line: null, message: "workspace.yaml 의 apps 에 없는 앱이다" });
    for (const name of list(join(root, tcDir)).filter((n) => n.endsWith(".md"))) {
      const path = `${tcDir}/${name}`;
      const id = name.replace(/\.md$/, "");
      if (!TC_ID.test(id)) issues.push({ path, line: null, message: "파일 이름은 TC-0001.md 형식" });
      const parsed = parseTestcase(readFileSync(join(root, path), "utf8"), path);
      if (!parsed.ok) {
        issues.push(...parsed.issues);
        testcases.push({ path, app, id, doc: null });
        continue;
      }
      if (parsed.doc.frontMatter.id !== id) issues.push({ path, line: 2, message: `id(${parsed.doc.frontMatter.id})가 파일 이름과 다르다` });
      if (parsed.doc.frontMatter.app !== app) issues.push({ path, line: 2, message: `app(${parsed.doc.frontMatter.app})이 폴더(${app})와 다르다` });
      testcases.push({ path, app, id, doc: parsed.doc });
    }
  }

  const flows: FlowEntry[] = [];
  for (const app of appDirs("flows")) {
    const flowsDir = lay.flowsDir(app);
    if (!known.has(app)) issues.push({ path: flowsDir, line: null, message: "workspace.yaml 의 apps 에 없는 앱이다" });
    for (const target of list(join(root, flowsDir)).filter((t) => isDir(join(root, flowsDir, t)))) {
      const t = TargetSchema.safeParse(target);
      if (!t.success) {
        issues.push({ path: `${flowsDir}/${target}`, line: null, message: "타깃 폴더는 ios, android, flutter-ios, flutter-android" });
        continue;
      }
      const flowDir = lay.flowDir(app, target);
      const dir = join(root, flowDir);
      for (const name of list(dir).filter((n) => /\.ya?ml$/.test(n) && !n.endsWith(".meta.yaml"))) {
        const tcId = name.replace(/\.ya?ml$/, "");
        const metaFile = join(dir, `${tcId}.meta.yaml`);
        flows.push({
          path: `${flowDir}/${name}`,
          app,
          target: t.data,
          tcId: TC_ID.test(tcId) ? tcId : null,
          meta: existsSync(metaFile) ? readYaml(root, metaFile, FlowMetaSchema, issues) : null,
        });
      }
      for (const name of list(join(dir, "common")).filter((n) => /\.ya?ml$/.test(n))) {
        flows.push({ path: `${flowDir}/common/${name}`, app, target: t.data, tcId: null, meta: null });
      }
    }
  }
  return { config, layout: lay, apps, testcases, flows, issues };
}
