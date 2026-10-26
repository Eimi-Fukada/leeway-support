import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// 仅传递开发身份并启动官方 Next CLI，不创建自定义 HTTP 服务。
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const production = args[0] === "--production";
if (production) args.shift();
try {
  if (args.length !== 2 || args[0] !== "--user" || !/^[A-Za-z0-9_-]{1,128}$/.test(args[1])) throw new Error();
  const child = spawn(process.execPath, [fileURLToPath(import.meta.resolve("next/dist/bin/next")),
    production ? "start" : "dev", "--hostname", "127.0.0.1", "--port", "3100"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { ...process.env, SUPPORT_DEV_USER: args[1] }, stdio: "inherit", windowsHide: true,
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
  child.once("exit", (code) => { process.exitCode = code ?? 1; });
  child.once("error", () => { console.error("[UI] Next 启动失败，请检查依赖与端口 3100。"); process.exitCode = 1; });
} catch {
  console.error("[UI] 请使用 --user <开发用户ID>；生产启动前先运行 pnpm build。");
  process.exitCode = 1;
}
