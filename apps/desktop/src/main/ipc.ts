import { ipcChannels, ipcContract, type IpcChannel, type IpcHandlers } from "@qa/shared";

/** ipcMain 중 여기서 쓰는 부분. 단위 테스트에서 가짜로 바꿔 끼울 수 있다. */
export interface IpcMainLike {
  handle(
    channel: string,
    listener: (event: { senderFrame: { url: string } | null }, ...args: unknown[]) => unknown,
  ): void;
}

export class IpcError extends Error {
  constructor(
    readonly channel: string,
    readonly reason: "untrusted-sender" | "invalid-input" | "invalid-output",
  ) {
    super(`IPC ${channel}: ${reason}`);
    this.name = "IpcError";
  }
}

/**
 * 계약에 있는 채널만 등록한다. 모든 호출에서
 * 1) 보낸 프레임의 URL 이 앱 URL 인지, 2) 입력, 3) 출력을 검증한다.
 */
export function registerIpcHandlers(
  ipcMain: IpcMainLike,
  handlers: IpcHandlers,
  isTrustedSenderUrl: (url: string) => boolean,
): void {
  for (const channel of ipcChannels) {
    ipcMain.handle(channel, async (event, raw) => {
      const url = event.senderFrame?.url;
      if (!url || !isTrustedSenderUrl(url)) throw new IpcError(channel, "untrusted-sender");
      return invokeHandler(channel, handlers, raw);
    });
  }
}

export async function invokeHandler(channel: IpcChannel, handlers: IpcHandlers, raw: unknown): Promise<unknown> {
  const contract = ipcContract[channel];
  const input = contract.input.safeParse(raw);
  if (!input.success) throw new IpcError(channel, "invalid-input");
  const handler = handlers[channel] as (value: unknown) => unknown;
  const result = await handler(input.data);
  const output = contract.output.safeParse(result);
  if (!output.success) throw new IpcError(channel, "invalid-output");
  return output.data;
}
