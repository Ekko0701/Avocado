import type { QaApi } from "@qa/shared";

declare global {
  interface Window {
    readonly qa: QaApi;
  }
}

export {};
