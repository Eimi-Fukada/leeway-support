import { redirect } from "next/navigation";
import { currentUser } from "../../src/server/runtime.ts";
import { LoginForm } from "../../components/LoginForm.tsx";
import { Icon } from "../../components/Icons.tsx";

export const dynamic = "force-dynamic";
export default async function LoginPage() {
  if (await currentUser()) redirect("/");
  return <main className="login-page">
    <div className="brand"><img src="/brand-icon.svg" width={42} height={42} alt=""/><span>leeway<span className="brand-separator">/</span><span className="brand-subtitle">知识空间</span></span></div>
    <section className="login-layout">
      <div className="login-story"><span className="eyebrow">A LITTLE SPACE FOR BIG IDEAS</span>
        <h1>好知识，<br/>值得好好收藏<span>。</span></h1>
        <p>为资料找一个位置，<br/>让每一次积累，都有迹可循。</p>
        <div className="book-art" aria-hidden="true"><div className="art-orbit"/><div className="art-sheet sheet-back"/><div className="art-sheet sheet-middle"/><div className="art-sheet sheet-front"><img src="/brand-icon.svg" width={102} height={102} alt=""/><span className="art-line"/><span className="art-line short"/></div><span className="art-dot dot-one"/><span className="art-dot dot-two"/></div>
      </div>
      <div className="login-card"><div className="login-card-icon"><Icon name="lock" size={21}/></div><h2>欢迎回来</h2><p className="muted">登录，继续整理你的知识。</p><LoginForm/><p className="login-note">专属空间 · 有序积累</p></div>
    </section>
    <footer className="login-footer">Leeway Knowledge <span>留一点空间，给新的想法。</span></footer>
  </main>;
}
