"use client";
import { useToast } from "../../components/Toast";
import { useConfirm } from "../../components/ConfirmDialog";
import { SiteHeader } from "../../components/SiteHeader";
import QRCode from "qrcode";
import { useCallback, useEffect, useState } from "react";
import { changeTeamInvite, fetchMe, fetchTeam, loginPath, resetTeamPassword, updateTeamMember } from "../../../lib/api-client";
import { copyText } from "../../../lib/copy-text";
import { fetchShareStatus, forgetSharedNetwork, setSharing, type ShareStatus } from "../../../lib/lan-share-client";
import type { AuthUser, TeamInvite, TeamMember } from "../../../lib/types";
import "../tools.css";
import "./sharing.css";

type Notify = (message: string, ok?: boolean) => void;
type Team = { members: TeamMember[]; invite: TeamInvite };

const errorText = (error: unknown, fallback: string) => {
  const message = error instanceof Error ? error.message : fallback;
  // Before the server restarts, the new account columns do not exist yet.
  return /no such (column|table)/i.test(message) ? "请在运行 MathPilot 的电脑上重新启动后再试" : message;
};

function lastLogin(time: number | null) {
  if (!time) return "尚无登录记录";
  const date = new Date(time);
  const today = new Date().toDateString() === date.toDateString();
  return `最近登录 ${today ? `今天 ${date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}` : date.toLocaleDateString("zh-CN")}`;
}

export default function SharingPage() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [toastNode, show] = useToast();
  const notify = useCallback<Notify>((text, ok = true) => show({ text, tone: ok ? "success" : "error" }), [show]);

  useEffect(() => { void fetchMe().then((result) => setUser(result.user)).catch(() => notify("登录状态读取失败，请刷新重试", false)).finally(() => setLoaded(true)); }, [notify]);

  let body;
  if (!loaded) body = <p className="sharing-muted">正在读取…</p>;
  else if (!user) body = <div className="sharing-card"><h2>请先登录</h2><p className="sharing-muted">登录后才能使用共享办公。</p><a className="primary-button sharing-link" href={loginPath("/tools/sharing")}>去登录</a></div>;
  else if (user.role !== "admin") body = <div className="sharing-card"><h2>共享办公由管理员管理</h2><p className="sharing-muted">需要开通账号、重置密码或调整权限时，请联系管理员。</p></div>;
  else body = <><ShareSection notify={notify} /><TeamSections me={user} notify={notify} /></>;
  return <><SiteHeader active="tools" user={user} loading={!loaded} trail={[{label:"工具箱",href:"/tools"},{label:"共享办公"}]} /><main className="toolbox sharing">
    {body}
    {toastNode}
  </main></>;
}

function ShareSection({ notify }: { notify: Notify }) {
  // undefined: still checking; null: no switch here (a deployed site, not 启动知题).
  const [status, setStatus] = useState<ShareStatus | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState<{ address: string; image: string } | null>(null);
  const refresh = useCallback(() => fetchShareStatus().then(setStatus), []);

  // Arriving at a remembered network turns sharing on by itself; keep the page in step.
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 15_000);
    return () => clearInterval(timer);
  }, [refresh]);
  const address = status?.sharing ? status.addresses[0] ?? "" : "";
  useEffect(() => {
    if (!address) return;
    let live = true;
    void QRCode.toDataURL(address, { width: 168, margin: 1, color: { dark: "#1f2d27", light: "#ffffff" } }).then((image) => { if (live) setQr({ address, image }); }).catch(() => undefined);
    return () => { live = false; };
  }, [address]);
  const qrImage = qr?.address === address ? qr.image : "";

  // The switch moves at once; the server's answer then replaces it, or the old state returns.
  async function change(sharing: boolean, remember: boolean, message: string) {
    setBusy(true);
    setStatus((current) => current && { ...current, sharing, autoHere: remember });
    try { setStatus(await setSharing(sharing, remember)); notify(message); }
    catch (error) { notify(errorText(error, "共享设置失败"), false); void refresh(); }
    finally { setBusy(false); }
  }
  async function forget(id: string) {
    try { setStatus(await forgetSharedNetwork(id)); notify("已忘记这个网络"); }
    catch (error) { notify(errorText(error, "操作失败"), false); }
  }
  async function copy(text: string, what: string) { const ok = await copyText(text); notify(ok ? `${what}已复制` : "复制失败，请手动选中复制", ok); }

  if (status === undefined) return <section className="sharing-card"><p className="sharing-muted">正在检查共享状态…</p></section>;
  if (status === null) return <section className="sharing-card"><h2>共享给同事</h2><p className="sharing-muted">这里没有共享开关：网站部署在线上时，同事直接用网址访问。共享开关只出现在运行 MathPilot 的这台电脑上。</p></section>;
  const canChange = status.local && Boolean(status.network);
  return <section className="sharing-card" aria-labelledby="share-title">
    <div className="sharing-card-head">
      <div><h2 id="share-title">共享给同事</h2><p>{status.network ? `当前网络：${status.network.label}` : "这台电脑现在没有连接局域网"}</p></div>
      <span className={`sharing-state${status.sharing ? " on" : ""}`}>{status.sharing ? "正在共享" : "未共享"}</span>
    </div>
    <label className="sharing-option">
      <input type="checkbox" role="switch" checked={status.sharing} disabled={!canChange || busy}
        onChange={(event) => void change(event.target.checked, event.target.checked && status.autoHere, event.target.checked ? "已共享给同事" : "已停止共享")} />
      <b>共享给同事</b><small>{status.sharing ? "同一网络里的同事可以打开这台电脑上的 MathPilot。" : "现在只有这台电脑能用；同事打开会看到「暂未共享」。"}</small>
    </label>
    <label className="sharing-option">
      <input type="checkbox" checked={status.autoHere} disabled={!canChange || busy}
        onChange={(event) => void change(event.target.checked || status.sharing, event.target.checked, event.target.checked ? "已记住这个网络，以后连上就自动共享" : "不再在这个网络自动共享")} />
      <b>在这个网络自动开启</b><small>以后连上这个网络（比如公司）就自动共享，离开后自动停止。关闭共享时也会一并取消。</small>
    </label>

    {status.sharing && <div className="sharing-address">
      {qrImage && <img src={qrImage} alt="共享地址的二维码，手机扫码即可打开" width={168} height={168} />}
      <div>
        <p className="sharing-muted">把这个地址发给同事：</p>
        {status.addresses.map((url, index) => <div className="sharing-url" key={url}>
          <code>{url}</code>
          <button className="secondary" onClick={() => void copy(url, "地址")}>复制</button>
          <small>{index === 0 ? "固定地址：这台电脑换了 IP 也不变" : "备用：上面的打不开时用这个，IP 变了需要重新发"}</small>
        </div>)}
      </div>
    </div>}
    {status.sharing && status.keepAwake && <p className="sharing-hint">共享期间这台 Mac 不会自动睡眠；合上屏幕仍会断开同事的访问。</p>}
    {!status.local && <p className="sharing-hint">只能在运行 MathPilot 的这台电脑上开关共享。</p>}
    {!!status.remembered.length && <div className="sharing-networks">
      <p className="sharing-muted">已记住的网络</p>
      <ul>{status.remembered.map((item) => <li key={item.id}>
        <span><b>{item.label}</b><small>{item.current ? "当前所在网络 · " : ""}记住于 {new Date(item.rememberedAt).toLocaleDateString("zh-CN")}</small></span>
        {status.local && <button className="text-button" onClick={() => void forget(item.id)}>忘记</button>}
      </li>)}</ul>
    </div>}
  </section>;
}

function TeamSections({ me, notify }: { me: AuthUser; notify: Notify }) {
  const [confirmNode, confirm] = useConfirm();
  const [team, setTeam] = useState<Team | null>(null);
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState("");
  const [password, setPassword] = useState<{ email: string; value: string } | null>(null);

  useEffect(() => { void fetchTeam().then(setTeam).catch((error) => setFailure(errorText(error, "成员读取失败"))); }, []);

  async function changeInvite(action: "rotate" | "close") {
    if (action === "rotate" && team?.invite.mode === "code" && !await confirm({ title: "更换邀请码", body: "旧邀请码立即失效，已经注册的同事不受影响。", confirmLabel: "更换邀请码", danger: true })) return;
    if (action === "close" && !await confirm({ title: "关闭注册", body: "同事将无法用邀请码注册新账号，已有账号照常使用。", confirmLabel: "关闭注册", danger: true })) return;
    setBusy("invite");
    try { const result = await changeTeamInvite(action); setTeam((current) => current && { ...current, invite: result.invite }); notify(action === "rotate" ? "已生成新的邀请码" : "已关闭注册"); }
    catch (error) { notify(errorText(error, "邀请码更新失败"), false); }
    finally { setBusy(""); }
  }

  async function update(member: TeamMember, changes: { role?: TeamMember["role"]; disabled?: boolean }, message: string) {
    setBusy(member.id);
    try { const result = await updateTeamMember(member.id, changes); setTeam((current) => current && { ...current, members: current.members.map((item) => item.id === member.id ? result.member : item) }); notify(message); }
    catch (error) { notify(errorText(error, "操作失败"), false); }
    finally { setBusy(""); }
  }

  async function reset(member: TeamMember) {
    if (!await confirm({ title: `重置 ${member.email} 的密码`, body: "将生成新密码，TA 当前的登录会失效。", confirmLabel: "重置密码", danger: true })) return;
    setBusy(member.id);
    try { setPassword({ email: member.email, value: (await resetTeamPassword(member.id)).password }); }
    catch (error) { notify(errorText(error, "密码重置失败"), false); }
    finally { setBusy(""); }
  }

  if (failure) return <section className="sharing-card"><h2>邀请码与同事账号</h2><p className="sharing-warning">{failure}</p></section>;
  if (!team) return <section className="sharing-card"><p className="sharing-muted">正在读取同事账号…</p></section>;
  const { invite, members } = team;
  return <>
    <section className="sharing-card" aria-labelledby="invite-title">
      <div className="sharing-card-head"><div><h2 id="invite-title">邀请码</h2><p>同事打开共享地址，点右上角「登录 / 注册」，注册时填这个邀请码。</p></div></div>
      {invite.mode === "code" && invite.code ? <div className="sharing-invite">
        <code>{invite.code}</code>
        <button className="secondary" onClick={() => void copyText(invite.code!).then((ok) => notify(ok ? "邀请码已复制" : "复制失败，请手动选中复制", ok))}>复制</button>
        <button className="secondary" disabled={busy === "invite"} onClick={() => void changeInvite("rotate")}>换一个</button>
        <button className="text-button" disabled={busy === "invite"} onClick={() => void changeInvite("close")}>关闭注册</button>
      </div> : <div className="sharing-invite empty">
        <p className="sharing-muted">{invite.mode === "config" ? "正在使用配置文件（.dev.vars）里的邀请码。生成新的之后，以这里的为准。" : invite.mode === "closed" ? "注册已关闭，同事暂时无法注册新账号。" : "还没有邀请码，同事暂时无法注册。"}</p>
        <button className="primary-button" disabled={busy === "invite"} onClick={() => void changeInvite("rotate")}>生成邀请码</button>
      </div>}
    </section>

    <section className="sharing-card" aria-labelledby="members-title">
      <div className="sharing-card-head"><div><h2 id="members-title">同事账号 · {members.length}</h2><p>所有老师都能录题、改题、编讲义；只有管理员能删除内容和管理这里。</p></div></div>
      {me.local && <p className="sharing-hint">你现在是这台电脑上的本机管理员，始终拥有管理权限，不在下面的列表里。</p>}
      {!members.length ? <p className="sharing-muted">还没有同事注册。把共享地址和邀请码发给同事，注册后会出现在这里。</p> : <ul className="sharing-members">{members.map((member) => {
        const self = member.id === me.id; const disabled = member.disabledAt != null; const working = busy === member.id;
        return <li key={member.id} className={disabled ? "disabled" : ""}>
          <span className="sharing-member">
            <b>{member.email}</b>
            <span className="sharing-badges">{member.role === "admin" && <em className="admin">管理员</em>}{disabled && <em className="off">已停用</em>}{self && <em>你</em>}</span>
            <small>注册于 {new Date(member.createdAt).toLocaleDateString("zh-CN")} · {lastLogin(member.lastLoginAt)}</small>
          </span>
          {!self && <span className="sharing-actions">
            {!disabled && <button className="secondary" disabled={working} onClick={() => void update(member, { role: member.role === "admin" ? "member" : "admin" }, member.role === "admin" ? "已取消管理员" : "已设为管理员")}>{member.role === "admin" ? "取消管理员" : "设为管理员"}</button>}
            {!disabled && <button className="secondary" disabled={working} onClick={() => void reset(member)}>重置密码</button>}
            <button className={disabled ? "secondary" : "text-button sharing-danger"} disabled={working}
              onClick={async () => { if (disabled || await confirm({ title: `停用 ${member.email}`, body: "TA 会立即退出、无法再登录；录入的题目和讲义都会保留。", confirmLabel: "停用账号", danger: true })) void update(member, { disabled: !disabled }, disabled ? "已恢复账号" : "已停用账号"); }}>{disabled ? "恢复" : "停用"}</button>
          </span>}
        </li>;
      })}</ul>}
    </section>

    {confirmNode}
    {password && <div className="modal-backdrop"><section className="modal export-modal" role="dialog" aria-modal="true" aria-label="新密码">
      <div className="modal-head"><div><span className="eyebrow">重置密码</span><h2>{password.email}</h2></div><button className="close" aria-label="关闭" onClick={() => setPassword(null)}>×</button></div>
      <p className="sharing-muted">把新密码告诉这位同事，TA 用它登录。这个密码只显示这一次。</p>
      <div className="sharing-invite"><code>{password.value}</code><button className="secondary" onClick={() => void copyText(password.value).then((ok) => notify(ok ? "新密码已复制" : "复制失败，请手动选中复制", ok))}>复制</button></div>
      <div className="modal-actions"><button className="primary-button" onClick={() => setPassword(null)}>我已记下</button></div>
    </section></div>}
  </>;
}
