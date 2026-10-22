/** judge 정밀도 측정(T-115 완료 기준). 결함(fail)을 양성으로 본다. uncertain 은 따로 센다 */
export interface LabeledVerdict {
  id: string;
  label: "pass" | "fail";
  predicted: "pass" | "fail" | "uncertain";
  costUsd: number;
}

export interface JudgeMetrics {
  total: number;
  /** fail 로 판정한 것 중 실제 fail 비율. fail 판정이 없으면 null */
  precision: number | null;
  /** 실제 fail 중 fail 로 잡은 비율. 실제 fail 이 없으면 null */
  recall: number | null;
  uncertain: number;
  confusion: { tp: number; fp: number; tn: number; fn: number };
  costUsd: number;
  misjudged: string[];
}

export function judgeMetrics(rows: readonly LabeledVerdict[]): JudgeMetrics {
  const c = { tp: 0, fp: 0, tn: 0, fn: 0 };
  let uncertain = 0;
  const misjudged: string[] = [];
  for (const r of rows) {
    if (r.predicted === "uncertain") {
      uncertain += 1;
      continue;
    }
    if (r.predicted === "fail") {
      if (r.label === "fail") c.tp += 1;
      else c.fp += 1;
    } else if (r.label === "pass") c.tn += 1;
    else c.fn += 1;
    if (r.predicted !== r.label) misjudged.push(r.id);
  }
  return {
    total: rows.length,
    precision: c.tp + c.fp > 0 ? c.tp / (c.tp + c.fp) : null,
    recall: c.tp + c.fn > 0 ? c.tp / (c.tp + c.fn) : null,
    uncertain,
    confusion: c,
    costUsd: rows.reduce((n, r) => n + r.costUsd, 0),
    misjudged,
  };
}

export function metricsMarkdown(m: JudgeMetrics, meta: { model: string; date: string; dataset: string }): string {
  const pct = (v: number | null) => (v === null ? "-" : `${(v * 100).toFixed(1)}%`);
  return [
    `# judge 정밀도 (${meta.date})`,
    "",
    `- 모델: ${meta.model}, 데이터: ${meta.dataset} (${m.total}장)`,
    `- 정밀도(결함 판정 중 실제 결함): **${pct(m.precision)}**, 재현율: ${pct(m.recall)}, 불확실 ${m.uncertain}장`,
    `- 혼동 행렬: TP ${m.confusion.tp} · FP ${m.confusion.fp} · TN ${m.confusion.tn} · FN ${m.confusion.fn}`,
    `- 비용: $${m.costUsd.toFixed(4)}`,
    m.misjudged.length ? `- 틀린 캡처: ${m.misjudged.join(", ")}` : "- 틀린 캡처: 없음",
    "",
  ].join("\n");
}
