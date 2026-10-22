import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseAllDocuments } from "yaml";
import { z } from "zod";

export class FlowFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlowFileError";
  }
}

/** Maestro 플로우 머리(첫 YAML 문서)에서 쓰는 필드 */
const FlowHeaderSchema = z
  .object({
    appId: z.string().min(1),
    name: z.string().min(1).optional(),
    tags: z.array(z.union([z.string(), z.number()])).optional(),
  })
  .loose();

export interface FlowInfo {
  path: string;
  name: string;
  /** 플로우의 appId. ${APP_ID} 처럼 변수면 그대로 */
  appId: string;
  /** 태그나 이름의 TC-NNNN. 없으면 "adhoc" */
  tcId: string;
  text: string;
}

const TC_ID = /\bTC-\d{4,}\b/;

export function readFlowInfo(path: string): FlowInfo {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new FlowFileError(`플로우 파일을 읽지 못했다: ${error instanceof Error ? error.message : String(error)}`);
  }
  const docs = parseAllDocuments(text);
  if (!Array.isArray(docs) || docs.length < 2) throw new FlowFileError("Maestro 플로우가 아니다(머리 문서와 --- 뒤의 명령 목록이 필요하다)");
  const first = docs[0];
  if (!first || first.errors.length > 0) throw new FlowFileError(`플로우 머리를 읽지 못했다: ${first?.errors[0]?.message ?? "빈 문서"}`);
  const header = FlowHeaderSchema.safeParse(first.toJS());
  if (!header.success) throw new FlowFileError(`플로우 머리에 appId 가 없다: ${header.error.issues[0]?.message ?? ""}`);
  const name = header.data.name ?? basename(path).replace(/\.ya?ml$/i, "");
  const tags = (header.data.tags ?? []).map(String);
  const tcId = tags.find((t) => TC_ID.test(t))?.match(TC_ID)?.[0] ?? name.match(TC_ID)?.[0] ?? "adhoc";
  return { path, name, appId: header.data.appId, tcId, text };
}

/** ${...} 를 쓰지 않은 실제 appId 인가 */
export const isLiteralAppId = (appId: string) => !appId.includes("${");
