"use client";
/* eslint-disable @next/next/no-html-link-for-pages -- client-only vinext navigation */
import { TOOLBOX_TOOLS, type ToolboxTool } from "../../lib/toolbox";
import "./tools.css";

function ToolIcon({ name }: { name: ToolboxTool["icon"] | "back" | "box" | "arrow" }) {
  const paths = {
    pen: <><path d="m4 16.5 9.8-9.8 3.5 3.5-9.8 9.8L4 21l.5-4.5Z" /><path d="m12.5 8 3.5 3.5M4 21l4.5-.5" /></>,
    back: <path d="m10 5-7 7 7 7M3 12h18" />,
    arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
    box: <><path d="M3 8h18v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8Z" /><path d="M8 8V5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v3M3 13h18M10 13v2h4v-2" /></>,
  } as const;
  return <svg className="tool-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}

export default function ToolboxPage() {
  return <main className="toolbox">
    <a className="toolbox-back" href="/"><ToolIcon name="back" /><span>返回 Mitty 题库</span></a>
    <header className="toolbox-head">
      <span className="toolbox-mark"><ToolIcon name="box" /></span>
      <div><h1>工具箱</h1><p>备课和整理资料时用得上的小工具，点开即可使用。</p></div>
    </header>
    <ul className="toolbox-grid">
      {TOOLBOX_TOOLS.map((tool) => <li key={tool.key}>
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
  </main>;
}
