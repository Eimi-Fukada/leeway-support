import Link from "next/link";

export default function KnowledgeNotFound() {
  return <main className="unavailable-page"><img src="/brand-icon.svg" width={64} height={64} alt=""/><h1>暂时找不到这个知识库</h1><p>它可能已被移除，或不在你的空间中。</p><Link href="/" className="primary-button">返回知识库</Link></main>;
}
