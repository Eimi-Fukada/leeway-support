"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return <main className="unavailable-page"><img src="/brand-icon.svg" width={64} height={64} alt=""/><h1>暂时无法打开空间</h1><p>请稍后重试，或联系管理员检查服务连接。</p><button className="primary-button" onClick={reset}>重新加载</button></main>;
}
