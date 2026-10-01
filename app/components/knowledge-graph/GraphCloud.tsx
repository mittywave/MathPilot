"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { CloudRenderer, type CloudChain, type CloudHighlight, type CloudInsets, type CloudModel } from "./cloud-renderer";

export type CloudTip = { title: string; meta: string; detail: string; color: string };
export type CloudCommand = { kind: "focus"; index: number; token: number } | { kind: "reset"; token: number } | { kind: "zoom"; factor: number; token: number };

type Props = {
  model: CloudModel;
  highlight: CloudHighlight;
  chain: CloudChain | null;
  spin: boolean;
  command: CloudCommand | null;
  shellRef: RefObject<HTMLElement | null>;
  describe: (index: number) => CloudTip | null;
  onPick: (index: number) => void;
  onUnavailable: (message: string) => void;
};

// Free space for the funnel: panels marked with data-inset push the projection centre
// away from themselves; CSS decides per breakpoint through --kg-inset (0 = float over).
function measureInsets(shell: HTMLElement): CloudInsets {
  const box = shell.getBoundingClientRect(); const insets = { top: 0, right: 0, bottom: 0, left: 0 };
  for (const element of shell.querySelectorAll<HTMLElement>("[data-inset]")) {
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.getPropertyValue("--kg-inset").trim() === "0") continue;
    const rect = element.getBoundingClientRect(); if (rect.width < 2 || rect.height < 2) continue;
    // Classify by the panel's centre: a phone bottom sheet taller than half the screen is still a bottom panel.
    if (rect.width > box.width * 0.8) {
      if ((rect.top + rect.bottom) / 2 - box.top < box.height / 2) insets.top = Math.max(insets.top, rect.bottom - box.top);
      else insets.bottom = Math.max(insets.bottom, box.bottom - rect.top);
    } else if ((rect.left + rect.right) / 2 - box.left < box.width / 2) insets.left = Math.max(insets.left, rect.right - box.left + 8);
    else insets.right = Math.max(insets.right, box.right - rect.left + 8);
  }
  return insets;
}

export default function GraphCloud({ model, highlight, chain, spin, command, shellRef, describe, onPick, onUnavailable }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<CloudRenderer | null>(null);
  const grownRef = useRef(false);
  const highlightRef = useRef(highlight);
  const callbacks = useRef({ onPick, onUnavailable });
  const [hover, setHover] = useState<{ index: number; x: number; y: number; radius: number } | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => { callbacks.current = { onPick, onUnavailable }; }, [onPick, onUnavailable]);

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    let renderer: CloudRenderer;
    try {
      renderer = new CloudRenderer(canvas, {
        onHover: (index, point) => setHover(index >= 0 && point ? { index, ...point } : null),
        onPick: (index) => callbacks.current.onPick(index),
      });
    } catch (error) { callbacks.current.onUnavailable(error instanceof Error ? error.message : "图谱画布无法启动"); return; }
    rendererRef.current = renderer;
    const observer = new ResizeObserver(() => { const rect = canvas.getBoundingClientRect(); setSize({ width: rect.width, height: rect.height }); });
    observer.observe(canvas);
    return () => { observer.disconnect(); renderer.destroy(); rendererRef.current = null; grownRef.current = false; };
  }, []);

  useEffect(() => {
    const renderer = rendererRef.current; if (!renderer) return;
    renderer.setModel(model, { grow: !grownRef.current }); grownRef.current = true;
  }, [model]);
  useEffect(() => { highlightRef.current = highlight; rendererRef.current?.setHighlight(highlight); }, [highlight]);
  useEffect(() => { rendererRef.current?.setSpin(spin); }, [spin]);

  // Panels move and resize with selection, mode and content. Measure right after each commit (before a
  // focus command frames the view) and again whenever one of them resizes.
  useEffect(() => {
    const shell = shellRef.current; const renderer = rendererRef.current; if (!shell || !renderer) return;
    renderer.setInsets(measureInsets(shell));
    let frame = 0;
    const observer = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => renderer.setInsets(measureInsets(shell))); });
    observer.observe(shell);
    for (const element of shell.querySelectorAll<HTMLElement>("[data-inset]")) observer.observe(element);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  });

  // After the panels are measured, so the chain is laid out in the space that is really free.
  useEffect(() => { rendererRef.current?.setChain(chain); }, [chain]);

  useEffect(() => {
    const renderer = rendererRef.current; if (!renderer || !command) return;
    if (command.kind === "focus") renderer.focus(command.index, [...highlightRef.current.upstream, ...highlightRef.current.next]);
    else if (command.kind === "reset") renderer.resetView();
    else renderer.zoomBy(command.factor);
  }, [command]);

  const tip = hover ? describe(hover.index) : null;
  const flip = hover && size.width && hover.x > size.width - 300;
  return <div className="kg-cloud">
    <canvas ref={canvasRef} className="kg-cloud-canvas" role="img"
      aria-label={chain ? "知识点链路图：前置在下、后续在上，拖动或滚动查看，点击圆点或名称切换知识点" : "知识点云图：拖动旋转，滚轮或双指缩放，点击圆点查看它的前置与后续"} />
    {hover && tip && <div className={`kg-tip ${flip ? "flip" : ""}`} style={{ left: flip ? hover.x - hover.radius - 14 : hover.x + hover.radius + 14, top: hover.y }} role="tooltip">
      <p className="kg-tip-meta"><i style={{ background: tip.color }} />{tip.meta}</p>
      <b>{tip.title}</b>
      {tip.detail && <p className="kg-tip-detail">{tip.detail}</p>}
    </div>}
  </div>;
}
