"use client";

/*
 * The login window over the product page, in the page's own colours. It does what MathPilot accounts can do: sign in
 * with email and password, register with the invite code an administrator hands out, or browse the library as a guest.
 * A forgotten password is reset by an administrator in 共享办公. The window is glass: the ∞'s sand gathers into its
 * frame and settles behind it (see app/(home)/Intro.tsx).
 */
import { useEffect, useRef, useState, type FormEvent, type Ref } from "react";
import { login, register } from "../../lib/api-client";
import { BrandWordmark } from "./SiteHeader";

function Field({ id, type, label, value, onChange, autoComplete }: {
  id: string; type: string; label: string; value: string; onChange: (value: string) => void; autoComplete: string;
}) {
  return (
    <div className="mp-field">
      {/* the label sits in the field until there is something in it */}
      <input type={type} id={id} placeholder=" " required value={value} autoComplete={autoComplete}
        onChange={(event) => onChange(event.target.value)} />
      <label htmlFor={id}>{label}</label>
    </div>
  );
}

/**
 * Signs a teacher in (or registers one with an invite code) and then opens `next`. `guest` is where visitors without an
 * account may still look around; `onClose` goes back to the product page.
 */
export function LoginForm({ next, guest, onClose, ref }: { next: string; guest: string; onClose: () => void; ref?: Ref<HTMLDivElement> }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [invite, setInvite] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const registering = mode === "register";
  const form = useRef<HTMLFormElement>(null);
  // the window is a dialog: typing starts in it
  useEffect(() => { form.current?.querySelector("input")?.focus({ preventScroll: true }); }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      if (registering) await register(email, password, invite);
      else await login(email, password);
      window.location.assign(next);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "没有成功，请重试");
      setSubmitting(false);
    }
  }

  const switchMode = () => {
    setMode(registering ? "login" : "register");
    setError("");
  };

  return (
    <div ref={ref} className="mp-login-card">
      <div className="mp-login-top">
        <BrandWordmark />
        <button type="button" className="mp-login-close" onClick={onClose} title="返回介绍页" aria-label="返回介绍页">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <p className="mp-kicker">{registering ? "注册" : "登录"}</p>
      <h2 id="mp-login-title">{registering ? <>欢迎加入，<em>一起备课。</em></> : <>欢迎回来，<em>继续教与学。</em></>}</h2>
      <p className="mp-login-lead">{registering ? "用管理员给的邀请码注册教师账号。" : "登录后进入数学教研工作台。"}</p>
      <form ref={form} className="mp-login-form" onSubmit={submit}>
        <Field id="login-email" type="email" label="邮箱" value={email} onChange={setEmail} autoComplete="email" />
        <Field id="login-password" type="password" label={registering ? "密码（至少 8 个字符）" : "密码"}
          value={password} onChange={setPassword} autoComplete={registering ? "new-password" : "current-password"} />
        {registering && <Field id="login-invite" type="text" label="邀请码" value={invite} onChange={setInvite} autoComplete="off" />}
        {!registering && <p className="mp-login-note">忘记密码？请联系管理员在「共享办公」里重置。</p>}
        {error && <p role="alert" className="mp-login-error">{error}</p>}
        <button type="submit" className="mp-btn mp-login-submit" disabled={submitting}>
          {submitting ? "请稍候…" : registering ? "注册并进入" : "登录"}
          {!submitting && <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path d="M2 7h10M8 3l4 4-4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>}
        </button>
        <p className="mp-login-or"><span>或者</span></p>
        <a href={guest} className="mp-login-guest">以访客身份浏览题库</a>
      </form>
      <p className="mp-login-switch">
        {registering ? "已经有账号？" : "还没有账号？"}
        <button type="button" onClick={switchMode}>{registering ? "直接登录" : "使用邀请码注册"}</button>
      </p>
    </div>
  );
}
