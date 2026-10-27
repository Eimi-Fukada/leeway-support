"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "./Icons.tsx";

export function LoginForm() {
  const router = useRouter();
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setPending(true);
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: form.get("username"), password: form.get("password") }) });
      const body: { error?: string } = await response.json();
      if (!response.ok) { setError(body.error ?? "暂时无法登录，请重试。"); return; }
      router.replace("/"); router.refresh();
    } catch { setError("暂时无法连接，请稍后重试。"); }
    finally { setPending(false); }
  }
  return <form onSubmit={submit} className="login-form">
    <label htmlFor="username">账号</label>
    <input id="username" name="username" autoComplete="username" placeholder="请输入账号" required maxLength={64} disabled={pending}/>
    <label htmlFor="password">密码</label>
    <div className="password-field"><input id="password" name="password" type={visible ? "text" : "password"} autoComplete="current-password" placeholder="请输入密码" required maxLength={256} disabled={pending}/>
      <button type="button" className="icon-button" aria-label={visible ? "隐藏密码" : "显示密码"} aria-pressed={visible} onClick={() => setVisible(!visible)}><Icon name="eye"/></button></div>
    <div className="form-message" aria-live="polite">{error && <p role="alert" className="error">{error}</p>}</div>
    <button className="primary-button login-submit" disabled={pending} type="submit">{pending ? "正在登录…" : "进入知识空间"}<Icon name="arrow" size={18}/></button>
  </form>;
}
