/** Maestro `--format junit` 결과. Maestro 가 쓰는 단순한 형식만 다룬다(속성, testcase, failure·error 본문). */

export interface JUnitCase {
  name: string;
  status: string | null;
  timeSeconds: number | null;
  failure: string | null;
}

export interface JUnitReport {
  device: string | null;
  cases: JUnitCase[];
}

export function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|quot|amp|lt|gt|apos);/g, (_m, e: string) => {
    if (e.startsWith("#x")) return String.fromCodePoint(Number.parseInt(e.slice(2), 16));
    if (e.startsWith("#")) return String.fromCodePoint(Number.parseInt(e.slice(1), 10));
    return { quot: '"', amp: "&", lt: "<", gt: ">", apos: "'" }[e] ?? `&${e};`;
  });
}

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const key = m[1];
    if (key) out[key] = decodeXmlEntities(m[2] ?? m[3] ?? "");
  }
  return out;
}

export function parseJUnit(xml: string): JUnitReport {
  const suite = /<testsuite\b([^>]*)>/.exec(xml);
  const cases: JUnitCase[] = [];
  // <testcase .../> 또는 <testcase ...>본문</testcase>
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attrs = attributes(m[1] ?? "");
    const body = m[3] ?? "";
    const fail = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(body);
    let failure: string | null = null;
    if (fail) {
      const text = decodeXmlEntities((fail[3] ?? "").replace(/^<!\[CDATA\[|\]\]>$/g, "")).trim();
      failure = text || attributes(fail[2] ?? "")["message"] || "실패(메시지 없음)";
    }
    const time = attrs["time"] ? Number(attrs["time"]) : Number.NaN;
    cases.push({
      name: attrs["name"] ?? "",
      status: attrs["status"] ?? null,
      timeSeconds: Number.isFinite(time) ? time : null,
      failure,
    });
  }
  return { device: suite ? (attributes(suite[1] ?? "")["device"] ?? null) : null, cases };
}

/** testcase 결과를 통과 여부로. Maestro 는 status="SUCCESS"|"ERROR" 를 쓰고, failure 요소가 있으면 실패다 */
export function junitPassed(c: JUnitCase): boolean {
  if (c.failure !== null) return false;
  if (c.status === null) return true;
  return c.status.toUpperCase() === "SUCCESS";
}
