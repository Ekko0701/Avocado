import type { IpcHandlers } from "@qa/shared";
import type { EvidenceService } from "./evidence-service";
import type { EvidenceExportService } from "./export-service";
import type { UploadService } from "./upload-service";

type EvidenceChannel = "evidence:list" | "evidence:file" | "evidence:search" | "evidence:hierarchy" | "evidence:prepareUpload" | "evidence:upload" | "evidence:uploads" | "evidence:prepareExport" | "evidence:export" | "evidence:revealExport";

export function createEvidenceHandlers(evidence: EvidenceService, upload: UploadService, exporter: EvidenceExportService): Pick<IpcHandlers, EvidenceChannel> {
  return {
    "evidence:list": ({ runId, executionId }) => evidence.list(runId, executionId),
    "evidence:file": ({ runId, executionId, path }) => evidence.file(runId, executionId, path),
    "evidence:search": ({ runId, executionId, query }) => evidence.search(runId, executionId, query),
    "evidence:hierarchy": ({ runId, executionId, path }) => evidence.hierarchy(runId, executionId, path),
    "evidence:prepareUpload": (input) => upload.prepare(input),
    "evidence:upload": (input) => upload.upload(input),
    "evidence:uploads": ({ runId, executionId }) => upload.uploads(runId, executionId),
    "evidence:prepareExport": (input) => exporter.prepare(input),
    "evidence:export": (input) => exporter.export(input),
    "evidence:revealExport": (input) => exporter.reveal(input),
  };
}
