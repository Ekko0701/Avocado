import { safeStorage } from "electron";
import type { SecretCrypto } from "./settings-service";

/** 운영 암호화: Electron safeStorage. macOS 에서는 키체인에 보관된 앱 키로 암호화한다. */
export const safeStorageCrypto: SecretCrypto = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plain) => safeStorage.encryptString(plain),
  decrypt: (cipher) => safeStorage.decryptString(cipher),
};
