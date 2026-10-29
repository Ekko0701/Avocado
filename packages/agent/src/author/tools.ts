import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { ToolError } from "@anthropic-ai/sdk/lib/tools/ToolError";
import type { BetaTool } from "@anthropic-ai/sdk/resources/beta";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { z } from "zod";
import type { Budget } from "../budget";

/**
 * PLAN 부록 C.2 submit_flow. strict 도구라 스키마에 숫자 범위 같은 제약을 두지 않고(strict 가 받는 형태만),
 * 범위·정수 검사는 run 에서 한다.
 */
export const SubmitFlowSchema = z.strictObject({
  yaml: z.string().describe("플로우 전체(머리 + --- + 명령 목록)"),
  screenshotsPlan: z.array(z.strictObject({ stepIndex: z.number().describe("테스트 케이스 스텝 번호(1부터)"), screenKey: z.string() })),
  missingIdentifiers: z.array(z.strictObject({ screenKey: z.string(), description: z.string(), fallbackSelector: z.string() })),
  questions: z.array(z.string()),
  confidence: z.number().describe("0~1"),
});
export type SubmitFlow = z.infer<typeof SubmitFlowSchema>;

/** strict: true — 모델이 스키마에 맞는 입력만 내게 한다(강제 tool_choice 대신, PLAN 8장) */
function strict<I>(tool: BetaRunnableTool<I>): BetaRunnableTool<I> & BetaTool {
  return { ...tool, strict: true } as BetaRunnableTool<I> & BetaTool;
}

export class AuthorSession {
  submission: SubmitFlow | null = null;
  readonly questions: string[] = [];
  step = 0;

  constructor(
    readonly totalSteps: number,
    private readonly budget: Pick<Budget, "startStep">,
    private readonly onEvent: (event: AuthorEvent) => void = () => {},
    /** submit_flow 가 모델에게 돌려줄 문장. Claude 앱 방식은 결과를 author_status 로 기다리게 한다(ADR 0022) */
    private readonly submitReply = "제출을 받았다. 앱이 규약 검사와 재생을 한다. 더 할 일 없이 끝낸다.",
  ) {}

  /** 도구 정의만(실행하지 않는다). Claude 앱에 작업 전 도구 목록을 줄 때 쓴다 */
  static toolSpecs(): BetaTool[] {
    return new AuthorSession(1, { startStep: () => undefined }).tools();
  }

  // 도구마다 입력 타입이 달라 SDK 처럼 any 로 모은다
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools(): (BetaRunnableTool<any> & BetaTool)[] {
    return [
      strict(
        betaZodTool({
          name: "begin_step",
          description: "테스트 케이스 스텝을 시작할 때 부른다(1부터, 차례대로). 스텝마다 도구 호출 상한이 다시 센다.",
          inputSchema: z.strictObject({ step: z.number() }),
          run: ({ step }) => {
            if (!Number.isInteger(step) || step < 1 || step > this.totalSteps) throw new ToolError(`스텝 번호는 1~${this.totalSteps} 이다`);
            if (step <= this.step) throw new ToolError(`스텝은 앞으로만 간다(지금 ${this.step})`);
            this.step = step;
            this.budget.startStep();
            this.onEvent({ type: "step", step, total: this.totalSteps });
            return `스텝 ${step}/${this.totalSteps} 시작`;
          },
        }),
      ),
      strict(
        betaZodTool({
          name: "ask_planner",
          description: "테스트 케이스가 모호하거나 화면이 테스트 케이스와 다를 때 기획자에게 남길 질문. 답을 기다리지 않으니 보수적으로 계속한다.",
          inputSchema: z.strictObject({ question: z.string() }),
          run: ({ question }) => {
            const q = question.trim();
            if (!q) throw new ToolError("질문이 비어 있다");
            this.questions.push(q);
            this.onEvent({ type: "question", question: q });
            return "질문을 기록했다. 보수적으로 계속한다.";
          },
        }),
      ),
      strict(
        betaZodTool({
          name: "submit_flow",
          description: "완성한 플로우(또는 부분 결과)를 제출한다. 작업을 끝낼 때 반드시 한 번 부른다. 앱이 규약 검사와 2회 재생을 한다.",
          inputSchema: SubmitFlowSchema,
          run: (input) => {
            if (!input.yaml.trim()) throw new ToolError("yaml 이 비어 있다");
            if (!(input.confidence >= 0 && input.confidence <= 1)) throw new ToolError("confidence 는 0~1 이다");
            for (const s of input.screenshotsPlan) {
              if (!Number.isInteger(s.stepIndex) || s.stepIndex < 1 || s.stepIndex > this.totalSteps) throw new ToolError(`screenshotsPlan.stepIndex 는 1~${this.totalSteps} 이다`);
            }
            this.submission = input;
            this.onEvent({ type: "submitted" });
            return this.submitReply;
          },
        }),
      ),
    ];
  }
}

export type AuthorEvent = { type: "step"; step: number; total: number } | { type: "question"; question: string } | { type: "submitted" } | { type: "tool"; name: string };
