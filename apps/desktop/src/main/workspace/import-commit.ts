import { entryProblems, foldPath, type ArchiveRead } from "@qa/workspace";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { WorkspaceError } from "./workspace-error";

/**
 * 가져오기의 git 쪽(ADR 0036 결정 11): 저장소의 파일 읽기, 로컬 main 에 한 커밋, GitHub 방식의 가져오기 브랜치에 한 커밋.
 * 무엇을 쓸지는 정하지 않는다(미리보기 엔진이 정한 경로와 바이트를 그대로 쓴다).
 */
export type Git = (args: string[], opts?: { env?: Record<string, string>; input?: Uint8Array; raw?: boolean }) => Promise<string>;
export type GitBytes = (args: string[], opts?: { input?: Uint8Array }) => Promise<Buffer>;

const MAIN_REF = "refs/heads/main";

interface TreeEntry {
  path: string;
  type: "file" | "link" | "other";
  sha: string;
  size: number;
}

async function listTree(git: Git, ref: string, paths: string[]): Promise<TreeEntry[]> {
  const out = await git(["ls-tree", "-r", "-l", "-z", "--full-tree", ref, "--", ...paths], { raw: true });
  return out
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const m = /^(\d{6}) (\w+) ([0-9a-f]{40,64}) +(-|\d+)\t([\s\S]*)$/.exec(line);
      if (!m) throw new WorkspaceError(`git ls-tree 출력을 읽지 못했다: ${line.slice(0, 80)}`);
      const mode = m[1] ?? "";
      return { path: m[5] ?? "", type: mode === "100644" || mode === "100755" ? "file" : mode === "120000" ? "link" : "other", sha: m[3] ?? "", size: m[4] === "-" ? 0 : Number(m[4]) };
    });
}

/** cat-file --batch 의 출력("<sha> blob <크기>\n<내용>\n" 이 이어진다)을 나눈다 */
async function readBlobs(gitBytes: GitBytes, shas: string[]): Promise<Buffer[]> {
  if (shas.length === 0) return [];
  const out = await gitBytes(["cat-file", "--batch"], { input: Buffer.from(`${shas.join("\n")}\n`) });
  const blobs: Buffer[] = [];
  let at = 0;
  for (const sha of shas) {
    const eol = out.indexOf(0x0a, at);
    const header = out.subarray(at, eol).toString("utf8");
    const m = /^([0-9a-f]+) blob (\d+)$/.exec(header);
    if (eol < 0 || !m || m[1] !== sha) throw new WorkspaceError(`git cat-file 출력을 읽지 못했다: ${header.slice(0, 80)}`);
    const size = Number(m[2]);
    blobs.push(out.subarray(eol + 1, eol + 1 + size));
    at = eol + 1 + size + 1;
  }
  return blobs;
}

/**
 * 저장소의 한 커밋(ref)에서 workspace.yaml 과 apps/ 의 파일을 읽는다. 작업 폴더를 보지 않는다.
 * hostile 이면 받은 묶음과 같은 규칙(링크·이름·상한)으로 검사해 걸리면 읽지 않는다(GitHub 방식에서 이 Mac 의 로컬 워크스페이스를 가져올 때)
 */
export async function readTree(git: Git, gitBytes: GitBytes, ref: string, opts: { hostile: boolean }): Promise<ArchiveRead> {
  const hasApps = (await git(["ls-tree", "--name-only", ref, "--", "apps"])) !== "";
  const entries = await listTree(git, ref, ["workspace.yaml", ...(hasApps ? ["apps"] : [])]);
  if (opts.hostile) {
    const problems = entryProblems(entries);
    if (problems.length > 0) return { ok: false, problems };
  } else if (entries.some((e) => e.type !== "file")) {
    throw new WorkspaceError(`워크스페이스에 일반 파일이 아닌 항목이 있다: ${entries.filter((e) => e.type !== "file").map((e) => e.path).join(", ")}`);
  }
  const blobs = await readBlobs(gitBytes, entries.map((e) => e.sha));
  return { ok: true, files: new Map(entries.map((e, i) => [e.path, new Uint8Array(blobs[i] ?? Buffer.alloc(0))])) };
}

/** 받는 쪽에 있는 파일과 대소문자·정규화만 다른 이름이면 거절한다. 대소문자를 가리지 않는 디스크에서 기존 파일을 말없이 덮어쓴다 */
function refuseCaseClash(paths: Iterable<string>, existing: readonly string[]): void {
  const byFold = new Map(existing.map((p) => [foldPath(p), p]));
  for (const path of paths) {
    const other = byFold.get(foldPath(path));
    if (other !== undefined && other !== path) throw new WorkspaceError(`이미 있는 ${other} 와 대소문자만 다른 이름이라 쓰지 않는다: ${path}`);
  }
}

/** git status --porcelain=v1 -z 를 나눈다. 이름 바꾸기 항목은 원래 이름이 뒤에 하나 더 온다 */
function porcelain(out: string): { index: string; worktree: string; path: string }[] {
  const parts = out.split("\0");
  const entries: { index: string; worktree: string; path: string }[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] ?? "";
    if (!part) continue;
    entries.push({ index: part[0] ?? "", worktree: part[1] ?? "", path: part.slice(3) });
    if (part[0] === "R" || part[0] === "C") i += 1;
  }
  return entries;
}

/**
 * 로컬 워크스페이스 main 에 한 커밋으로 쓴다. 쓰기 전에 작업 폴더가 깨끗해야 한다.
 * 쓴 뒤 git status 가 의도한 경로만, 모두 스테이지된 채로 보여야 커밋한다. 아니면 쓴 것을 되돌리고 실패한다
 * (대소문자만 다른 이름은 git add 가 성공하면서 아무것도 올리지 않고 기존 파일만 바뀐다)
 */
export async function commitLocalImport(input: { git: Git; files: ReadonlyMap<string, Uint8Array>; message: string; author: string[]; resolve: (rel: string) => string }): Promise<string> {
  const { git, files, resolve } = input;
  const dirty = await git(["status", "--porcelain", "--untracked-files=all"]);
  if (dirty !== "") throw new WorkspaceError(`저장하지 않은 변경이 있어 가져오지 않는다: ${dirty.split("\n").map((l) => l.slice(3)).join(", ")}`);
  refuseCaseClash(files.keys(), (await git(["ls-files", "-z"], { raw: true })).split("\0").filter(Boolean));

  const previous = new Map<string, Buffer | null>();
  const changed: string[] = [];
  for (const [path, bytes] of files) {
    const abs = resolve(path);
    if (existsSync(abs) && !lstatSync(abs).isFile()) throw new WorkspaceError(`일반 파일이 아닌 자리에는 쓰지 않는다: ${path}`);
    const before = existsSync(abs) ? readFileSync(abs) : null;
    previous.set(path, before);
    if (!before?.equals(Buffer.from(bytes))) changed.push(path);
  }
  if (changed.length === 0) throw new WorkspaceError("바뀐 내용이 없다");
  const createdDirs: string[] = [];
  try {
    for (const path of changed) {
      const abs = resolve(path);
      const created = mkdirSync(dirname(abs), { recursive: true });
      if (created) createdDirs.push(created);
      writeFileSync(abs, files.get(path) ?? new Uint8Array());
    }
    await git(["add", "--", ...changed]);
    const status = porcelain(await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { raw: true }));
    const listed = status.map((s) => s.path).sort();
    const staged = status.every((s) => s.index !== " " && s.index !== "?" && s.worktree === " ");
    if (JSON.stringify(listed) !== JSON.stringify([...changed].sort()) || !staged) {
      throw new WorkspaceError(`git 이 고른 파일만 올리지 않아 되돌렸다(git status: ${status.map((s) => `${s.index}${s.worktree} ${s.path}`).join(", ") || "없음"})`);
    }
    await git([...input.author, "commit", "--quiet", "-m", input.message]);
  } catch (error) {
    await git(["reset", "--quiet", "--", ...changed]).catch(() => undefined);
    for (const path of changed) {
      const before = previous.get(path);
      if (before) writeFileSync(resolve(path), before);
      else rmSync(resolve(path), { force: true });
    }
    for (const dir of createdDirs.reverse()) rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return git(["rev-parse", "--short", "HEAD"]);
}

/**
 * GitHub 방식: main 위에 새 가져오기 브랜치를 만들어 한 커밋을 둔다. 작업 폴더와 지금 브랜치는 그대로다(임시 색인으로 만든다).
 * 브랜치 이름이 이미 있으면(이 Mac 이나 원격) -2, -3 을 붙인다
 */
export async function commitImportBranch(input: { git: Git; branchBase: string; files: ReadonlyMap<string, Uint8Array>; message: string; author: string[] }): Promise<{ branch: string; commit: string }> {
  const { git, files } = input;
  const exists = (ref: string) => git(["rev-parse", "--verify", "--quiet", ref]).then(
    () => true,
    () => false,
  );
  let branch = input.branchBase;
  for (let n = 2; (await exists(`refs/heads/${branch}`)) || (await exists(`refs/remotes/origin/${branch}`)); n += 1) branch = `${input.branchBase}-${n}`;
  refuseCaseClash(files.keys(), (await git(["ls-tree", "-r", "--name-only", "-z", MAIN_REF], { raw: true })).split("\0").filter(Boolean));
  const index = join(await git(["rev-parse", "--absolute-git-dir"]), `avocado-import-${randomUUID()}.index`);
  const env = { GIT_INDEX_FILE: index };
  try {
    await git(["read-tree", MAIN_REF], { env });
    for (const [path, bytes] of files) {
      const blob = await git(["hash-object", "-w", "--stdin"], { input: bytes });
      await git(["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], { env });
    }
    const tree = await git(["write-tree"], { env });
    if (tree === (await git(["rev-parse", `${MAIN_REF}^{tree}`]))) throw new WorkspaceError("main 과 같아 가져올 것이 없다");
    const commit = await git([...input.author, "commit-tree", tree, "-p", MAIN_REF, "-m", input.message]);
    // 빈 이전 값: 그사이 같은 이름이 생겼으면 덮어쓰지 않고 실패한다
    await git(["update-ref", `refs/heads/${branch}`, commit, ""]);
    return { branch, commit: await git(["rev-parse", "--short", commit]) };
  } finally {
    rmSync(index, { force: true });
  }
}
