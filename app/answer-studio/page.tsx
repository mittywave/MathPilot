"use client";
import { useEffect } from "react";

// 文件转录 (formerly 手写转录) moved into the toolbox; old bookmarks land on the new address.
const TARGET = "/tools/answer-studio";

export default function AnswerStudioRedirect() {
  useEffect(() => { window.location.replace(`${TARGET}${window.location.search}${window.location.hash}`); }, []);
  return <main style={{ padding: 24 }}><p>文件转录已移到工具箱，正在跳转…</p><a href={TARGET}>如未自动跳转，请点这里</a></main>;
}
