export function parseCliOptions(args: string[]): { debug: boolean; threadId?: string } {
  let debug = false;
  let threadId: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") continue; // 兼容 pnpm start -- --thread <id>。
    if (arg === "--debug") debug = true;
    else if (arg === "--thread" && threadId === undefined) {
      const value = args[++index];
      if (!value || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
        throw new Error("启动参数无效：--thread 需要一个有效的会话 ID。");
      }
      threadId = value;
    } else {
      throw new Error("启动参数无效：仅支持 --debug 和 --thread <会话ID>。");
    }
  }
  return { debug, threadId };
}
