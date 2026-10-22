/** 텍스트에서 비밀(토큰)을 지운다. 로그·오류 메시지·git 출력에 쓴다. 값은 돌려주지 않는다. */
export const SCRUBBED = "***";

export function scrubSecrets(text: string, secrets: readonly (string | null | undefined)[]): string {
  let out = text;
  for (const s of secrets) {
    if (!s || s.length < 4) continue;
    for (const form of new Set([s, encodeURIComponent(s), Buffer.from(s).toString("base64")])) out = out.split(form).join(SCRUBBED);
  }
  // URL 에 붙은 자격 증명(https://user:pass@host)과 인증 헤더 값
  out = out.replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, `$1${SCRUBBED}@`);
  out = out.replace(/\b(authorization["']?\s*[:=]\s*["']?(?:token|bearer|basic)\s+)[^\s"',;]+/gi, `$1${SCRUBBED}`);
  return out;
}
