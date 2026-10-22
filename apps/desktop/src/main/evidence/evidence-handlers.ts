import type { IpcHandlers } from "@qa/shared";
import type { EvidenceService } from "./evidence-service";
import type { UploadService } from "./upload-service";

type EvidenceChannel = "evidence:list" | "evidence:file" | "evidence:search" | "evidence:hierarchy" | "evidence:prepareUpload" | "evidence:upload" | "evidence:uploads";

export function createEvidenceHandlers(evidence: EvidenceService, upload: UploadService): Pick<IpcHandlers, EvidenceChannel> {
  return {
    "evidence:list": ({ runId, executionId }) => evidence.list(runId, executionId),
    "evidence:file": ({ runId, executionId, path }) => evidence.file(runId, executionId, path),
    "evidence:search": ({ runId, executionId, query }) => evidence.search(runId, executionId, query),
    "evidence:hierarchy": ({ runId, executionId, path }) => evidence.hierarchy(runId, executionId, path),
    "evidence:prepareUpload": (input) => upload.prepare(input),
    "evidence:upload": (input) => upload.upload(input),
    "evidence:uploads": ({ runId, executionId }) => upload.uploads(runId, executionId),
  };
}
