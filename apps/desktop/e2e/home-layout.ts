import { expect, type Page } from "@playwright/test";

export interface HomeLayout {
  trend: Box;
  runs: Box;
  attention: Box;
  env: Box;
  /** 차트 칸과 그 안의 그림. 실행 기록이 없으면 null(빈 안내가 대신 보인다) */
  chart: (Box & { svg: Box; viewBox: { width: number; height: number } }) | null;
  /** 최근 실행 카드의 내용이 카드 밖으로 넘친 높이(px). 0 이어야 한다 */
  runsSpill: number;
  /** 최근 실행에 실제로 보이는 줄 수 */
  recentRows: number;
  /** 최근 실행의 줄 높이(자리를 채우는 빈 줄 포함) */
  rowHeights: number[];
}
interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
  bottom: number;
}

/** 홈의 네 카드와 차트가 화면에서 차지하는 자리 */
export function homeLayout(page: Page): Promise<HomeLayout> {
  return page.evaluate(() => {
    const box = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height, bottom: r.bottom };
    };
    const card = (id: string) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      if (!el) throw new Error(`홈에 ${id} 가 없습니다`);
      return el;
    };
    const runs = card("home-runs");
    const chartEl = document.querySelector('[data-testid="home-chart"]');
    const svg = chartEl?.querySelector("svg") ?? null;
    const view = svg?.viewBox.baseVal ?? null;
    const lastRow = [...runs.querySelectorAll("li.home-recent:not(.blank)")].at(-1);
    return {
      trend: box(card("home-trend")),
      runs: box(runs),
      attention: box(card("home-attention")),
      env: box(card("home-env")),
      chart: chartEl && svg && view ? { ...box(chartEl), svg: box(svg), viewBox: { width: view.width, height: view.height } } : null,
      runsSpill: Math.max(0, (lastRow ?? runs).getBoundingClientRect().bottom - runs.getBoundingClientRect().bottom),
      recentRows: runs.querySelectorAll("li.home-recent:not(.blank)").length,
      rowHeights: [...runs.querySelectorAll("li.home-recent")].map((li) => li.getBoundingClientRect().height),
    };
  });
}

/**
 * 넓은 창의 홈 배치: 윗줄은 추이 | 최근 실행, 아랫줄은 살펴볼 테스트 케이스 | 환경이고 한 줄의 두 카드는 높이가 같다.
 * 차트는 카드 안에 있고 그림이 차트 칸을 찌그러짐 없이 채운다. 최근 실행의 줄은 카드 밖으로 넘치지 않는다
 */
export function expectHomeRows(l: HomeLayout): void {
  expect(Math.abs(l.trend.top - l.runs.top), "추이와 최근 실행은 같은 줄").toBeLessThanOrEqual(1);
  expect(Math.abs(l.trend.height - l.runs.height), "추이와 최근 실행의 높이").toBeLessThanOrEqual(1);
  expect(l.trend.left, "추이가 왼쪽").toBeLessThan(l.runs.left);
  expect(Math.abs(l.attention.top - l.env.top), "살펴볼 테스트 케이스와 환경은 같은 줄").toBeLessThanOrEqual(1);
  expect(Math.abs(l.attention.height - l.env.height), "살펴볼 테스트 케이스와 환경의 높이").toBeLessThanOrEqual(1);
  expect(l.attention.left, "살펴볼 테스트 케이스가 왼쪽").toBeLessThan(l.env.left);
  expect(l.runs.bottom, "윗줄이 아랫줄보다 위").toBeLessThan(l.env.top);
  expect(l.runsSpill, "최근 실행의 줄이 카드 밖으로 넘치지 않는다").toBeLessThanOrEqual(0.5);
  if (l.chart) {
    expect(l.chart.top, "차트는 카드 안").toBeGreaterThan(l.trend.top);
    expect(l.chart.bottom, "차트는 카드 안").toBeLessThan(l.trend.bottom);
    expect(l.chart.height, "차트가 남는 높이를 채운다").toBeGreaterThan(l.trend.height * 0.6);
    expect(Math.abs(l.chart.svg.width - l.chart.width) + Math.abs(l.chart.svg.height - l.chart.height), "그림이 차트 칸을 채운다").toBeLessThanOrEqual(1);
    // 그림의 좌표 비율이 칸의 비율과 같아야 글자·막대가 찌그러지거나 여백이 생기지 않는다
    expect(Math.abs(l.chart.viewBox.height / l.chart.viewBox.width - l.chart.height / l.chart.width), "그림 비율").toBeLessThan(0.005);
  }
}
