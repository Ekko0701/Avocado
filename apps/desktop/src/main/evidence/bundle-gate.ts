import { BundleError, buildSecretSet, buildSummaryBundle, checkBundle, MIN_SECRET_LENGTH, type BundleFile, type JpegConverter, type Residue, type SummaryBundle } from "@qa/evidence";
import type { BundlePreview, RunDetail } from "@qa/shared";

export const MAX_THUMBNAILS = 50;

export interface BundleGateOptions {
  runs: { get(runId: string): RunDetail };
  evidence: { redactedDir(runId: string, executionId: string): string };
  /** 가릴 값 전체(키체인의 계정 값·토큰) */
  secrets(): string[];
  toJpeg: JpegConverter;
  /** 예: "Avocado 0.1.0" */
  generator: string;
  /** 미리보기로 보여 줄 수 있는 캡처 수(넘으면 만들지 않는다). 기본 50 */
  maxImages?: number;
}

export interface GatedBundle {
  run: RunDetail;
  execution: RunDetail["executions"][number];
  bundle: SummaryBundle;
  images: BundleFile[];
  residue: Residue[];
}

/** 증적을 앱 밖으로 내보내는 길(올리기, 폴더로 내보내기)이 함께 쓰는 거절 문구의 동사 */
export type GateVerb = "올리지" | "내보내지";

/** 끝난 실행의 회차를 찾는다. 끝나지 않았거나 없으면 거절한다 */
export function finishedExecution(run: RunDetail, executionId: string, verb: GateVerb, fail: (message: string) => Error): RunDetail["executions"][number] {
  if (run.status === "queued" || run.status === "running") throw fail(`끝나지 않은 실행은 ${verb} 않는다`);
  const execution = run.executions.find((e) => e.id === executionId);
  if (!execution) throw fail(`실행을 찾지 못했다: ${executionId}`);
  return execution;
}

/**
 * 앱 밖으로 내보내는 요약 묶음의 게이트(PLAN 9.3, ADR 0036 결정 9). 가릴 수 없는 값 검사 → 가린 사본으로 묶기 → 캡처 수 상한 → 비밀 값 잔존 검사.
 * 잔존이 있으면 residue 가 비지 않는다. 막는 것은 부르는 쪽이 한다(미리보기에는 경로·개수를 보여 준다).
 */
export async function buildGatedBundle(
  options: BundleGateOptions,
  input: { run: RunDetail; execution: RunDetail["executions"][number]; includePassScreens: boolean; date: Date },
  verb: GateVerb,
  fail: (message: string) => Error,
): Promise<GatedBundle> {
  const { run, execution } = input;
  const result = run.status;
  if (result === "queued" || result === "running") throw fail(`끝나지 않은 실행은 ${verb} 않는다`);
  const secrets = options.secrets();
  // 너무 짧아 가릴 수 없는 값이 있으면 묶음에 그대로 남을 수 있다(redact.ts MIN_SECRET_LENGTH)
  if (buildSecretSet(secrets).unredactable > 0) throw fail(`가릴 수 없을 만큼 짧은(${MIN_SECRET_LENGTH}자 미만) 비밀 값이 있어 ${verb} 않는다. 설정에서 확인한다`);
  let bundle: SummaryBundle;
  try {
    bundle = await buildSummaryBundle({
      meta: {
        runId: run.id,
        executionId: execution.id,
        attempt: execution.attempt,
        tcId: run.tcId,
        app: run.app,
        target: run.target,
        flowName: run.flowName,
        deviceName: run.deviceName,
        buildLabel: run.buildLabel,
        result,
        flaky: run.flaky,
        failureClass: execution.failureClass ?? (run.flaky ? "flaky" : null),
        createdAt: run.createdAt,
        finishedAt: run.finishedAt,
        generator: options.generator,
      },
      redactedDir: options.evidence.redactedDir(run.id, execution.id),
      includePassScreens: input.includePassScreens,
      secrets,
      toJpeg: options.toJpeg,
      date: input.date,
    });
  } catch (error) {
    if (error instanceof BundleError) throw fail(error.message);
    throw error;
  }
  const images = bundle.files.filter((f) => f.kind === "screen" || f.kind === "failure_screen");
  // 미리보기로 보지 않은 캡처는 내보내지 않는다
  const maxImages = options.maxImages ?? MAX_THUMBNAILS;
  if (images.length > maxImages) throw fail(`캡처가 ${maxImages}장을 넘어 미리보기로 모두 확인할 수 없다(${images.length}장). 화면 캡처를 빼고 다시 만든다`);
  return { run, execution, bundle, images, residue: checkBundle(bundle, secrets) };
}

/** 미리보기에 보여 줄 공통 부분 */
export function bundlePreview(gated: GatedBundle, bundleId: string | null): BundlePreview {
  const { bundle, images, residue } = gated;
  return {
    bundleId,
    files: bundle.files.map((f) => ({ path: f.path, kind: f.kind, bytes: f.content.length })),
    thumbnails: images.map((f) => ({ path: f.path, dataUrl: `data:image/jpeg;base64,${f.content.toString("base64")}` })),
    totalBytes: bundle.totalBytes,
    warnings: bundle.warnings,
    blocked: residue.length > 0,
    residue,
  };
}
