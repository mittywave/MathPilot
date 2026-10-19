"use client";
import { useEffect, useState } from "react";
import { fetchMe } from "../../lib/api-client";
import { LoginForm, SmokeyBackground } from "../components/LoginForm";

// Where 进入工作台 and every 去登录 lead when nobody is signed in. A signed-in teacher (or the Mac itself, which is
// always the local administrator) goes straight on to `next`.
const LIBRARY = "/library";

// only paths on this site, never back to this page
function nextPath(search: string) {
  const next = new URLSearchParams(search).get("next") ?? "";
  return next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/login") ? next : LIBRARY;
}

export default function LoginPage() {
  const [next, setNext] = useState<string | null>(null);

  useEffect(() => {
    const target = nextPath(window.location.search);
    let cancelled = false;
    fetchMe()
      .then(({ user }) => {
        if (cancelled) return;
        if (user) window.location.replace(target);
        else setNext(target);
      })
      .catch(() => { if (!cancelled) setNext(target); });
    return () => { cancelled = true; };
  }, []);

  return (
    <main className="relative w-screen h-screen overflow-hidden bg-[#111110]">
      <SmokeyBackground className="absolute inset-0" />
      <div className="relative z-10 flex items-center justify-center w-full h-full p-4">
        {next && <LoginForm next={next} guest={next === "/library?from=intro" ? next : LIBRARY} />}
      </div>
    </main>
  );
}
