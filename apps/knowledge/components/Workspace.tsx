"use client";
import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { KnowledgeBase, User } from "../src/contracts.ts";
import { Icon } from "./Icons.tsx";
import { KnowledgeDetail } from "./KnowledgeDetail.tsx";

export function Workspace({ user, initialBases, selectedBaseId }: { user: User; initialBases: KnowledgeBase[]; selectedBaseId?: string }) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const [bases, setBases] = useState(initialBases);
  const [pending, setPending] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState("");
  const [logoutError, setLogoutError] = useState("");
  const [notice, setNotice] = useState("");
  const selectedBase = bases.find((base: KnowledgeBase) => base.id === selectedBaseId);
  function open() {
    setError(""); form.current?.reset(); dialog.current?.showModal();
    form.current?.querySelector<HTMLInputElement>("#kb-name")?.focus();
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError("");
    const values = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/knowledge-bases", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: values.get("name"), description: values.get("description") }) });
      const body: { error?: string; knowledgeBase?: KnowledgeBase } = await response.json();
      if (response.status === 401) { router.replace("/login"); router.refresh(); return; }
      if (!response.ok || !body.knowledgeBase) { setError(body.error ?? "创建失败，请重试。"); return; }
      setBases((previous: KnowledgeBase[]) => [body.knowledgeBase!, ...previous]);
      setNotice(`已创建「${body.knowledgeBase.name}」`); dialog.current?.close();
    } catch { setError("创建未完成，请检查连接后重试。"); }
    finally { setPending(false); }
  }
  async function logout() {
    setLeaving(true); setLogoutError("");
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) { setLogoutError("退出未完成，请重试。"); return; }
      router.replace("/login"); router.refresh();
    } catch { setLogoutError("暂时无法连接，请稍后重试。"); }
    finally { setLeaving(false); }
  }
  return <div className={selectedBase ? "workspace workspace-detail" : "workspace"}>
    <aside className="sidebar"><div className="brand"><img src="/brand-icon.svg" width={40} height={40} alt=""/><div>leeway<small>知识空间</small></div></div>
      <div className="sidebar-caption">我的空间</div><nav aria-label="主导航"><Link href="/" className={selectedBase ? "nav-item" : "nav-item selected"} aria-current={selectedBase ? undefined : "page"}><Icon name="book"/>全部知识库</Link></nav>
      <div className="sidebar-library-heading"><span>我的知识库</span><button type="button" className="icon-button" aria-label="添加知识库" onClick={open}><Icon name="plus" size={17}/></button></div>
      <nav className="sidebar-libraries" aria-label="知识库列表">{bases.map((base: KnowledgeBase) => <Link key={base.id} href={`/knowledge-bases/${base.id}`} className={selectedBase?.id === base.id ? "library-link active" : "library-link"} aria-current={selectedBase?.id === base.id ? "page" : undefined}><span className="library-link-icon"><Icon name="book" size={16}/></span><span>{base.name}</span></Link>)}{bases.length === 0 && <p className="sidebar-empty">创建一个，开始积累。</p>}</nav>
      <div className="sidebar-bottom"><div className="user-line"><span className="avatar">S</span><div>{user.username}<small>空间管理员</small></div></div>
        <button className="logout-button" onClick={() => void logout()} disabled={leaving}><Icon name="logout" size={18}/>{leaving ? "正在退出…" : "退出登录"}</button>{logoutError && <p className="error" role="alert">{logoutError}</p>}</div>
    </aside>
    {selectedBase ? <main id="main" className="detail-main"><KnowledgeDetail key={selectedBase.id} base={selectedBase} bases={bases}/>{notice && <p className="detail-notice" role="status">{notice}</p>}</main> : <main id="main" className="library-main"><header className="topbar"><span>我的空间 <span className="breadcrumb-divider">/</span> <strong>知识库</strong></span><span className="space-indicator"><i/> 只属于你的积累</span></header>
      <section className="library-content"><div className="section-header"><div><span className="eyebrow">YOUR KNOWLEDGE, TOGETHER</span><h1>我的知识库<span className="count">{bases.length}</span></h1><p className="muted">把相关的资料放在一起，让知识有序生长。</p></div>{bases.length > 0 && <button className="primary-button" onClick={open}><Icon name="plus" size={18}/>新建知识库</button>}</div>
      <p className="success-message" role="status">{notice}</p>
      {bases.length === 0 ? <div className="empty-state"><div className="empty-symbol"><Icon name="book" size={46}/><span className="empty-leaf"/></div><h2>从第一个知识库开始</h2><p>为一个主题留出空间，<br/>慢慢收集属于它的资料与灵感。</p><button className="primary-button" onClick={open}><Icon name="plus" size={18}/>新建知识库</button><span className="empty-hint">按产品、主题或用途，自由整理</span></div>
      : <div className="knowledge-grid">{bases.map((base: KnowledgeBase) => <Link className="knowledge-card" key={base.id} href={`/knowledge-bases/${base.id}`} aria-label={`打开知识库：${base.name}`}><div className="card-topline"><div className="card-icon"><Icon name="book" size={25}/></div><span className="card-open-arrow"><Icon name="arrow" size={18}/></span></div><h2>{base.name}</h2><p>{base.description || "还没有添加描述"}</p><div className="card-meta"><span>{base.documentCount ? `${base.documentCount} 个文档` : "暂无文档"}</span><time dateTime={base.createdAt}>{new Date(base.createdAt).toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Asia/Shanghai" })}</time></div></Link>)}</div>}
      </section><footer className="workspace-footer">每一点积累，都在为下一次灵感铺路。</footer>
    </main>}
    <dialog ref={dialog} className="create-dialog" aria-labelledby="create-title" onCancel={(event) => { if (pending) event.preventDefault(); }}>
      <form ref={form} onSubmit={create}><div className="dialog-heading"><span className="card-icon"><Icon name="book" size={23}/></span><button type="button" className="icon-button" aria-label="关闭" disabled={pending} onClick={() => dialog.current?.close()}><Icon name="close"/></button></div>
        <h2 id="create-title">新建知识库</h2><p className="muted">给相关的知识，一个共同的名字。</p>
        <label htmlFor="kb-name">知识库名称 <span className="required">*</span></label><input id="kb-name" name="name" placeholder="例如：产品帮助中心" autoFocus required maxLength={60} disabled={pending}/>
        <label htmlFor="kb-description">描述 <span className="optional">选填</span></label><textarea id="kb-description" name="description" placeholder="简单介绍这里会整理哪些资料" rows={3} maxLength={300} disabled={pending}/>
        <div className="form-message" aria-live="polite">{error && <p role="alert" className="error">{error}</p>}</div><div className="dialog-actions"><button type="button" className="secondary-button" disabled={pending} onClick={() => dialog.current?.close()}>取消</button><button type="submit" className="primary-button" disabled={pending}>{pending ? "正在创建…" : "创建知识库"}</button></div>
      </form>
    </dialog>
  </div>;
}
