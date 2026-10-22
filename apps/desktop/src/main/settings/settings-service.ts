import {
  APP_SECRET_NAMES,
  applySettingsPatch,
  DEFAULT_SETTINGS,
  SecretNameSchema,
  SecretValueSchema,
  SettingsSchema,
  type SecretName,
  type SecretStatus,
  type SecretsList,
  type Settings,
  type SettingsPatch,
  type SettingsState,
} from "@qa/shared";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";

/** 비밀 암호화 수단. 운영은 Electron safeStorage(macOS 키체인 키), 테스트는 대역을 주입한다. */
export interface SecretCrypto {
  isAvailable(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(cipher: Buffer): string;
}

export class SecretsUnavailableError extends Error {
  constructor() {
    super("safeStorage 암호화를 쓸 수 없어 비밀을 저장하거나 읽지 않았다");
    this.name = "SecretsUnavailableError";
  }
}

export class SecretDecryptError extends Error {
  constructor(name: string) {
    super(`비밀 '${name}'을 복호화하지 못했다. 다시 저장해야 한다`);
    this.name = "SecretDecryptError";
  }
}

const SecretsFileSchema = z.strictObject({
  version: z.literal(1),
  items: z
    .record(z.string(), z.strictObject({ ciphertext: z.base64(), updatedAt: z.iso.datetime() }))
    .refine((items) => Object.keys(items).every((k) => SecretNameSchema.safeParse(k).success), "알 수 없는 비밀 이름"),
});
type SecretsFile = z.infer<typeof SecretsFileSchema>;

const EMPTY_SECRETS: SecretsFile = { version: 1, items: {} };

export interface SettingsServiceOptions {
  /** 설정 파일을 둘 폴더. 운영은 app.getPath("userData"). */
  dir: string;
  crypto: SecretCrypto;
  now?: () => Date;
}

/**
 * 설정(settings.json, 평문)과 비밀(secrets.json, safeStorage 암호문)을 관리한다.
 * - 비밀 값은 이 클래스 밖으로 getSecret() 으로만 나가며, main 의 서비스만 호출한다.
 * - 로그를 남기지 않는다. 오류 메시지에 비밀 값을 넣지 않는다.
 */
export class SettingsService {
  private settings: Settings = DEFAULT_SETTINGS;
  private secrets: SecretsFile = EMPTY_SECRETS;
  private issues: string[] = [];
  private readonly settingsPath: string;
  private readonly secretsPath: string;
  private readonly now: () => Date;

  constructor(private readonly options: SettingsServiceOptions) {
    this.settingsPath = join(options.dir, "settings.json");
    this.secretsPath = join(options.dir, "secrets.json");
    this.now = options.now ?? (() => new Date());
  }

  init(): void {
    mkdirSync(this.options.dir, { recursive: true, mode: 0o700 });
    this.settings = this.loadFile(this.settingsPath, SettingsSchema, DEFAULT_SETTINGS, "설정");
    this.secrets = this.loadFile(this.secretsPath, SecretsFileSchema, EMPTY_SECRETS, "비밀");
  }

  getSettings(): SettingsState {
    return { settings: this.settings, issue: this.issues.length > 0 ? this.issues.join(" ") : null };
  }

  updateSettings(patch: SettingsPatch): Settings {
    const next = applySettingsPatch(this.settings, patch);
    this.writeJson(this.settingsPath, next);
    this.settings = next;
    return next;
  }

  /** 마법사 완료 시각. 렌더러의 settings:update 로는 바꿀 수 없고 setup:complete 핸들러만 부른다. */
  markSetupComplete(): Settings {
    const next = SettingsSchema.parse({ ...this.settings, setup: { completedAt: this.now().toISOString() } });
    this.writeJson(this.settingsPath, next);
    this.settings = next;
    return next;
  }

  listSecrets(): SecretsList {
    const accountNames = Object.keys(this.secrets.items)
      .filter((name) => !(APP_SECRET_NAMES as readonly string[]).includes(name))
      .sort();
    const names = [...APP_SECRET_NAMES, ...accountNames].map((n) => SecretNameSchema.parse(n));
    return { encryptionAvailable: this.options.crypto.isAvailable(), items: names.map((n) => this.status(n)) };
  }

  setSecret(name: SecretName, value: string): SecretStatus {
    const validName = SecretNameSchema.parse(name);
    if (!SecretValueSchema.safeParse(value).success) throw new Error("비밀 값 형식이 올바르지 않다");
    if (!this.options.crypto.isAvailable()) throw new SecretsUnavailableError();
    const ciphertext = this.options.crypto.encrypt(value).toString("base64");
    const next: SecretsFile = {
      version: 1,
      items: { ...this.secrets.items, [validName]: { ciphertext, updatedAt: this.now().toISOString() } },
    };
    this.writeJson(this.secretsPath, next);
    this.secrets = next;
    return this.status(validName);
  }

  deleteSecret(name: SecretName): SecretStatus {
    const validName = SecretNameSchema.parse(name);
    if (Object.hasOwn(this.secrets.items, validName)) {
      const items = Object.fromEntries(Object.entries(this.secrets.items).filter(([key]) => key !== validName));
      const next: SecretsFile = { version: 1, items };
      this.writeJson(this.secretsPath, next);
      this.secrets = next;
    }
    return this.status(validName);
  }

  /** main 프로세스 서비스 전용. 렌더러로 보내는 경로를 만들지 않는다. */
  getSecret(name: SecretName): string | null {
    const validName = SecretNameSchema.parse(name);
    const item = this.secrets.items[validName];
    if (!item) return null;
    if (!this.options.crypto.isAvailable()) throw new SecretsUnavailableError();
    try {
      return this.options.crypto.decrypt(Buffer.from(item.ciphertext, "base64"));
    } catch {
      throw new SecretDecryptError(validName);
    }
  }

  private status(name: SecretName): SecretStatus {
    const item = this.secrets.items[name];
    return { name, stored: item !== undefined, updatedAt: item?.updatedAt ?? null };
  }

  /** 파일이 없으면 기본값. 손상됐으면 원본을 백업하고 기본값으로 시작하며 그 사실을 issue 로 남긴다. */
  private loadFile<T>(path: string, schema: z.ZodType<T>, fallback: T, label: string): T {
    if (!existsSync(path)) return fallback;
    let reason: string;
    try {
      const parsed = schema.safeParse(JSON.parse(readFileSync(path, "utf8")));
      if (parsed.success) return parsed.data;
      reason = "형식 불일치";
    } catch {
      reason = "JSON 읽기 실패";
    }
    const backup = `${path}.corrupt-${this.now().toISOString().replace(/[:.]/g, "-")}`;
    renameSync(path, backup);
    this.issues.push(`${label} 파일이 손상돼(${reason}) 기본값으로 시작했다. 원본은 ${basename(backup)}에 보관했다.`);
    return fallback;
  }

  private writeJson(path: string, data: unknown): void {
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
    chmodSync(path, 0o600);
  }
}
