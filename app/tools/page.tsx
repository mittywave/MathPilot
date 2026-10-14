"use client";
import { useEffect, useState } from "react";
import { fetchMe } from "../../lib/api-client";
import { TOOLBOX_TOOLS, type ToolboxTool } from "../../lib/toolbox";
import type { AuthUser } from "../../lib/types";
import { SiteHeader } from "../components/SiteHeader";
import "./tools.css";

function ToolIcon({ name }: { name: ToolboxTool["icon"] | "box" | "arrow" }) {
  const paths = {
    pen: <><path d="m4 16.5 9.8-9.8 3.5 3.5-9.8 9.8L4 21l.5-4.5Z" /><path d="m12.5 8 3.5 3.5M4 21l4.5-.5" /></>,
    arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
    box: <><path d="M3 8h18v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8Z" /><path d="M8 8V5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v3M3 13h18M10 13v2h4v-2" /></>,
    check: <><path d="M9 4h6v3H9z" /><path d="M9 5.5H6.5A1.5 1.5 0 0 0 5 7v12.5A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V7a1.5 1.5 0 0 0-1.5-1.5H15" /><path d="m8.5 14 2.5 2.5 4.5-5" /></>,
    page: <><path d="M6.5 3h8l4 4v12.5a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5.5 19.5v-15A1.5 1.5 0 0 1 7 3Z" /><path d="M14.5 3v4h4M8.5 11h7M8.5 14.5h7M8.5 18h4" /></>,
    share: <><circle cx="18" cy="5.5" r="2.5" /><circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="18.5" r="2.5" /><path d="m8.3 10.8 7.4-4.1M8.3 13.2l7.4 4.1" /></>,
    spark: <><path d="M12 3.5 13.8 9l5.7 1.8-5.7 1.8L12 18.2l-1.8-5.6-5.7-1.8L10.2 9Z" /><path d="M18.5 3.5v3M17 5h3M5.5 17v3M4 18.5h3" /></>,
  } as const;
  return <svg className="tool-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}

export default function ToolboxPage() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => { void fetchMe().then((result) => setUser(result.user)).catch(() => setUser(null)).finally(() => setLoading(false)); }, []);
  // Admin-only tools appear once the account is known to be an administrator.
  const tools = TOOLBOX_TOOLS.filter((tool) => !tool.adminOnly || user?.role === "admin");
  return <><SiteHeader active="tools" user={user} loading={loading} /><main className="toolbox">
    <header className="toolbox-head">
      <span className="toolbox-mark"><ToolIcon name="box" /></span>
      <div><h1>工具箱</h1><p>备课和整理资料时用得上的小工具，点开即可使用。</p></div>
    </header>
    <ul className="toolbox-grid">
      {tools.map((tool) => <li key={tool.key}>
        <a className="tool-card" href={tool.href}>
          <span className="tool-card-icon"><ToolIcon name={tool.icon} /></span>
          <span className="tool-card-copy">
            <strong>{tool.name}</strong>
            <span>{tool.summary}</span>
            <span className="tool-card-tags">{tool.tags.map((tag) => <em key={tag}>{tag}</em>)}</span>
          </span>
          <span className="tool-card-open">打开<ToolIcon name="arrow" /></span>
        </a>
      </li>)}
    </ul>
    <p className="toolbox-note">更多工具会陆续放到这里。</p>
  </main></>;
}
