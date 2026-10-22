import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import { AccountsSchema, AppConfigSchema, type Accounts, FlowMetaSchema, TargetSchema, TC_ID, WorkspaceConfigSchema, type AppConfig, type FlowMeta, type Target, type WorkspaceConfig } from "./schemas";
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

  const testcases: TestcaseEntry[] = [];
  for (const app of list(join(root, "testcases")).filter((a) => isDir(join(root, "testcases", a)))) {
    if (!known.has(app)) issues.push({ path: `testcases/${app}`, line: null, message: "workspace.yaml 의 apps 에 없는 앱이다" });
    for (const name of list(join(root, "testcases", app)).filter((n) => n.endsWith(".md"))) {
      const path = `testcases/${app}/${name}`;
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
  for (const app of list(join(root, "flows")).filter((a) => isDir(join(root, "flows", a)))) {
    if (!known.has(app)) issues.push({ path: `flows/${app}`, line: null, message: "workspace.yaml 의 apps 에 없는 앱이다" });
    for (const target of list(join(root, "flows", app)).filter((t) => isDir(join(root, "flows", app, t)))) {
      const t = TargetSchema.safeParse(target);
      if (!t.success) {
        issues.push({ path: `flows/${app}/${target}`, line: null, message: "타깃 폴더는 ios, android, flutter-ios, flutter-android" });
        continue;
      }
      const dir = join(root, "flows", app, target);
      for (const name of list(dir).filter((n) => /\.ya?ml$/.test(n) && !n.endsWith(".meta.yaml"))) {
        const tcId = name.replace(/\.ya?ml$/, "");
        const metaFile = join(dir, `${tcId}.meta.yaml`);
        flows.push({
          path: `flows/${app}/${target}/${name}`,
          app,
          target: t.data,
          tcId: TC_ID.test(tcId) ? tcId : null,
          meta: existsSync(metaFile) ? readYaml(root, metaFile, FlowMetaSchema, issues) : null,
        });
      }
      for (const name of list(join(dir, "common")).filter((n) => /\.ya?ml$/.test(n))) {
        flows.push({ path: `flows/${app}/${target}/common/${name}`, app, target: t.data, tcId: null, meta: null });
      }
    }
  }
  return { config, apps, testcases, flows, issues };
}
