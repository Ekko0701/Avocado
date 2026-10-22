import type { SecretCrypto } from "./settings-service";

/**
 * 자동 E2E 전용 암호화 대역. 실제 키체인을 건드리지 않으려고 쓴다.
 * - 패키징되지 않은 앱에서 QA_E2E_TEST_CRYPTO=1 일 때만 main 이 고른다(src/main/index.ts).
 * - 보안 수단이 아니다. 평문이 파일에 그대로 남지 않는지만 보장한다.
 */
const MARKER = Buffer.from("QA-TEST-ONLY:");
const KEY = 0x5a;

export function createTestOnlyCrypto(): SecretCrypto {
  return {
    isAvailable: () => true,
    encrypt: (plain) => Buffer.concat([MARKER, Buffer.from(plain, "utf8").map((b) => b ^ KEY)]),
    decrypt: (cipher) => {
      if (!cipher.subarray(0, MARKER.length).equals(MARKER)) throw new Error("테스트 암호문이 아니다");
      return Buffer.from(cipher.subarray(MARKER.length).map((b) => b ^ KEY)).toString("utf8");
    },
  };
}
