"use client";
/* eslint-disable @next/next/no-html-link-for-pages -- vinext beta currently breaks next/link RSC prefetch on client-only pages */

/*
 * Login form over a smoky WebGL background (21st.dev "login-form"), with local changes:
 * - The form does what MathPilot accounts can do: sign in with email and password, register with the invite code an
 *   administrator hands out, or browse the library as a guest. The published Google button, "Forgot password?" link and
 *   sign-up link had nothing behind them here; a forgotten password is reset by an administrator in 共享办公.
 * - Icons are drawn inline instead of pulling in lucide-react for three glyphs.
 * - The background keeps one WebGL program and reads the pointer from the whole window through refs. The published
 *   version rebuilt the program on every mouse move without stopping the previous frame loop, and its canvas sat under
 *   the form overlay, so it never saw the pointer anyway.
 * - Colours follow the product page's dark theme.
 */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { login, register } from "../../lib/api-client";
import { BrandWordmark } from "./SiteHeader";

const vertexSmokeySource = `
  attribute vec4 a_position;
  void main() {
    gl_Position = a_position;
  }
`;

// Smoky background: a wavy distortion field, glowing where the waves line up; the pointer bends it.
const fragmentSmokeySource = `
precision mediump float;

uniform vec2 iResolution;
uniform float iTime;
uniform vec2 iMouse;
uniform vec3 u_color;

void mainImage(out vec4 fragColor, in vec2 fragCoord){
    vec2 centeredUV = (2.0 * fragCoord - iResolution.xy) / min(iResolution.x, iResolution.y);
    float time = iTime * 0.5;

    // pointer in 0 … 1, remapped to -1 … 1
    vec2 mouse = iMouse / iResolution;
    vec2 rippleCenter = 2.0 * mouse - 1.0;

    vec2 distortion = centeredUV;
    for (float i = 1.0; i < 8.0; i++) {
        distortion.x += 0.5 / i * cos(i * 2.0 * distortion.y + time + rippleCenter.x * 3.1415);
        distortion.y += 0.5 / i * cos(i * 2.0 * distortion.x + time + rippleCenter.y * 3.1415);
    }

    float wave = abs(sin(distortion.x + distortion.y + time));
    float glow = smoothstep(0.9, 0.2, wave);

    fragColor = vec4(u_color * glow, 1.0);
}

void main() {
    mainImage(gl_FragColor, gl_FragCoord.xy);
}
`;

type BlurSize = "none" | "sm" | "md" | "lg" | "xl" | "2xl" | "3xl";

interface SmokeyBackgroundProps {
  backdropBlurAmount?: BlurSize;
  color?: string;
  className?: string;
}

const blurClassMap: Record<BlurSize, string> = {
  none: "backdrop-blur-none",
  sm: "backdrop-blur-sm",
  md: "backdrop-blur-md",
  lg: "backdrop-blur-lg",
  xl: "backdrop-blur-xl",
  "2xl": "backdrop-blur-2xl",
  "3xl": "backdrop-blur-3xl",
};

const hexToRgb = (hex: string): [number, number, number] => [
  parseInt(hex.substring(1, 3), 16) / 255,
  parseInt(hex.substring(3, 5), 16) / 255,
  parseInt(hex.substring(5, 7), 16) / 255,
];

/** An interactive WebGL shader background; without WebGL the element's own background shows. */
export function SmokeyBackground({ backdropBlurAmount = "sm", color = "#4F7A62", className = "" }: SmokeyBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const gl = canvas?.getContext("webgl");
    if (!canvas || !gl) return;

    const compileShader = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
      gl.deleteShader(shader);
      return null;
    };
    const vertexShader = compileShader(gl.VERTEX_SHADER, vertexSmokeySource);
    const fragmentShader = compileShader(gl.FRAGMENT_SHADER, fragmentSmokeySource);
    const program = gl.createProgram();
    if (!vertexShader || !fragmentShader || !program) return;
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
    gl.useProgram(program);

    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const positionLocation = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    const iResolutionLocation = gl.getUniformLocation(program, "iResolution");
    const iTimeLocation = gl.getUniformLocation(program, "iTime");
    const iMouseLocation = gl.getUniformLocation(program, "iMouse");
    gl.uniform3f(gl.getUniformLocation(program, "u_color"), ...hexToRgb(color));

    // the pointer is read from the whole window: the form covers most of the canvas
    const pointer = { x: 0, y: 0, inside: false };
    const onMove = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointer.x = event.clientX - rect.left;
      pointer.y = event.clientY - rect.top;
      pointer.inside = true;
    };
    const onLeave = () => { pointer.inside = false; };
    window.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);

    // a still frame for visitors who ask for less motion
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const startTime = performance.now();
    let frame = 0;
    const render = () => {
      // drawn at CSS pixels: the smoke is soft and blurred, so device pixels would only cost GPU time
      const width = canvas.clientWidth, height = canvas.clientHeight;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        gl.viewport(0, 0, width, height);
      }
      gl.uniform2f(iResolutionLocation, width, height);
      gl.uniform1f(iTimeLocation, still ? 4 : (performance.now() - startTime) / 1000);
      gl.uniform2f(iMouseLocation, pointer.inside ? pointer.x : width / 2, pointer.inside ? height - pointer.y : height / 2);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      if (!still) frame = requestAnimationFrame(render);
    };
    render();

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      gl.deleteBuffer(positionBuffer);
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
    };
  }, [color]);

  return (
    <div className={`absolute inset-0 w-full h-full overflow-hidden ${className}`}>
      <canvas ref={canvasRef} className="w-full h-full" />
      <div className={`absolute inset-0 ${blurClassMap[backdropBlurAmount]}`}></div>
    </div>
  );
}

const Icon = ({ children }: { children: ReactNode }) => (
  <svg className="inline-block mr-2 -mt-1" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
const MailIcon = () => <Icon><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></Icon>;
const LockIcon = () => <Icon><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></Icon>;
const KeyIcon = () => <Icon><circle cx="7.5" cy="15.5" r="4.5" /><path d="m10.7 12.3 9.3-9.3M17 6l3 3M14 9l2 2" /></Icon>;
const ArrowIcon = () => (
  <svg className="ml-2 h-5 w-5 transform group-hover:translate-x-1 transition-transform" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
);

const inputClass = "block py-2.5 px-0 w-full text-sm text-white bg-transparent border-0 border-b-2 border-gray-300 appearance-none focus:outline-none focus:ring-0 focus:border-[#9DBFAA] peer";
const labelClass = "absolute text-sm text-gray-300 duration-300 transform -translate-y-6 scale-75 top-3 -z-10 origin-[0] peer-focus:left-0 peer-focus:text-[#9DBFAA] peer-placeholder-shown:scale-100 peer-placeholder-shown:translate-y-0 peer-focus:scale-75 peer-focus:-translate-y-6";

function Field({ id, type, label, icon, value, onChange, autoComplete }: {
  id: string; type: string; label: string; icon: ReactNode; value: string; onChange: (value: string) => void; autoComplete: string;
}) {
  return (
    <div className="relative z-0">
      <input type={type} id={id} className={inputClass} placeholder=" " required value={value} autoComplete={autoComplete}
        onChange={(event) => onChange(event.target.value)} />
      <label htmlFor={id} className={labelClass}>{icon}{label}</label>
    </div>
  );
}

/**
 * Glass card that signs a teacher in (or registers one with an invite code) and then opens `next`. `guest` is where
 * visitors without an account may still look around.
 */
export function LoginForm({ next, guest }: { next: string; guest: string }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [invite, setInvite] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const registering = mode === "register";

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
    <div className="w-full max-w-sm p-8 space-y-6 bg-white/10 backdrop-blur-lg rounded-2xl border border-white/20 shadow-2xl">
      <div className="text-center">
        {/* the wordmark reads the app's --green and --muted, set light here for the dark card */}
        <a href="/" className="inline-block text-white/90 hover:text-white transition [--green:#9DBFAA] [--muted:#C8D2CB] [&_.brand-word]:h-7" title="返回产品介绍"><BrandWordmark /></a>
        <h2 className="mt-5 text-3xl font-semibold text-white">{registering ? "加入 MathPilot" : "欢迎回来"}</h2>
        <p className="mt-2 text-sm text-gray-300">{registering ? "用管理员给的邀请码注册教师账号" : "登录后进入数学教研工作台"}</p>
      </div>
      <form className="space-y-8" onSubmit={submit}>
        <Field id="login-email" type="email" label="邮箱" icon={<MailIcon />} value={email} onChange={setEmail} autoComplete="email" />
        <Field id="login-password" type="password" label={registering ? "密码（至少 8 个字符）" : "密码"} icon={<LockIcon />}
          value={password} onChange={setPassword} autoComplete={registering ? "new-password" : "current-password"} />
        {registering && <Field id="login-invite" type="text" label="邀请码" icon={<KeyIcon />} value={invite} onChange={setInvite} autoComplete="off" />}

        {!registering && <p className="-mt-4 text-xs text-gray-400">忘记密码？请联系管理员在「共享办公」里重置。</p>}
        {error && <p role="alert" className="-mt-4 rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-200">{error}</p>}

        <button
          type="submit"
          disabled={submitting}
          className="group w-full flex items-center justify-center py-3 px-4 bg-[#9DBFAA] hover:bg-[#B4D2BF] disabled:opacity-60 rounded-lg text-[#111110] font-semibold focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-900 focus:ring-[#9DBFAA] transition-all duration-300"
        >
          {submitting ? "请稍候…" : registering ? "注册并进入" : "登录"}
          {!submitting && <ArrowIcon />}
        </button>

        <div className="relative flex py-2 items-center">
          <div className="flex-grow border-t border-gray-400/30"></div>
          <span className="flex-shrink mx-4 text-gray-400 text-xs">或者</span>
          <div className="flex-grow border-t border-gray-400/30"></div>
        </div>

        <a
          href={guest}
          className="w-full flex items-center justify-center py-2.5 px-4 border border-white/25 hover:bg-white/10 rounded-lg text-white/90 font-medium focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-900 focus:ring-[#9DBFAA] transition-all duration-300"
        >
          以访客身份浏览题库
        </a>
      </form>
      <p className="text-center text-xs text-gray-400">
        {registering ? "已经有账号？" : "还没有账号？"}
        <button type="button" onClick={switchMode} className="font-semibold text-[#9DBFAA] hover:text-[#C4DECE] transition">
          {registering ? "直接登录" : "使用邀请码注册"}
        </button>
      </p>
    </div>
  );
}
