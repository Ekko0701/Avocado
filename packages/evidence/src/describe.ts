/** 평가 전 명령으로 사람이 읽는 설명을 만든다. 변수 값 대신 ${이름}이 보여 비밀 값이 설명에 들어가지 않는다. */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : typeof v === "number" ? String(v) : null);

function selector(sel: unknown): string {
  if (!isObj(sel)) return "";
  const parts: string[] = [];
  for (const [key, label] of [
    ["idRegex", "id"],
    ["textRegex", "text"],
    ["text", "text"],
    ["id", "id"],
  ] as const) {
    const v = str(sel[key]);
    if (v !== null) parts.push(`${label} "${v}"`);
  }
  const index = str(sel["index"]);
  if (index !== null) parts.push(`index ${index}`);
  for (const rel of ["below", "above", "leftOf", "rightOf", "containsChild", "childOf"]) {
    if (isObj(sel[rel])) parts.push(`${rel} (${selector(sel[rel])})`);
  }
  return parts.join(", ");
}

export function describeCommand(name: string, body: unknown): string {
  const b = isObj(body) ? body : {};
  switch (name) {
    case "tapOnElement":
      return `tapOn ${selector(b["selector"])}`.trim();
    case "tapOnPoint":
    case "tapOnPointV2":
      return `tapOn point ${str(b["point"]) ?? ""}`.trim();
    case "assertConditionCommand": {
      const cond = isObj(b["condition"]) ? b["condition"] : {};
      if (isObj(cond["visible"])) return `assertVisible ${selector(cond["visible"])}`;
      if (isObj(cond["notVisible"])) return `assertNotVisible ${selector(cond["notVisible"])}`;
      return "assertCondition";
    }
    case "inputTextCommand":
      return `inputText "${str(b["text"]) ?? ""}"`;
    case "takeScreenshotCommand":
      return `takeScreenshot ${str(b["path"]) ?? ""}`.trim();
    case "launchAppCommand":
      return `launchApp ${str(b["appId"]) ?? ""}`.trim();
    case "stopAppCommand":
      return `stopApp ${str(b["appId"]) ?? ""}`.trim();
    case "runFlowCommand":
      return `runFlow ${str(b["sourceDescription"]) ?? ""}`.trim();
    default:
      return name.replace(/Command$/, "");
  }
}
