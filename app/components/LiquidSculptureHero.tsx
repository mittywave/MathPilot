"use client"

/**
 * Sculpture Hero — liquid particle hero
 * by guglielmogiannattasio.it
 *
 * The sculpture is rebuilt from ~100k GPU-simulated particles sampled from
 * its own pixels. The cursor turns the material liquid; it settles back into
 * the crisp image. Without WebGL2 the static image is shown.
 *
 * Taken from 21st.dev as published, with local changes: `brand` accepts a node (the MathPilot
 * wordmark), `onThemeChange` lets the rest of the page follow the theme switch, and `scrollForms`
 * places the sculpture on a layer fixed behind the page as the page scrolls, and bends it along
 * its ribbon into the frame of a window (the login window, the workbench's frame). The engine is
 * exported for the formulas behind that window, a picture of many pieces that each drift on their
 * own, and rests while the sculpture is out of sight. The sun/moon icons of the theme switch live
 * in ThemeIcons, shared with the workbench's toggle.
 */

import * as React from "react"
import { MoonIcon, SunIcon } from "./ThemeIcons"

/* ────────────────────────────────────────────────────────────────────
   Engine (WebGL2 GPGPU particles)
   ──────────────────────────────────────────────────────────────────── */

export type Rect = { x: number; y: number; w: number; h: number }

/** A part of the picture (`box`, in its own 0 … 1 units) moved by `x`, `y` px. Only the grains move, so pieces are
 *  for pictures drawn as particles at rest (`restStyle: "particles"`); boxes must not overlap. */
export type SculpturePiece = { box: Rect; x: number; y: number }
const MAX_PIECES = 32
// points in the table that lays the window's frame out (reachTable)
const REACH = 256

/** A shape the sculpture can take, in viewport px. "image" is the picture itself, its pieces moved if given. "window"
 *  bends the material along the sculpture's centre line (`ribbon`) into the frame of a window: the ∞ opens at its
 *  crossing, its upper arcs run along the top, its lower arcs along the bottom and the tips meet at the sides, with
 *  `fill` of the grains settled inside it as dust. */
export type SculptureShape =
  | { kind: "image"; rect: Rect; pieces?: SculpturePiece[] }
  | {
      kind: "window"
      rect: Rect
      /** corner radius, the frame's half width and how far its middle sits outside `rect`, in px */
      radius: number
      halfWidth: number
      outset: number
      /** share of the grains (0 … 1) spread over the inside */
      fill: number
    }

/** The sculpture between two shapes: `mix` 0 is `from`, 1 is `to`. `moving` keeps the animation running; `away` says
 *  the shape is out of sight, and the engine rests until the page moves or the pointer stirs again. */
export interface SculptureMorph {
  from: SculptureShape
  to: SculptureShape
  mix: number
  /** Pour the grains one after another through a single twisting thread that leaves `from` at `out` and enters `to`
   *  at `in` (viewport px), instead of moving them all at once; `swing` is how far it swings out to the side (px). */
  stream?: { out: [number, number]; in: [number, number]; swing?: number }
  alpha?: number
  moving?: boolean
  away?: boolean
}

/** The sculpture's centre line in its image, t ∈ [0, 2π) in image px, and how far the ribbon reaches either side. */
export interface SculptureRibbon {
  at: (t: number) => [number, number]
  halfWidth: (t: number) => number
}

export interface EngineOptions {
  interactive: boolean
  strength: number
  radius: number
  density: number
  dotSize: number
  spread: number
  turbulence: number
  returnSpeed: number
  streaks: boolean
  restStyle: "image" | "particles"
  ambient: boolean
  ambientIntensity: number
  speed: number
  intro: boolean
  reducedMotion: boolean
  bg: [number, number, number]
  /** null = detected from the image corners */
  imgBg: [number, number, number] | null
  /** 0 – 2: how much the whole sculpture flows while the cursor is over it */
  liquid: number
  /** the most canvas px per CSS px: 2 by default, 1.5 on low-power devices */
  maxDpr?: number
}

/** What the engine samples its grains from. */
type Picture = HTMLImageElement | HTMLCanvasElement
const pictureWidth = (p: Picture) => (p instanceof HTMLImageElement ? p.naturalWidth : p.width)
const pictureHeight = (p: Picture) => (p instanceof HTMLImageElement ? p.naturalHeight : p.height)

function clamp(v: number, a: number, b: number) {
  return Math.min(b, Math.max(a, v))
}

function hexToRgb(hex: string, fallback: [number, number, number]): [number, number, number] {
  if (typeof hex !== "string") return fallback
  const s = hex.trim()
  let m = s.match(/^#?([0-9a-f]{3})$/i)
  if (m) {
    const [r, g, b] = m[1].split("").map((c) => parseInt(c + c, 16) / 255)
    return [r, g, b]
  }
  m = s.match(/^#?([0-9a-f]{6})([0-9a-f]{2})?$/i)
  if (m) {
    const n = parseInt(m[1], 16)
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
  }
  m = s.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i)
  if (m) return [+m[1] / 255, +m[2] / 255, +m[3] / 255]
  return fallback
}

/* ── shaders ─────────────────────────────────────────────────────────── */

const NOISE = `
float hash(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p,p+45.32); return fract(p.x*p.y); }
float vnoise(vec2 p){ vec2 i=floor(p); vec2 f=fract(p); vec2 u=f*f*f*(f*(f*6.0-15.0)+10.0);
  return mix(mix(hash(i),hash(i+vec2(1.0,0.0)),u.x), mix(hash(i+vec2(0.0,1.0)),hash(i+vec2(1.0,1.0)),u.x), u.y); }
vec2 ambientField(vec2 uv, float t){
  vec2 q = uv*vec2(3.2,1.7);
  vec2 a = vec2(vnoise(q+vec2(t*0.11,0.0))-0.5, vnoise(q+vec2(5.2,t*0.08)+3.1)-0.5);
  vec2 q2 = uv*vec2(7.5,4.0) + vec2(-t*0.19, t*0.13);
  vec2 b = vec2(vnoise(q2+1.7)-0.5, vnoise(q2+9.3)-0.5);
  return a + b*0.45;
}
`

/* energy of the material at a point: shared by image and particles so the
   cross-fade is exactly complementary */
const ENERGY = `
float energyAt(vec2 rectPx, vec2 mouse, float radius, float presence, float wakeEnergy){
  vec2 d = rectPx - mouse;
  float f = exp(-dot(d,d)/(radius*radius))*presence;
  return smoothstep(0.06, 0.5, f*1.15 + wakeEnergy*1.7);
}
`

/* Shapes: where a grain sits in shape A and in shape B, and how far it has travelled between them. Every grain knows
   its place along the centre line (uRib: t, its offset in half ribbon widths, how much material it stands for), so each
   shape keeps the strands in order. Kinds: 0 the picture (its pieces moved by uPieceAt), 1 the frame of a window (laid
   out by the reach table in uRib's last row). */
const SHAPES = `
uniform sampler2D uRib;
uniform int uPieces;
uniform vec4 uPieceBox[${MAX_PIECES}];
uniform vec2 uPieceAt[${MAX_PIECES}];
uniform int uKindA;
uniform int uKindB;
uniform vec4 uA0;
uniform vec4 uA1;
uniform vec4 uB0;
uniform vec4 uB1;
uniform float uMix;
uniform float uStream;
uniform vec4 uStreamEnds;
uniform float uStreamWidth;
uniform float uStreamSwing;
uniform float uStagger;
uniform float uSwirl;
uniform float uCirculate;
const float PI = 3.14159265;
// loose fibres and dust, beyond the ribbon's edge, are drawn in close to the frame's line
float tighten(float n){ float a = abs(n); return a <= 1.0 ? n : sign(n)*(1.0 + (a - 1.0)*0.3); }
// how far the piece of the picture a grain belongs to has moved
vec2 pieceAt(vec2 uv){
  for(int k = 0; k < ${MAX_PIECES}; k++){
    if(k >= uPieces) break;
    vec4 b = uPieceBox[k];
    if(uv.x >= b.x && uv.y >= b.y && uv.x <= b.x + b.z && uv.y <= b.y + b.w) return uPieceAt[k];
  }
  return vec2(0.0);
}
// The rest lays each quarter of the line out evenly along a quarter of the frame, from the crossing (the middle
// of the top or the bottom) round the corner to the tip (the middle of a side): l is the share of the quarter's
// grains that lie before this one, from the reach table. Quarters 0 and 1 are the right side, 0 and 2 the top.
void frameLine(vec2 uv, vec4 rib, out float l, out float quarter, inout float n){
  float u = mod(rib.x + PI*0.5, 2.0*PI) - PI*0.5;
  quarter = u < 0.0 ? 0.0 : u < PI*0.5 ? 1.0 : u < PI ? 2.0 : 3.0;
  float reach = quarter < 0.5 ? u/(PI*0.5) + 1.0 : quarter < 1.5 ? 1.0 - u/(PI*0.5) : quarter < 2.5 ? u/(PI*0.5) - 1.0 : 3.0 - u/(PI*0.5);
  float x = clamp(reach, 0.0, 1.0)*${REACH - 1}.0;
  int row = textureSize(uRib, 0).y - 1, k = int(x);
  vec4 pick = vec4(equal(vec4(quarter), vec4(0.0, 1.0, 2.0, 3.0)));
  l = mix(dot(texelFetch(uRib, ivec2(k, row), 0), pick), dot(texelFetch(uRib, ivec2(min(k + 1, ${REACH - 1}), row), 0), pick), fract(x));
  // where two quarters meet their strands lie differently across the band, so there it is spread evenly instead
  float meet = 1.0 - smoothstep(0.0, 0.07, l)*(1.0 - smoothstep(0.93, 1.0, l));
  n = mix(n, hash(uv*vec2(37.1, 71.9))*2.0 - 1.0, meet);
}
vec2 frameAt(vec4 p0, vec4 p1, float l, float quarter, float n){
  vec2 hs = p0.zw*0.5;
  float R = min(p1.x, min(hs.x, hs.y));
  float a = hs.x - R, b = PI*0.5*R, h = hs.y - R;
  float s = l*(a + b + h);
  vec2 pt; vec2 nm;
  if(s < a){ pt = vec2(s, -hs.y); nm = vec2(0.0, -1.0); }
  else if(s < a + b){ float ph = (s - a)/max(R, 0.001); nm = vec2(sin(ph), -cos(ph)); pt = vec2(a, -h) + nm*R; }
  else { pt = vec2(hs.x, -h + (s - a - b)); nm = vec2(1.0, 0.0); }
  vec2 side = vec2(quarter < 1.5 ? 1.0 : -1.0, mod(quarter, 2.0) < 0.5 ? 1.0 : -1.0);
  return p0.xy + hs + (pt + nm*(p1.z + n*p1.y))*side;
}
// a place on a frame by its distance round the outline from the middle of the top (0) to the middle of the bottom
// (1), on the right or the left
vec2 frameFromTop(vec4 p0, vec4 p1, float d, bool right, float n){
  return d < 0.5 ? frameAt(p0, p1, 2.0*d, right ? 0.0 : 2.0, n) : frameAt(p0, p1, 2.0 - 2.0*d, right ? 1.0 : 3.0, n);
}
// xy in viewport px, z = how much of the material shows there, w = how big the grain is drawn
vec4 shapeAt(int kind, vec4 p0, vec4 p1, vec2 uv, vec4 rib){
  if(kind == 0) return vec4(p0.xy + uv*p0.zw + pieceAt(uv), 1.0, 1.0);
  float n = tighten(rib.y);
  // a share of the grains, picked at random, settles inside as dust
  if(hash(uv*vec2(613.7, 287.3)) < p1.w){
    vec2 r = vec2(hash(uv*vec2(91.7, 41.3)), hash(uv*vec2(23.9, 157.1)));
    return vec4(p0.xy + (0.015 + 0.97*r)*p0.zw, 1.0, 1.15);
  }
  float l, quarter;
  frameLine(uv, rib, l, quarter, n);
  return vec4(frameAt(p0, p1, l, quarter, n), 1.0, 1.0);
}
// the lobe tips lead and the crossing follows; grains next to each other keep together, so the ribbon stays a ribbon
float travel(float t, float sd){
  float delay = ((1.0 - abs(cos(t)))*0.96 + sd*0.04)*uStagger;
  float e = clamp((uMix - delay)/max(1.0 - uStagger, 0.001), 0.0, 1.0);
  return e*e*e*(e*(e*6.0 - 15.0) + 10.0);
}
vec2 homeAt(vec4 hm, vec4 rib, out float alpha, out float e, out float size){
  vec4 a = shapeAt(uKindA, uA0, uA1, hm.xy, rib);
  vec4 b = shapeAt(uKindB, uB0, uB1, hm.xy, rib);
  // Short, overlapping journeys along the ribbon: each grain fades before wrapping back to its start.
  // Keeping the journeys local preserves the photographed strands and the crossing's two directions.
  float phase = fract(hm.z + uTime*0.28);
  vec2 drift = vec2(cos(rib.w), sin(rib.w))*(phase - 0.5)*0.06*uCirculate;
  if(uKindA == 0) a.xy += drift*uA0.z;
  if(uKindB == 0) b.xy += drift*uB0.z;
  if(uStream > 0.5){
    // One after another the grains pour through a single twisting thread. A frame unwinds into it: its grains slide
    // round the outline to the middle of its bottom, so the frame shortens from the top until the last grain leaves,
    // and a frame being filled is wound on from the middle of its top, down both sides, each grain stopping at its
    // place. A picture gathers to the way out, or spreads from the way in, directly.
    const float SPAN = 0.22;
    float nA = tighten(rib.y), nB = nA, lA = 0.0, qA = 0.0, lB = 0.0, qB = 0.0;
    bool fA = uKindA == 1 && hash(hm.xy*vec2(613.7, 287.3)) >= uA1.w;
    bool fB = uKindB == 1 && hash(hm.xy*vec2(613.7, 287.3)) >= uB1.w;
    if(fA) frameLine(hm.xy, rib, lA, qA, nA);
    if(fB) frameLine(hm.xy, rib, lB, qB, nB);
    // how far round from the way out (0) this grain sits, and so when it leaves
    float order = fA ? (mod(qA, 2.0) > 0.5 ? lA*0.5 : 1.0 - lA*0.5) : clamp(fract(rib.x/(2.0*PI) + 0.25)*0.97 + hm.z*0.03, 0.0, 1.0);
    float t0 = order*(1.0 - SPAN), t1 = t0 + SPAN;
    vec2 g1 = fA ? frameAt(uA0, uA1, 0.0, 1.0, 0.0) : uStreamEnds.xy;
    vec2 g2 = fB ? frameAt(uB0, uB1, 0.0, 0.0, 0.0) : uStreamEnds.zw;
    float ks = fA ? 0.0 : 0.18, ke = fB ? 1.0 : 0.82;
    float k = clamp((uMix - t0)/SPAN, 0.0, 1.0);
    e = k;
    vec2 p;
    if(uMix <= t0 && fA){ float d = 1.0 - order*(1.0 - uMix/max(t0, 0.0001)); p = frameFromTop(uA0, uA1, d, qA < 1.5, nA*(1.0 - uMix/max(t0, 0.0001))); }
    else if(uMix >= t1 && fB){
      float there = mod(qB, 2.0) < 0.5 ? lB*0.5 : 1.0 - lB*0.5;
      float f = clamp((uMix - t1)/max(1.0 - t1, 0.0001), 0.0, 1.0);
      p = frameFromTop(uB0, uB1, there*f, qB < 1.5, nB*f);
    }
    else if(k < ks){ p = mix(a.xy, g1, smoothstep(0.0, ks, k)); }
    else if(k > ke){ p = mix(g2, b.xy, smoothstep(ke, 1.0, k)); }
    else {
      float u = (k - ks)/(ke - ks);
      vec2 d = g2 - g1;
      float len = max(length(d), 1.0);
      vec2 dir = d/len, nrm = vec2(-dir.y, dir.x);
      // the thread's spine: an S that swings out and back, more for a long fall, with a smaller wobble on top, and on
      // the way one loop over, so even a short drop tumbles
      float swing = uStreamSwing > 0.0 ? uStreamSwing : min(len*0.18, 140.0);
      float loop = clamp(len*0.22, 50.0, 110.0)*sin(u*PI);
      float a2 = u*2.0*PI;
      vec2 spine = g1 + d*u + nrm*(sin(a2)*swing + sin(u*5.0*PI + 1.3)*swing*0.18 + sin(a2)*loop) + dir*(cos(a2) - 1.0)*loop*0.6;
      // across it the grains lie as a ribbon that keeps turning over as it falls: edge-on it narrows to a line, then
      // opens again, the near edge drawn a little larger than the far one
      float across = hm.z*2.0 - 1.0;
      float roll = u*7.0*PI + 0.6;
      float width = uStreamWidth*sin(u*PI);
      p = spine + nrm*across*width*cos(roll) + dir*across*width*0.25*sin(roll);
      size = 0.9 + 0.3*across*sin(roll);
    }
    alpha = mix(a.z, b.z, k);
    if(uMix <= t0 || uMix >= t1 || k < ks || k > ke) size = mix(a.w, b.w, k);
    return p;
  }
  e = travel(rib.x, hm.z);
  vec2 p = mix(a.xy, b.xy, e);
  // on the way the material billows, like liquid poured from one mould into the next
  float w = sin(PI*e)*uSwirl;
  if(w > 0.01){
    vec2 q = mix(a.xy, b.xy, 0.5)*0.0035;
    p += (vec2(vnoise(q), vnoise(q + 17.3)) - 0.5)*w*2.0 + (vec2(hash(hm.xy*91.0), hash(hm.yx*57.0)) - 0.5)*w*0.12;
  }
  alpha = mix(a.z, b.z, e);
  size = mix(a.w, b.w, e);
  return p;
}
`

const QUAD_VS = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main(){ vUv = aPos*0.5+0.5; gl_Position = vec4(aPos,0.0,1.0); }
`

/* Flow map (cursor wake). RGBA8: velocity encoded around 128, energy in B. */
const FLOW_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uPrev;
uniform vec2 uTexel;
uniform vec2 uMouse;
uniform vec2 uVel;
uniform vec2 uSize;
uniform float uRadius;
uniform float uPresence;
uniform float uDecay;
vec2 decV(vec4 c){ return (c.rg*255.0-128.0)/127.0; }
void main(){
  vec2 v0 = decV(texture(uPrev, vUv));
  vec2 uv = vUv - v0*uTexel*2.5;
  vec4 c = texture(uPrev, uv)*0.52
    + 0.12*(texture(uPrev, uv+vec2(uTexel.x,0.0)) + texture(uPrev, uv-vec2(uTexel.x,0.0))
          + texture(uPrev, uv+vec2(0.0,uTexel.y)) + texture(uPrev, uv-vec2(0.0,uTexel.y)));
  vec2 v = decV(c);
  float p = c.b;
  vec2 d = (vUv-uMouse)*uSize;
  float f = exp(-dot(d,d)/(uRadius*uRadius))*uPresence;
  float sp = clamp(length(uVel)*2.5, 0.0, 1.0);
  v += uVel*f*0.22;
  p = max(p, f*sp);
  v *= uDecay;
  p *= uDecay;
  v = sign(v)*max(abs(v)-1.2/127.0, 0.0);
  p = max(p-1.2/255.0, 0.0);
  v = clamp(v, -1.0, 1.0);
  o = vec4((v*127.0+128.0)/255.0, p, 1.0);
}
`

/* GPGPU step: state = (offset.xy, velocity.xy) in CSS px, around the grain's place in the current shape. */
const SIM_FS = `#version 300 es
precision highp float;
out vec4 o;
uniform sampler2D uState;
uniform sampler2D uHome;
uniform sampler2D uFlow;
uniform vec2 uRes;
uniform vec2 uMouse;
uniform float uRadius;
uniform float uPresence;
uniform float uStrength;
uniform float uSpread;
uniform float uTurb;
uniform float uReturn;
uniform float uTime;
uniform float uDt;
uniform float uIntro;
${NOISE}
${SHAPES}
vec2 curl(vec2 p){
  const float e = 0.35;
  float a = vnoise(p+vec2(0.0,e)) - vnoise(p-vec2(0.0,e));
  float b = vnoise(p+vec2(e,0.0)) - vnoise(p-vec2(e,0.0));
  return vec2(a, -b)/(2.0*e);
}
void main(){
  ivec2 ij = ivec2(gl_FragCoord.xy);
  vec4 hm = texelFetch(uHome, ij, 0);
  if(hm.w <= 0.0){ o = vec4(0.0); return; }
  vec4 st = texelFetch(uState, ij, 0);
  vec2 off = st.xy;
  vec2 vel = st.zw;
  float sd = hm.z;
  float light = 0.45 + sd*1.1;

  float shown, moved, grain;
  vec2 p = homeAt(hm, texelFetch(uRib, ij, 0), shown, moved, grain) + off;
  vec4 fl = texture(uFlow, clamp(p/uRes, 0.0, 1.0));
  vec2 wake = (fl.rg*255.0-128.0)/127.0;
  float pr = fl.b;

  vec2 toM = p - uMouse;
  float r2 = dot(toM,toM);
  float f = exp(-r2/(uRadius*uRadius))*uPresence;
  vec2 n = toM*inversesqrt(r2+1.0);
  float e = clamp(pr*2.0 + f, 0.0, 1.0);

  vec2 acc = vec2(0.0);
  // blown outward and swirled around the cursor
  acc += n*f*1.25*uStrength*uSpread*light;
  acc += vec2(-n.y, n.x)*f*1.45*uStrength*uSpread*(0.4+sd);
  // carried by the liquid wake
  acc += (wake*42.0*uSpread*light - vel)*e*0.08;
  // curl-noise turbulence where the material is disturbed (and during the intro)
  vec2 q = p*0.0095 + vec2(uTime*0.35, -uTime*0.2);
  vec2 c = curl(q) + 0.5*curl(q*2.3 + 7.1);
  acc += c*(e*1.2*uSpread + uIntro*1.5)*uTurb*light;
  // elastic return home
  float k = (0.006 + 0.02*uReturn)*(0.65+sd*0.7)*(1.0 - uIntro*0.75);
  acc -= off*k;

  vel += acc*uDt;
  vel *= pow(mix(0.93, 0.955, e), uDt);
  off += vel*uDt;
  if(dot(off,off) < 0.0004 && dot(vel,vel) < 0.0004){ off = vec2(0.0); vel = vec2(0.0); }
  o = vec4(off, vel);
}
`

/* Particles: one instanced quad per particle, a capsule stretched along velocity. */
const PART_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aCorner;
uniform sampler2D uState;
uniform sampler2D uHome;
uniform sampler2D uCol;
uniform sampler2D uFlow;
uniform int uTexW;
uniform vec2 uRes;
uniform vec2 uMouse;
uniform float uRadius;
uniform float uPresence;
uniform float uDotA;
uniform float uDotB;
uniform float uTime;
uniform float uAmbient;
uniform float uStreak;
uniform float uIntroVis;
uniform float uRest;
uniform float uMorphVis;
uniform float uAlpha;
uniform vec3 uTint;
out vec2 vLocal;
out float vHalfLen;
out float vR;
out vec3 vCol;
out float vA;
${NOISE}
${ENERGY}
${SHAPES}
void main(){
  int id = gl_InstanceID;
  ivec2 ij = ivec2(id % uTexW, id / uTexW);
  vec4 hm = texelFetch(uHome, ij, 0);
  vec4 st = texelFetch(uState, ij, 0);
  vec4 cl = texelFetch(uCol, ij, 0);
  float shown, moved, grain;
  vec2 home = homeAt(hm, texelFetch(uRib, ij, 0), shown, moved, grain);

  float wakeE = texture(uFlow, clamp(home/uRes, 0.0, 1.0)).b;
  float E = energyAt(home, uMouse, uRadius, uPresence, wakeE);
  float lift = smoothstep(0.35, 2.5, length(st.xy));
  // between two shapes (uMorphVis) every grain is drawn; in the picture only the disturbed ones
  float a = max(max(E, lift), max(max(uRest, 1.0-uIntroVis), uMorphVis))*shown*uAlpha;
  float phase = fract(hm.z + uTime*0.28);
  a *= mix(1.0, smoothstep(0.0, 0.15, phase)*(1.0 - smoothstep(0.85, 1.0, phase)), min(uCirculate, 1.0));
  if(a < 0.01 || hm.w <= 0.0){ gl_Position = vec4(2.0,2.0,2.0,1.0); return; }

  vec2 base = home + st.xy;
  base -= ambientField(hm.xy, uTime)*10.0*uAmbient;

  vec2 v = st.zw;
  float sp = length(v);
  vec2 dir = sp > 0.001 ? v/sp : vec2(1.0,0.0);
  float r = mix(uDotA, uDotB, moved)*hm.w*0.5*grain;
  float len = min(sp*1.25, 18.0)*uStreak;
  vec2 lc = aCorner*vec2(r + len*0.5 + 1.0, r + 1.0);
  vec2 center = base - dir*len*0.5;
  vec2 world = center + dir*lc.x + vec2(-dir.y, dir.x)*lc.y;

  vec2 clip = world/uRes*2.0-1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  vLocal = lc;
  vHalfLen = len*0.5;
  vR = r;
  vec3 col = cl.rgb*uTint;
  // fast material catches the light, like liquid metal
  float glint = smoothstep(2.0, 16.0, sp);
  col = mix(col, min(col*1.18 + vec3(0.07,0.075,0.085), vec3(1.0)), glint*0.75);
  vCol = col;
  vA = a;
}
`

const PART_FS = `#version 300 es
precision highp float;
in vec2 vLocal;
in float vHalfLen;
in float vR;
in vec3 vCol;
in float vA;
uniform float uDpr;
out vec4 o;
void main(){
  vec2 q = vec2(max(abs(vLocal.x)-vHalfLen, 0.0), vLocal.y);
  float d = length(q) - vR;
  float a = clamp(0.5 - d*uDpr, 0.0, 1.0);
  // comet tail: the trailing end thins out
  float tail = vHalfLen > 0.0 ? clamp(0.5 - vLocal.x/(2.0*(vHalfLen+vR)), 0.0, 1.0) : 0.0;
  a *= 1.0 - tail*0.55;
  a *= vA;
  if(a < 0.004) discard;
  o = vec4(vCol*a, a);
}
`

/* Image pass: the crisp sculpture, gently lensed, fading out where the
   material has turned liquid. */
const IMAGE_FS = `#version 300 es
precision highp float;
out vec4 o;
uniform sampler2D uImg;
uniform sampler2D uFlow;
uniform vec2 uRes;
uniform float uDpr;
uniform vec4 uRect;
uniform vec3 uBg;
uniform vec3 uImgBg;
uniform vec2 uMouse;
uniform float uPresence;
uniform float uRadius;
uniform float uStrength;
uniform float uTime;
uniform float uAmbient;
uniform float uIntroVis;
uniform float uRest;
uniform float uAlphaMode;
uniform float uShow;
uniform float uAlpha;
${NOISE}
${ENERGY}
void main(){
  // the picture shows only while the sculpture is in its own shape
  if(uShow <= 0.0){ o = vec4(0.0); return; }
  vec2 px = vec2(gl_FragCoord.x, uRes.y*uDpr - gl_FragCoord.y)/uDpr;
  vec2 size = uRect.zw;
  vec2 uv = (px-uRect.xy)/size;
  if(uv.x < -0.05 || uv.x > 1.05 || uv.y < -0.12 || uv.y > 1.12){ o = vec4(0.0); return; }
  vec4 fl = texture(uFlow, clamp(px/uRes,0.0,1.0));
  vec2 vel = (fl.rg*255.0-128.0)/127.0;
  vec2 rp = px;
  vec2 toM = rp - uMouse;
  float fall = exp(-dot(toM,toM)/(uRadius*uRadius))*uPresence;
  vec2 disp = -toM*0.22*uStrength*fall - vel*10.0*uStrength;
  disp += ambientField(uv, uTime)*10.0*uAmbient;
  vec2 suv = uv + disp/size;
  vec4 tx = texture(uImg, suv);
  vec3 col = tx.rgb;
  vec2 e = smoothstep(vec2(0.0), vec2(0.004,0.01), suv) * smoothstep(vec2(1.0), vec2(0.996,0.99), suv);
  // cut-out images carry their own alpha; flat-background images are keyed by colour
  float key = uAlphaMode > 0.5 ? tx.a : smoothstep(0.012, 0.05, length(col-uImgBg));
  float k = key*e.x*e.y;
  float E = energyAt(rp, uMouse, uRadius, uPresence, fl.b);
  float show = (1.0 - max(E, uRest))*uIntroVis*uShow;
  vec3 mat = uAlphaMode > 0.5 ? col : col*(uBg/max(uImgBg, vec3(0.001)));
  // premultiplied: empty areas stay transparent so the page (and the backdrop word) shows through
  float A = k*show*uAlpha;
  o = vec4(mat*A, A);
}
`

/* ── helpers ─────────────────────────────────────────────────────────── */

type Prog = { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> }

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): Prog {
  const make = (type: number, src: string) => {
    const sh = gl.createShader(type)!
    gl.shaderSource(sh, src)
    gl.compileShader(sh)
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh)
      gl.deleteShader(sh)
      throw new Error("Shader: " + log)
    }
    return sh
  }
  const p = gl.createProgram()!
  const v = make(gl.VERTEX_SHADER, vs)
  const f = make(gl.FRAGMENT_SHADER, fs)
  gl.attachShader(p, v)
  gl.attachShader(p, f)
  gl.bindAttribLocation(p, 0, "aPos")
  gl.linkProgram(p)
  gl.deleteShader(v)
  gl.deleteShader(f)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("Link: " + gl.getProgramInfoLog(p))
  const u: Record<string, WebGLUniformLocation | null> = {}
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS)
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i)
    if (info) u[info.name] = gl.getUniformLocation(p, info.name)
  }
  return { p, u }
}

/* ── engine ──────────────────────────────────────────────────────────── */

const TEX_W = 1024
const SETTLE_FRAMES = 270

/** Where every grain sits along the sculpture's centre line, 4 floats each: t, its offset in half widths of the ribbon,
 *  its size in bent shapes, and the image-space tangent angle. Bigger grains fill sparse stretches of bent shapes. */
function ribbonCoords(home: Float32Array, n: number, size: number, iw: number, ih: number, ribbon: SculptureRibbon) {
  const out = new Float32Array(size * 4)
  const M = 1024
  const cx = new Float32Array(M), cy = new Float32Array(M), nx = new Float32Array(M), ny = new Float32Array(M)
  const hw = new Float32Array(M)
  for (let j = 0; j < M; j++) {
    const t = (j / M) * Math.PI * 2
    const [x, y] = ribbon.at(t)
    const [x1, y1] = ribbon.at(t + 1e-3)
    const [x0, y0] = ribbon.at(t - 1e-3)
    const l = Math.hypot(x1 - x0, y1 - y0) || 1
    cx[j] = x
    cy[j] = y
    nx[j] = -(y1 - y0) / l
    ny[j] = (x1 - x0) / l
    hw[j] = Math.max(1, ribbon.halfWidth(t))
  }
  // the nearest sample for a coarse grid of cells, then a local search around it for each grain
  const G = 24, gx = Math.ceil(iw / G), gy = Math.ceil(ih / G)
  const cell = new Int32Array(gx * gy)
  for (let b = 0; b < gy; b++)
    for (let a = 0; a < gx; a++) {
      const px = (a + 0.5) * G, py = (b + 0.5) * G
      let best = 0, bd = Infinity
      for (let j = 0; j < M; j++) {
        const d = (cx[j] - px) ** 2 + (cy[j] - py) ** 2
        if (d < bd) { bd = d; best = j }
      }
      cell[b * gx + a] = best
    }
  const nearest = (px: number, py: number, around: number) => {
    let best = around, bd = Infinity
    for (let k = -64; k <= 64; k++) {
      const j = (around + k + M) % M
      const d = (cx[j] - px) ** 2 + (cy[j] - py) ** 2
      if (d < bd) { bd = d; best = j }
    }
    return [best, Math.sqrt(bd)] as const
  }
  const B = 360
  const bin = new Int16Array(n)
  const spread: number[][] = Array.from({ length: B }, () => [])
  for (let i = 0; i < n; i++) {
    const px = home[i * 4] * iw, py = home[i * 4 + 1] * ih
    const j0 = cell[Math.min(gy - 1, Math.floor(py / G)) * gx + Math.min(gx - 1, Math.floor(px / G))]
    const [near, nd] = nearest(px, py, j0)
    // where the line crosses itself a grain lies on both passes: the nearer one would pull every grain there towards
    // its middle, so half of them (by their random value) go to the other pass
    const [alt, ad] = nearest(px, py, (j0 + M / 2) % M)
    const best = nd < hw[near] && ad < hw[alt] && home[i * 4 + 2] < 0.5 ? alt : near
    // between samples: project onto the segment the grain lies along, so t runs smoothly and shapes show no combing
    const qx = px - cx[best], qy = py - cy[best]
    const jn = (best + 1) % M, jp = (best - 1 + M) % M
    const ex = cx[jn] - cx[best], ey = cy[jn] - cy[best]
    let f = (qx * ex + qy * ey) / (ex * ex + ey * ey || 1)
    if (f < 0) {
      const fx = cx[jp] - cx[best], fy = cy[jp] - cy[best]
      f = -Math.min(1, Math.max(0, (qx * fx + qy * fy) / (fx * fx + fy * fy || 1)))
    } else f = Math.min(1, f)
    const u = ((best + f + M) % M) / M
    const off = qx * nx[best] + qy * ny[best]
    bin[i] = Math.min(B - 1, Math.floor(u * B))
    if (Math.abs(off) < 2 * hw[best]) spread[bin[i]].push(Math.abs(off))
    out[i * 4] = u * Math.PI * 2
    out[i * 4 + 1] = off
    out[i * 4 + 3] = Math.atan2(-nx[best], ny[best])
  }
  // The ribbon as drawn twists and frays, so its real width changes along the line: measure it (the offsets' 85th
  // percentile, for an even spread across the width) and give offsets in that width, so the bent shapes come out as
  // an even band. Stretches with fewer grains than their neighbours get bigger grains to close the gap.
  const around = (values: number[], b: number, reach: number) =>
    Array.from({ length: 2 * reach + 1 }, (_, k) => values[(b + k - reach + B) % B])
  const raw = spread.map((list, b) => {
    if (list.length < 12) return hw[Math.floor((b / B) * M)]
    list.sort((a, c) => a - c)
    return Math.max(1, list[Math.floor(list.length * 0.85)] / 0.85)
  })
  const width = raw.map((_, b) => around(raw, b, 1).reduce((a, c) => a + c) / 3)
  const counts = spread.map((list) => list.length)
  const grain = counts.map((c, b) => {
    const usual = around(counts, b, 8).sort((a, d) => a - d)[8]
    return clamp(Math.sqrt(usual / Math.max(1, c)), 1, 1.8)
  })
  for (let i = 0; i < n; i++) {
    out[i * 4 + 1] /= width[bin[i]]
    out[i * 4 + 2] = grain[bin[i]]
  }
  return out
}

/** The window's frame lays each quarter of the centre line (an arc of the ∞, crossing to tip) out evenly by
 *  count. How far along its quarter a grain lies follows from its t alone, so this table over that reach (0 at the
 *  crossing, 1 at the tip) holds the share of the quarter's grains that lie before, one channel per quarter, at REACH
 *  points. */
function reachTable(rib: Float32Array, n: number) {
  const table = new Float32Array(TEX_W * 4)
  const quarters: number[][] = [[], [], [], []]
  const quarterTurn = Math.PI / 2
  for (let i = 0; i < n; i++) {
    const v = ((rib[i * 4] + quarterTurn) % (Math.PI * 2)) - quarterTurn
    const q = v < 0 ? 0 : v < quarterTurn ? 1 : v < Math.PI ? 2 : 3
    quarters[q].push(q === 0 ? v / quarterTurn + 1 : q === 1 ? 1 - v / quarterTurn : q === 2 ? v / quarterTurn - 1 : 3 - v / quarterTurn)
  }
  quarters.forEach((reach, q) => {
    reach.sort((a, b) => a - b)
    for (let k = 0, before = 0; k < REACH; k++) {
      while (before < reach.length && reach[before] < k / (REACH - 1)) before++
      table[k * 4 + q] = reach.length ? before / reach.length : k / (REACH - 1)
    }
  })
  return table
}

const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

/** The particle engine, also driven on its own: a canvas, a picture (an image or a canvas drawn for it) and the pointer. */
export class LiquidEngine {
  lastImage: Picture | null = null
  /** Called once, after the first frame has actually been drawn. */
  onFirstFrame: (() => void) | null = null
  /** The shape to draw, asked every frame (dt in 60 fps frames). Without it the picture stays at `rect`. */
  morph: ((dt: number) => SculptureMorph) | null = null
  /** The sculpture's centre line, for the bent shapes. */
  ribbon: SculptureRibbon | null = null

  private canvas: HTMLCanvasElement
  private gl: WebGL2RenderingContext
  private opts: EngineOptions
  private onFail: () => void
  private lowPower = false
  private stateFormat: { internal: number; type: number } = { internal: 0, type: 0 }

  private pFlow!: Prog
  private pSim!: Prog
  private pPart!: Prog
  private pImg!: Prog
  private vao!: WebGLVertexArrayObject
  private quad!: WebGLBuffer

  private imgTex: WebGLTexture | null = null
  private flowTex: WebGLTexture[] = []
  private flowFb: WebGLFramebuffer[] = []
  private flowW = 256
  private flowH = 104
  private flowIdx = 0
  private flowDirty = false

  private homeTex: WebGLTexture | null = null
  private colTex: WebGLTexture | null = null
  private ribTex: WebGLTexture | null = null
  private shape: SculptureMorph | null = null
  private pieceBox = new Float32Array(MAX_PIECES * 4)
  private pieceAt = new Float32Array(MAX_PIECES * 2)
  private stateTex: WebGLTexture[] = []
  private stateFb: WebGLFramebuffer[] = []
  private stateIdx = 0
  private texH = 1
  private n = 0
  private gridW = 1
  private stateDirty = false
  private alphaMode = false
  private imgBg: [number, number, number] = [0.918, 0.914, 0.906]
  private flowing = 0
  private away = false

  private aspect = 2.5
  private rect: Rect = { x: 0, y: 0, w: 1, h: 1 }
  private cssW = 1
  private cssH = 1

  private target = { x: -9999, y: -9999 }
  private mouse = { x: -9999, y: -9999 }
  private prevMouse = { x: -9999, y: -9999 }
  private mvel = { x: 0, y: 0 }
  private presence = 0
  private presenceTarget = 0
  private burst = 0
  private lastInput = -1e9
  private settle = 1e9
  private touchRelease = 0

  private time = 0
  private introT = 1
  private raf = 0
  private running = false
  private last = 0
  private skip = 0
  private visible = true
  private ready = false
  private destroyed = false
  private lost = false

  constructor(canvas: HTMLCanvasElement, opts: EngineOptions, onFail: () => void) {
    this.canvas = canvas
    this.opts = opts
    this.onFail = onFail
    // alpha: an unpresented canvas stays transparent, so the static image under it shows
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
    }) as WebGL2RenderingContext | null
    if (!gl) throw new Error("WebGL2 unavailable")
    this.gl = gl
    const nav = navigator as Navigator & { deviceMemory?: number }
    this.lowPower =
      (nav.hardwareConcurrency || 8) <= 4 ||
      (nav.deviceMemory || 8) <= 4 ||
      window.matchMedia("(pointer: coarse)").matches
    this.initGL()
    canvas.addEventListener("webglcontextlost", this.onLost, false)
  }

  private onLost = (e: Event) => {
    e.preventDefault()
    this.lost = true
    this.stop()
    this.onFail()
  }

  private initGL() {
    const gl = this.gl
    // float render targets: RGBA16F is enough (offsets in px, sub-pixel precision)
    const full = gl.getExtension("EXT_color_buffer_float")
    const half = full ? null : gl.getExtension("EXT_color_buffer_half_float")
    if (!full && !half) throw new Error("No float render targets")
    this.stateFormat = { internal: gl.RGBA16F, type: gl.HALF_FLOAT }

    this.pFlow = compile(gl, QUAD_VS, FLOW_FS)
    this.pSim = compile(gl, QUAD_VS, SIM_FS)
    this.pPart = compile(gl, PART_VS, PART_FS)
    this.pImg = compile(gl, QUAD_VS, IMAGE_FS)

    this.vao = gl.createVertexArray()!
    gl.bindVertexArray(this.vao)
    this.quad = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

    for (let i = 0; i < 2; i++) {
      const t = this.makeTex(gl.RGBA8, this.flowW, this.flowH, gl.RGBA, gl.UNSIGNED_BYTE, null, gl.LINEAR)
      const fb = gl.createFramebuffer()!
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0)
      this.flowTex.push(t)
      this.flowFb.push(fb)
    }
    this.clearFlow()
  }

  private makeTex(
    internal: number,
    w: number,
    h: number,
    format: number,
    type: number,
    data: ArrayBufferView | null,
    filter: number
  ) {
    const gl = this.gl
    const t = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return t
  }

  private clearFlow() {
    const gl = this.gl
    for (const fb of this.flowFb) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
      gl.viewport(0, 0, this.flowW, this.flowH)
      gl.clearColor(128 / 255, 128 / 255, 0, 1)
      gl.clear(gl.COLOR_BUFFER_BIT)
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    this.flowDirty = false
  }

  private clearState() {
    const gl = this.gl
    for (const fb of this.stateFb) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
      gl.viewport(0, 0, TEX_W, this.texH)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    this.stateDirty = false
  }

  setImage(img: Picture) {
    if (this.destroyed || this.lost) return
    const gl = this.gl
    this.lastImage = img
    this.aspect = pictureWidth(img) / pictureHeight(img) || 2.5
    this.clearFlow()
    if (this.imgTex) gl.deleteTexture(this.imgTex)
    this.imgTex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.imgTex)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img)
    gl.generateMipmap(gl.TEXTURE_2D)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    this.buildParticles(img)
    this.ready = true
    if (this.opts.intro && !this.opts.reducedMotion) this.startIntro()
    this.wake()
  }

  /** One particle per material pixel of a grid laid over the image. */
  private buildParticles(img: Picture) {
    const gl = this.gl
    const baseGrid = this.lowPower ? 640 : 1000
    const gw = Math.round(baseGrid * Math.sqrt(clamp(this.opts.density, 0.15, 2)))
    const gh = Math.max(1, Math.round(gw / this.aspect))
    this.gridW = gw
    let data: Uint8ClampedArray
    try {
      const c = document.createElement("canvas")
      c.width = gw
      c.height = gh
      const ctx = c.getContext("2d", { willReadFrequently: true })!
      ctx.imageSmoothingQuality = "high"
      ctx.drawImage(img, 0, 0, gw, gh)
      data = ctx.getImageData(0, 0, gw, gh).data
    } catch {
      throw new Error("Image is not CORS-readable")
    }
    // a cut-out (transparent) image is sampled by alpha, a flat one by colour distance
    let transparent = 0
    for (let i = 3; i < data.length; i += 4 * 7) if (data[i] < 250) transparent++
    this.alphaMode = transparent > data.length / (4 * 7) / 20
    if (this.opts.imgBg) this.imgBg = this.opts.imgBg
    else if (!this.alphaMode) {
      // flat background: average the four corners
      let r = 0, g = 0, b = 0, n = 0
      const pw = Math.max(2, Math.round(gw * 0.012))
      for (const [cx, cy] of [[0, 0], [gw - pw, 0], [0, gh - pw], [gw - pw, gh - pw]]) {
        for (let y = cy; y < cy + pw; y++)
          for (let x = cx; x < cx + pw; x++) {
            const i = (y * gw + x) * 4
            r += data[i]; g += data[i + 1]; b += data[i + 2]; n++
          }
      }
      this.imgBg = [r / n / 255, g / n / 255, b / n / 255]
    }
    const home: number[] = []
    const col: number[] = []
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const i = (y * gw + x) * 4
        const r = data[i] / 255
        const g = data[i + 1] / 255
        const b = data[i + 2] / 255
        if (this.alphaMode) {
          const a = data[i + 3] / 255
          if (a < 0.12) continue
          if (a < 0.5 && Math.random() > a * 2) continue
        } else {
          const dev = Math.hypot(r - this.imgBg[0], g - this.imgBg[1], b - this.imgBg[2])
          if (dev < 0.03) continue
          if (dev < 0.07 && Math.random() > (dev - 0.03) / 0.04) continue
        }
        const jx = (Math.random() - 0.5) * 0.6
        const jy = (Math.random() - 0.5) * 0.6
        home.push((x + 0.5 + jx) / gw, (y + 0.5 + jy) / gh, Math.random(), 0.85 + Math.random() * 0.3)
        col.push(data[i], data[i + 1], data[i + 2], 255)
      }
    }
    const n = home.length / 4
    this.n = n
    this.texH = Math.max(1, Math.ceil(n / TEX_W))
    const total = TEX_W * this.texH
    const homeArr = new Float32Array(total * 4)
    homeArr.set(home)
    const colArr = new Uint8Array(total * 4)
    colArr.set(col)
    // one row more than the grains take: the reach table for the window's frame
    const ribArr = new Float32Array((total + TEX_W) * 4)
    if (this.ribbon) {
      ribArr.set(ribbonCoords(homeArr, n, total, pictureWidth(img), pictureHeight(img), this.ribbon))
      ribArr.set(reachTable(ribArr, n), total * 4)
    }

    for (const t of [this.homeTex, this.colTex, this.ribTex, ...this.stateTex]) if (t) gl.deleteTexture(t)
    for (const f of this.stateFb) gl.deleteFramebuffer(f)
    this.stateTex = []
    this.stateFb = []
    this.homeTex = this.makeTex(gl.RGBA32F, TEX_W, this.texH, gl.RGBA, gl.FLOAT, homeArr, gl.NEAREST)
    this.colTex = this.makeTex(gl.RGBA8, TEX_W, this.texH, gl.RGBA, gl.UNSIGNED_BYTE, colArr, gl.NEAREST)
    this.ribTex = this.makeTex(gl.RGBA32F, TEX_W, this.texH + 1, gl.RGBA, gl.FLOAT, ribArr, gl.NEAREST)
    for (let i = 0; i < 2; i++) {
      const t = this.makeTex(this.stateFormat.internal, TEX_W, this.texH, gl.RGBA, this.stateFormat.type, null, gl.NEAREST)
      const fb = gl.createFramebuffer()!
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0)
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("Float FBO incomplete")
      this.stateTex.push(t)
      this.stateFb.push(fb)
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    this.homeData = homeArr
    this.clearState()
  }

  private homeData: Float32Array | null = null

  private startIntro() {
    const gl = this.gl
    const home = this.homeData
    if (!home) return
    const w = this.rect.w > 10 ? this.rect.w : 1300
    const total = TEX_W * this.texH
    const st = new Float32Array(total * 4)
    for (let i = 0; i < this.n; i++) {
      const hx = home[i * 4] - 0.5
      const hy = home[i * 4 + 1] - 0.5
      const sd = home[i * 4 + 2]
      const ang = (Math.random() - 0.5) * 0.9 + (hx > 0 ? 0 : Math.PI)
      const dist = w * (0.04 + Math.random() * 0.14) * (0.5 + Math.abs(hx) * 1.4)
      st[i * 4] = Math.cos(ang) * dist + hx * w * 0.25 * sd
      st[i * 4 + 1] = Math.sin(ang) * dist * 0.55 + hy * 120 * (Math.random() - 0.5)
    }
    gl.bindTexture(gl.TEXTURE_2D, this.stateTex[this.stateIdx])
    gl.texImage2D(gl.TEXTURE_2D, 0, this.stateFormat.internal, TEX_W, this.texH, 0, gl.RGBA, gl.FLOAT, st)
    this.introT = 0
    this.stateDirty = true
  }

  setOptions(o: Partial<EngineOptions>) {
    const rebuild =
      (o.density !== undefined && o.density !== this.opts.density) ||
      (o.imgBg !== undefined && String(o.imgBg) !== String(this.opts.imgBg))
    this.opts = { ...this.opts, ...o }
    if (rebuild && this.ready && this.lastImage) {
      try {
        this.buildParticles(this.lastImage)
      } catch {
        this.onFail()
      }
    }
    this.wake()
  }

  resize(cssW: number, cssH: number, rect: Rect) {
    this.cssW = Math.max(1, cssW)
    this.cssH = Math.max(1, cssH)
    this.rect = rect
    // the cursor's wake covers the whole canvas
    const flowH = Math.max(32, Math.round((this.flowW * this.cssH) / this.cssW))
    if (flowH !== this.flowH && !this.lost && !this.destroyed) {
      this.flowH = flowH
      const gl = this.gl
      for (const t of this.flowTex) {
        gl.bindTexture(gl.TEXTURE_2D, t)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.flowW, this.flowH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      }
      this.clearFlow()
    }
    let dpr = Math.min(window.devicePixelRatio || 1, this.lowPower ? 1.5 : 2, this.opts.maxDpr ?? 2)
    const px = this.cssW * this.cssH * dpr * dpr
    if (px > 4.5e6) dpr = Math.max(1, Math.sqrt(4.5e6 / (this.cssW * this.cssH)))
    const w = Math.round(this.cssW * dpr)
    const h = Math.round(this.cssH * dpr)
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
    }
    this.draw()
  }

  setVisible(v: boolean) {
    this.visible = v
    if (v) this.wake()
    else this.stop()
  }

  pointer(type: "move" | "down" | "up" | "leave", x: number, y: number, touch: boolean) {
    if (!this.opts.interactive || this.lost) return
    const now = performance.now()
    if (type === "leave" || type === "up") {
      if (touch) this.touchRelease = now + 260
      else this.presenceTarget = 0
      this.wake()
      return
    }
    if (this.mouse.x < -9000 || type === "down") {
      this.mouse.x = this.prevMouse.x = x
      this.mouse.y = this.prevMouse.y = y
    }
    this.target.x = x
    this.target.y = y
    this.presenceTarget = 1
    this.lastInput = now
    this.settle = 0
    if (type === "down") {
      this.burst = 1
      this.touchRelease = 0
    }
    this.wake()
  }

  /** The page moved: draw the sculpture where it now belongs. */
  refresh() {
    this.wake()
  }

  private readMorph(dt: number): SculptureMorph {
    const still: SculptureShape = { kind: "image", rect: this.rect }
    this.shape = this.morph?.(dt) ?? { from: still, to: still, mix: 0 }
    return this.shape
  }

  // grains are as big as the shape's own grid: the picture's, finer along a frame's line
  private dotFor(s: SculptureShape) {
    const span = s.kind === "image" ? s.rect.w : (s.rect.w + s.rect.h) * 0.9
    return (span / this.gridW) * 1.45 * clamp(this.opts.dotSize, 0.2, 3)
  }

  private shapeUniforms(P: Prog, m: SculptureMorph) {
    const gl = this.gl
    const rm = this.opts.reducedMotion
    for (const [slot, s] of [["A", m.from], ["B", m.to]] as const) {
      const p0 = [s.rect.x, s.rect.y, s.rect.w, s.rect.h]
      const p1 = s.kind === "window" ? [s.radius, s.halfWidth, s.outset, clamp(s.fill, 0, 1)] : [0, 0, 0, 0]
      gl.uniform1i(P.u["uKind" + slot], s.kind === "window" ? 1 : 0)
      gl.uniform4fv(P.u[`u${slot}0`], p0)
      gl.uniform4fv(P.u[`u${slot}1`], p1)
    }
    // one picture's pieces at a time: a drifting picture stays itself, it only ever changes into the other shapes
    const pieces = (m.from.kind === "image" && m.from.pieces) || (m.to.kind === "image" && m.to.pieces) || []
    const count = Math.min(pieces.length, MAX_PIECES)
    gl.uniform1i(P.u.uPieces, count)
    if (count) {
      for (let k = 0; k < count; k++) {
        const { box, x, y } = pieces[k]
        this.pieceBox.set([box.x, box.y, box.w, box.h], k * 4)
        this.pieceAt.set([x, y], k * 2)
      }
      gl.uniform4fv(P.u["uPieceBox[0]"], this.pieceBox)
      gl.uniform2fv(P.u["uPieceAt[0]"], this.pieceAt)
    }
    gl.uniform1f(P.u.uMix, clamp(m.mix, 0, 1))
    gl.uniform1f(P.u.uStream, m.stream ? 1 : 0)
    if (m.stream) gl.uniform4f(P.u.uStreamEnds, m.stream.out[0], m.stream.out[1], m.stream.in[0], m.stream.in[1])
    gl.uniform1f(P.u.uStreamWidth, 7 * clamp(this.cssW / 1440, 0.6, 1.4))
    gl.uniform1f(P.u.uStreamSwing, m.stream?.swing ?? 0)
    gl.uniform1f(P.u.uStagger, rm ? 0 : 0.35)
    gl.uniform1f(P.u.uSwirl, rm ? 0 : 70 * clamp(this.cssW / 1440, 0.6, 1.4))
    // Fade circulation away while the image bends into a frame; the morph itself stays intact.
    const image = Math.max(m.from.kind === "image" ? 1 - smooth(0, 0.04, m.mix) : 0, m.to.kind === "image" ? smooth(0.96, 1, m.mix) : 0)
    gl.uniform1f(P.u.uCirculate, this.ribbon && this.opts.ambient && !rm ? image * clamp(this.opts.ambientIntensity, 0, 2) : 0)
  }

  private wake() {
    if (!this.ready || this.running || !this.visible || this.destroyed || this.lost) {
      if (this.ready && !this.running) this.draw()
      return
    }
    this.running = true
    this.last = performance.now()
    this.raf = requestAnimationFrame(this.frame)
  }

  private stop() {
    this.running = false
    cancelAnimationFrame(this.raf)
  }

  private radiusPx() {
    return this.opts.radius * clamp(this.rect.w / 1400, 0.6, 1.25)
  }

  private strength() {
    return this.opts.strength * (this.opts.reducedMotion ? 0.5 : 1)
  }

  private frame = (now: number) => {
    if (!this.running) return
    const rawMs = now - this.last
    const dt = clamp(rawMs / 16.6667, 0.25, 3)
    this.last = now
    const o = this.opts
    const ambientOn = o.ambient && !o.reducedMotion

    if (this.touchRelease && now > this.touchRelease) {
      this.presenceTarget = 0
      this.touchRelease = 0
    }
    const ease = 1 - Math.pow(1 - 0.22, dt)
    this.mouse.x += (this.target.x - this.mouse.x) * ease
    this.mouse.y += (this.target.y - this.mouse.y) * ease
    const vx = (this.mouse.x - this.prevMouse.x) / dt
    const vy = (this.mouse.y - this.prevMouse.y) / dt
    this.prevMouse.x = this.mouse.x
    this.prevMouse.y = this.mouse.y
    this.mvel.x += (clamp(vx, -60, 60) - this.mvel.x) * 0.5
    this.mvel.y += (clamp(vy, -60, 60) - this.mvel.y) * 0.5
    const pk = this.presenceTarget > this.presence ? 0.1 : 0.035
    this.presence += (this.presenceTarget - this.presence) * (1 - Math.pow(1 - pk, dt))
    if (this.presence < 0.001 && this.presenceTarget === 0) this.presence = 0
    const fk = this.presenceTarget > this.flowing ? 0.05 : 0.018
    this.flowing += (this.presenceTarget - this.flowing) * (1 - Math.pow(1 - fk, dt))
    if (this.flowing < 0.002 && this.presenceTarget === 0) this.flowing = 0
    if (this.introT < 1) this.introT = Math.min(1, this.introT + Math.min(rawMs, 100) / 3200)
    const morph = this.readMorph(dt)
    // out of sight: drawn once where it now is (off the screen), then the engine rests until the page moves or the
    // pointer stirs again, each of which asks for one frame like this one
    if (morph.away) {
      if (!this.away) this.draw()
      this.away = true
      this.stop()
      return
    }
    this.away = false
    const moving = !!morph.moving

    const interacting = this.presence > 0.001 || this.burst > 0
    // settle is counted in simulated frames, so slow devices never snap mid-return
    this.settle = interacting ? 0 : this.settle + dt
    const active = interacting || moving || this.settle < SETTLE_FRAMES || this.introT < 1

    if (!active) {
      if (this.flowDirty) this.clearFlow()
      if (this.stateDirty) this.clearState()
      if (!ambientOn) {
        this.draw()
        this.firstFrame()
        this.stop()
        return
      }
      this.raf = requestAnimationFrame(this.frame)
      if (this.skip++ % 2) return
      this.time += (dt * 2 * o.speed) / 60
      this.draw()
      this.firstFrame()
      return
    }
    this.raf = requestAnimationFrame(this.frame)
    // the field speeds up while the material is being stirred
    this.time += (dt * o.speed * (1 + this.flowing * 1.6)) / 60
    this.stepFlow(dt)
    this.stepSim(dt)
    this.burst = Math.max(0, this.burst - 0.1 * dt)
    this.draw()
    this.firstFrame()
  }

  private firstFrame() {
    if (this.onFirstFrame) {
      const cb = this.onFirstFrame
      this.onFirstFrame = null
      // one more frame so the compositor has presented the canvas
      requestAnimationFrame(() => cb())
    }
  }

  private stepFlow(dt: number) {
    const gl = this.gl
    const P = this.pFlow
    const dst = 1 - this.flowIdx
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.flowFb[dst])
    gl.viewport(0, 0, this.flowW, this.flowH)
    gl.disable(gl.BLEND)
    gl.useProgram(P.p)
    gl.bindVertexArray(this.vao)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.flowTex[this.flowIdx])
    gl.uniform1i(P.u.uPrev, 0)
    gl.uniform2f(P.u.uTexel, 1 / this.flowW, 1 / this.flowH)
    gl.uniform2f(P.u.uMouse, this.mouse.x / this.cssW, this.mouse.y / this.cssH)
    gl.uniform2f(P.u.uVel, clamp(this.mvel.x / 40, -1, 1), clamp(this.mvel.y / 40, -1, 1))
    gl.uniform2f(P.u.uSize, this.cssW, this.cssH)
    gl.uniform1f(P.u.uRadius, this.radiusPx())
    gl.uniform1f(P.u.uPresence, Math.max(this.presence, this.burst))
    gl.uniform1f(P.u.uDecay, Math.pow(0.968, dt))
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    this.flowIdx = dst
    this.flowDirty = true
  }

  private stepSim(dt: number) {
    if (!this.n) return
    const gl = this.gl
    const P = this.pSim
    const o = this.opts
    const dst = 1 - this.stateIdx
    const intro = o.reducedMotion || !o.intro ? 0 : Math.pow(1 - this.introT, 2)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.stateFb[dst])
    gl.viewport(0, 0, TEX_W, this.texH)
    gl.disable(gl.BLEND)
    gl.useProgram(P.p)
    gl.bindVertexArray(this.vao)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.stateTex[this.stateIdx])
    gl.uniform1i(P.u.uState, 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.homeTex)
    gl.uniform1i(P.u.uHome, 1)
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, this.flowTex[this.flowIdx])
    gl.uniform1i(P.u.uFlow, 2)
    gl.activeTexture(gl.TEXTURE3)
    gl.bindTexture(gl.TEXTURE_2D, this.ribTex)
    gl.uniform1i(P.u.uRib, 3)
    this.shapeUniforms(P, this.shape ?? this.readMorph(0))
    gl.uniform2f(P.u.uRes, this.cssW, this.cssH)
    gl.uniform2f(P.u.uMouse, this.mouse.x, this.mouse.y)
    gl.uniform1f(P.u.uRadius, this.radiusPx())
    gl.uniform1f(P.u.uPresence, Math.max(this.presence, this.burst))
    gl.uniform1f(P.u.uStrength, this.strength() * (1 + this.burst * 1.5))
    gl.uniform1f(P.u.uSpread, clamp(o.spread, 0, 2))
    gl.uniform1f(P.u.uTurb, clamp(o.turbulence, 0, 2) * (o.reducedMotion ? 0.3 : 1))
    gl.uniform1f(P.u.uReturn, clamp(o.returnSpeed, 0, 2))
    gl.uniform1f(P.u.uTime, this.time)
    gl.uniform1f(P.u.uDt, dt)
    gl.uniform1f(P.u.uIntro, intro)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    this.stateIdx = dst
    this.stateDirty = true
  }

  private draw() {
    if (!this.ready || this.lost || this.destroyed) return
    const gl = this.gl
    const o = this.opts
    const m = this.shape ?? this.readMorph(0)
    // the crisp picture belongs to the "image" shapes only; on the way between shapes the grains carry the sculpture
    const showA = m.from.kind === "image" ? 1 - smooth(0, 0.04, m.mix) : 0
    const showB = m.to.kind === "image" ? smooth(0.96, 1, m.mix) : 0
    const pictured = showA >= showB ? m.from : m.to
    const r = pictured.kind === "image" ? pictured.rect : this.rect
    const morphVis = 1 - Math.max(showA, showB)
    const alpha = clamp(m.alpha ?? 1, 0, 1)
    const rm = o.reducedMotion
    const introVis = rm || !o.intro ? 1 : Math.pow(this.introT, 2.2)
    const base = o.ambient && !rm && !this.ribbon ? clamp(o.ambientIntensity, 0, 2) : 0
    const amb = base + this.flowing * 0.85 * clamp(o.liquid, 0, 2) * (rm ? 0.3 : 1)
    const rest = o.restStyle === "particles" ? 1 : this.ribbon && o.ambient && !rm ? 0.32 * clamp(o.ambientIntensity, 0, 1) : 0
    const [br, bg, bb] = o.bg
    const [ir, ig, ib] = this.imgBg
    const dpr = this.canvas.width / this.cssW
    const pres = Math.max(this.presence, this.burst)
    const mx = this.mouse.x
    const my = this.mouse.y

    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.bindVertexArray(this.vao)
    gl.disable(gl.BLEND)

    if (rest >= 1) {
      // the grains carry the whole picture even at rest ("particles"): the picture pass would only clear the canvas
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
    } else {
      const I = this.pImg
      gl.useProgram(I.p)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, this.imgTex)
      gl.uniform1i(I.u.uImg, 0)
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, this.flowTex[this.flowIdx])
      gl.uniform1i(I.u.uFlow, 1)
      gl.uniform2f(I.u.uRes, this.cssW, this.cssH)
      gl.uniform1f(I.u.uDpr, dpr)
      gl.uniform4f(I.u.uRect, r.x, r.y, r.w, r.h)
      gl.uniform3f(I.u.uBg, br, bg, bb)
      gl.uniform3f(I.u.uImgBg, ir, ig, ib)
      gl.uniform2f(I.u.uMouse, mx, my)
      gl.uniform1f(I.u.uPresence, pres)
      gl.uniform1f(I.u.uRadius, this.radiusPx())
      gl.uniform1f(I.u.uStrength, this.strength())
      gl.uniform1f(I.u.uTime, this.time)
      gl.uniform1f(I.u.uAmbient, amb)
      gl.uniform1f(I.u.uIntroVis, introVis)
      gl.uniform1f(I.u.uRest, rest)
      gl.uniform1f(I.u.uAlphaMode, this.alphaMode ? 1 : 0)
      gl.uniform1f(I.u.uShow, Math.max(showA, showB))
      gl.uniform1f(I.u.uAlpha, alpha)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }

    // particles are invisible at rest in "image" mode: skip them entirely
    if (!this.n || (!this.stateDirty && rest === 0 && introVis >= 1 && morphVis <= 0.001)) return

    const P = this.pPart
    gl.useProgram(P.p)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.stateTex[this.stateIdx])
    gl.uniform1i(P.u.uState, 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.homeTex)
    gl.uniform1i(P.u.uHome, 1)
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, this.colTex)
    gl.uniform1i(P.u.uCol, 2)
    gl.activeTexture(gl.TEXTURE3)
    gl.bindTexture(gl.TEXTURE_2D, this.flowTex[this.flowIdx])
    gl.uniform1i(P.u.uFlow, 3)
    gl.activeTexture(gl.TEXTURE4)
    gl.bindTexture(gl.TEXTURE_2D, this.ribTex)
    gl.uniform1i(P.u.uRib, 4)
    this.shapeUniforms(P, m)
    gl.uniform1i(P.u.uTexW, TEX_W)
    gl.uniform2f(P.u.uRes, this.cssW, this.cssH)
    gl.uniform2f(P.u.uMouse, mx, my)
    gl.uniform1f(P.u.uRadius, this.radiusPx())
    gl.uniform1f(P.u.uPresence, pres)
    gl.uniform1f(P.u.uDotA, this.dotFor(m.from))
    gl.uniform1f(P.u.uDotB, this.dotFor(m.to))
    gl.uniform1f(P.u.uMorphVis, morphVis)
    gl.uniform1f(P.u.uAlpha, alpha)
    gl.uniform1f(P.u.uTime, this.time)
    gl.uniform1f(P.u.uAmbient, amb)
    gl.uniform1f(P.u.uStreak, (o.streaks ? 1 : 0) * (0.45 + 0.55 * introVis))
    gl.uniform1f(P.u.uIntroVis, introVis)
    gl.uniform1f(P.u.uRest, rest)
    gl.uniform1f(P.u.uDpr, dpr)
    if (this.alphaMode) gl.uniform3f(P.u.uTint, 1, 1, 1)
    else gl.uniform3f(P.u.uTint, br / Math.max(ir, 0.001), bg / Math.max(ig, 0.001), bb / Math.max(ib, 0.001))
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.n)
    gl.disable(gl.BLEND)
  }

  destroy() {
    this.destroyed = true
    this.stop()
    this.canvas.removeEventListener("webglcontextlost", this.onLost)
    const gl = this.gl
    if (!this.lost) {
      gl.deleteBuffer(this.quad)
      gl.deleteVertexArray(this.vao)
      for (const t of [...this.flowTex, ...this.stateTex, this.imgTex, this.homeTex, this.colTex, this.ribTex]) if (t) gl.deleteTexture(t)
      for (const f of [...this.flowFb, ...this.stateFb]) gl.deleteFramebuffer(f)
      for (const p of [this.pFlow, this.pSim, this.pPart, this.pImg]) if (p) gl.deleteProgram(p.p)
    }
    gl.getExtension("WEBGL_lose_context")?.loseContext()
  }
}

/* ────────────────────────────────────────────────────────────────────
   Public API
   ──────────────────────────────────────────────────────────────────── */

export interface SculptureHeroLink {
  label: string
  href: string
}

export interface SculptureHeroProps {
  /** Sculpture image (light theme). Must be CORS-enabled when hosted on another domain. */
  src?: string
  /** Optional image for the dark theme. */
  darkSrc?: string
  /** Optional image for phones (portrait layouts), light and dark. */
  mobileSrc?: string
  mobileDarkSrc?: string
  imageAlt?: string
  /** Only for images without transparency: the flat background colour inside the image. */
  imageBackground?: string

  brand?: React.ReactNode
  navLinks?: SculptureHeroLink[]
  navCta?: SculptureHeroLink
  showNav?: boolean

  eyebrow?: string
  headline?: string
  /** Words of the headline to set in the italic accent face. */
  headlineAccent?: string
  body?: string
  primaryCta?: SculptureHeroLink
  secondaryCta?: SculptureHeroLink
  hint?: string
  hintTouch?: string
  /** The small line at the left end of the bottom rule. */
  tagline?: string
  /** The link at the right end of the bottom rule, down to what follows the hero. */
  scrollCue?: SculptureHeroLink

  /** Light-theme background. */
  background?: string
  /** Dark-theme background. */
  darkBackground?: string
  /** Theme on load. */
  theme?: "light" | "dark"
  /** Show the light/dark switch in the nav. */
  themeToggle?: boolean
  /** Called when the visitor flips the theme switch, so the rest of the page can follow. */
  onThemeChange?: (theme: "light" | "dark") => void
  textColor?: string
  accentColor?: string
  headingFont?: string
  accentFont?: string
  bodyFont?: string
  /** Load the default Google Fonts (Geist + Instrument Serif, both OFL). */
  loadFonts?: boolean

  /** 1 = the default size beside the copy. */
  sculptureScale?: number
  /** Offset in % of the hero width / height. */
  sculptureX?: number
  sculptureY?: number

  interactive?: boolean
  /** 0 – 2 */
  strength?: number
  /** Radius of the disturbance, in px at 1440px wide. */
  radius?: number
  /** 0 – 2, multiplies the particle count. */
  particleDensity?: number
  /** 0 – 3, size of each particle relative to the grid. */
  dotSize?: number
  /** 0 – 2, how far particles travel when disturbed. */
  particleSpread?: number
  /** 0 – 2, liquid swirl of the disturbed material. */
  turbulence?: number
  /** 0 – 2, how much the whole sculpture flows while hovered. */
  liquid?: number
  /** Stretch fast particles into liquid streaks. */
  streaks?: boolean
  /** At rest: the crisp image, or the particle field itself. */
  restStyle?: "image" | "particles"
  /** 0 – 2, how quickly the material settles back. */
  returnSpeed?: number
  ambient?: boolean
  /** 0 – 2 */
  ambientIntensity?: number
  /** 0.25 – 3 */
  speed?: number
  /** Assembly animation on load. */
  intro?: boolean

  /** Hero height. Default fills the screen exactly, no scrolling. */
  height?: string
  /** Giant faint word behind the sculpture. Empty to hide. */
  backdropText?: string
  /**
   * Keeps the canvas fixed to the viewport and asks every frame which shape to draw where, so the sculpture can follow
   * the page. `hero` is where the picture sits in the hero at that moment, `dt` the frame time in 60 fps frames.
   */
  scrollForms?: (hero: Rect, view: { w: number; h: number }, dt: number) => SculptureMorph
  /** The sculpture's centre line in the image, needed by the bent shapes. */
  ribbon?: SculptureRibbon
  showCredit?: boolean
  className?: string
  style?: React.CSSProperties
}

const DEFAULTS = {
  src: "https://cdn.21st.dev/assets/mirror/ae/ae8c3de9003460e59182e950ccd345f68f27f9d0e4808b64c92c962a4eca7120.webp",
  darkSrc: "https://cdn.21st.dev/assets/mirror/a1/a1fa387b6e417b26a25f317559c87cce4d241c1052c52a2b3bc2966b2aaf9b65.webp",
  mobileSrc: "https://cdn.21st.dev/assets/mirror/b0/b0c8d8e5d64b8cec906a3b390e3dc7c9a5af08334bf0632873c601782cb4bc46.webp",
  mobileDarkSrc: "https://cdn.21st.dev/assets/mirror/9a/9a82cb59be1bfde59855b79d7a565e487155a89f4d52eac74dcc10e267b2b6d1.webp",
  imageAlt: "Abstract sculpture of interwoven metallic filaments and particles",
  imageBackground: "#EAE9E7",
  brand: "Forma®",
  navLinks: [
    { label: "Work", href: "#" },
    { label: "Studio", href: "#" },
    { label: "Approach", href: "#" },
    { label: "Journal", href: "#" },
  ],
  navCta: { label: "Contact", href: "#" },
  eyebrow: "Independent studio — Est. 2019",
  headline: "Form that\nanswers back.",
  headlineAccent: "answers back.",
  body: "We shape products, identities and spaces with the precision of engineering and the patience of craft — work that holds up under attention.",
  primaryCta: { label: "Start a project", href: "#" },
  secondaryCta: { label: "Selected work", href: "#" },
  hint: "Move across the form",
  hintTouch: "Touch the form",
  background: "#EBE9E5",
  darkBackground: "#111110",
  textColor: "#151514",
  accentColor: "#151514",
  headingFont: "'Geist', 'Helvetica Neue', Arial, sans-serif",
  accentFont: "'Instrument Serif', 'Times New Roman', serif",
  bodyFont: "'Geist', 'Helvetica Neue', Arial, sans-serif",
}

/* ────────────────────────────────────────────────────────────────────
   Layout
   ──────────────────────────────────────────────────────────────────── */

/** The sculpture sits centred in its column beside the copy (above the copy on narrow screens), a little wider than
 *  the column: the picture's own margins and the stray grains reach past it. */
function computeRect(w: number, h: number, aspect: number, box: Rect, p: { scale: number; x: number; y: number }): Rect {
  let rw = box.w * 1.08 * p.scale
  const maxH = Math.max(80, box.h) * p.scale
  if (rw / aspect > maxH) rw = maxH * aspect
  const rh = rw / aspect
  const cx = box.x + box.w / 2 + w * (p.x / 100)
  const cy = box.y + box.h / 2 + h * (p.y / 100)
  return { x: cx - rw / 2, y: cy - rh / 2, w: rw, h: rh }
}

/* ────────────────────────────────────────────────────────────────────
   Styles
   ──────────────────────────────────────────────────────────────────── */

const CSS = `
.sh-root{position:relative;width:100%;height:var(--sh-h);overflow:hidden;isolation:isolate;container-type:size;transition:background-color .6s ease,color .6s ease;
  background:var(--sh-bg);color:var(--sh-fg);font-family:var(--sh-body);-webkit-font-smoothing:antialiased;
  touch-action:pan-y;display:flex;flex-direction:column;box-sizing:border-box}
.sh-root *,.sh-root *::before,.sh-root *::after{box-sizing:border-box}
.sh-stage{position:absolute;inset:0;z-index:0;pointer-events:none}
.sh-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;opacity:0;transition:opacity .5s ease}
.sh-fallback{position:absolute;display:block;visibility:hidden;max-width:none;user-select:none;-webkit-user-drag:none;transition:opacity .5s ease}
.sh-root[data-gl="on"] .sh-canvas{opacity:1}
.sh-root[data-gl="on"] .sh-fallback{opacity:0}
.sh-root[data-swap="1"] .sh-canvas{opacity:0;transition-duration:.25s}
.sh-root[data-swap="1"] .sh-fallback{opacity:0;transition-duration:.25s}
.sh-fixed{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden}
.sh-fixed[data-gl="on"] .sh-canvas{opacity:1}
.sh-fixed[data-swap="1"] .sh-canvas{opacity:0;transition-duration:.25s}
.sh-root.sh-follow{z-index:1;background:transparent}
.sh-backdrop{position:absolute;z-index:0;transform:translate(-50%,-50%);white-space:nowrap;pointer-events:none;user-select:none;
  font-family:var(--sh-head);font-weight:600;letter-spacing:-.06em;line-height:.8;color:color-mix(in srgb,var(--sh-fg) 5%,transparent)}
.sh-nav{position:relative;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:24px;
  padding:26px clamp(20px,3.2cqw,48px) 0}
.sh-brand{font-family:var(--sh-head);font-weight:600;font-size:17px;letter-spacing:-.02em;color:inherit;text-decoration:none}
.sh-links{display:flex;align-items:center;gap:clamp(18px,2.4cqw,36px);list-style:none;margin:0;padding:0}
.sh-link{color:inherit;text-decoration:none;font-size:13.5px;letter-spacing:-.005em;opacity:.72;transition:opacity .2s}
.sh-link:hover{opacity:1}
.sh-theme{display:inline-grid;place-items:center;width:34px;height:34px;padding:0;border-radius:50%;cursor:pointer;color:inherit;background:transparent;
  border:1px solid color-mix(in srgb,var(--sh-fg) 22%,transparent);transition:background .25s,color .25s}
.sh-theme:hover{background:var(--sh-fg);color:var(--sh-bg)}
.sh-theme:focus-visible{outline:2px solid var(--sh-fg);outline-offset:4px}
.sh-navcta{color:inherit;text-decoration:none;font-size:13.5px;padding:8px 14px;border:1px solid color-mix(in srgb,var(--sh-fg) 22%,transparent);
  border-radius:999px;transition:background .25s,color .25s}
.sh-navcta:hover{background:var(--sh-fg);color:var(--sh-bg)}
.sh-hint{position:absolute;z-index:1;transform:translate(-50%,0);display:flex;align-items:center;gap:10px;white-space:nowrap;
  font-size:11px;letter-spacing:.14em;text-transform:uppercase;opacity:.5;pointer-events:none;transition:opacity .8s ease}
.sh-hint::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;animation:sh-pulse 2.4s ease-in-out infinite}
.sh-root[data-touched="1"] .sh-hint{opacity:0}
@keyframes sh-pulse{0%,100%{transform:scale(.6);opacity:.45}50%{transform:scale(1);opacity:1}}
.sh-content{position:relative;z-index:2;flex:1 1 auto;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);
  align-items:center;gap:clamp(24px,4cqw,72px);padding:clamp(16px,3cqh,40px) clamp(20px,3.2cqw,48px)}
.sh-art{align-self:stretch}
.sh-eyebrow{font-size:12px;letter-spacing:.12em;text-transform:uppercase;opacity:.62;margin:0 0 clamp(14px,1.6cqw,22px);
  display:flex;align-items:center;gap:12px}
.sh-eyebrow::before{content:"";width:28px;height:1px;background:currentColor;opacity:.7}
.sh-h1{font-family:var(--sh-head);font-weight:500;font-size:clamp(40px,min(5cqw,9cqh),96px);line-height:.92;letter-spacing:-.045em;margin:0;
  text-wrap:balance}
.sh-h1 .sh-line{display:block}
.sh-accent{font-family:var(--sh-accent);font-style:italic;font-weight:400;letter-spacing:-.02em;color:var(--sh-acc)}
.sh-body{max-width:36em;font-size:clamp(15px,1.1cqw,17px);line-height:1.5;letter-spacing:-.01em;margin:clamp(20px,2.2cqw,32px) 0 0;opacity:.78;
  text-wrap:pretty}
.sh-ctas{display:flex;flex-wrap:wrap;align-items:center;gap:22px;margin-top:clamp(24px,2.4cqw,34px)}
.sh-btn{display:inline-flex;align-items:center;gap:10px;height:46px;padding:0 22px;border-radius:999px;background:var(--sh-fg);
  color:var(--sh-bg);text-decoration:none;font-size:14.5px;font-weight:500;letter-spacing:-.01em;transition:transform .3s cubic-bezier(.2,.7,.2,1),opacity .2s}
.sh-btn:hover{transform:translateY(-1px)}
.sh-btn svg,.sh-txt svg,.sh-scroll svg{transition:transform .3s cubic-bezier(.2,.7,.2,1)}
.sh-btn:hover svg,.sh-txt:hover svg,.sh-scroll:hover svg{transform:translateX(3px)}
.sh-txt{display:inline-flex;align-items:center;gap:8px;color:inherit;text-decoration:none;font-size:14.5px;font-weight:500;
  letter-spacing:-.01em;padding:4px 0;border-bottom:1px solid color-mix(in srgb,var(--sh-fg) 30%,transparent)}
.sh-root a:focus-visible{outline:2px solid var(--sh-fg);outline-offset:4px}
.sh-foot{position:relative;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:24px;margin:0 clamp(20px,3.2cqw,48px);
  padding:clamp(24px,8cqh,80px) 0 clamp(22px,6cqh,60px);border-top:1px solid color-mix(in srgb,var(--sh-fg) 14%,transparent);
  font-size:12px;letter-spacing:.12em;text-transform:uppercase}
.sh-tagline{opacity:.55}
.sh-scroll{display:inline-flex;align-items:center;gap:10px;margin-left:auto;color:inherit;text-decoration:none;opacity:.55;transition:opacity .2s}
.sh-scroll:hover{opacity:1}
.sh-scroll svg{rotate:90deg}
.sh-credit{position:absolute;z-index:2;right:clamp(20px,3.2cqw,48px);bottom:10px;font-size:10px;letter-spacing:.06em;
  color:inherit;opacity:.38;text-decoration:none}
.sh-credit:hover{opacity:.8}
@container (max-width:1023px){
  .sh-content{grid-template-columns:1fr;grid-template-rows:minmax(0,1fr) auto;gap:28px}
  .sh-art{order:-1}
  .sh-h1{font-size:clamp(40px,min(7.5cqw,7cqh),80px)}
}
@container (max-width:767px){
  .sh-links li:not(.sh-keep){display:none}
}
@container (max-width:639px){
  .sh-nav{padding-top:20px}
  .sh-h1{font-size:clamp(36px,min(12.5cqw,7.2cqh),60px);line-height:.94}
  .sh-body{font-size:15px;margin-bottom:20px}
  .sh-eyebrow{font-size:11px}
  .sh-ctas{gap:18px}
  .sh-btn{height:48px}
  .sh-foot{font-size:11px}
  .sh-credit{right:auto;left:50%;transform:translateX(-50%)}
}
@media (prefers-reduced-motion:reduce){
  .sh-hint::before{animation:none}
  .sh-canvas,.sh-fallback,.sh-btn,.sh-btn svg,.sh-txt svg,.sh-scroll svg{transition:none}
}
`

const Arrow = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <path d="M2 7h10M8 3l4 4-4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

/* ────────────────────────────────────────────────────────────────────
   Component
   ──────────────────────────────────────────────────────────────────── */

let fontsInjected = false
function injectFonts() {
  if (fontsInjected || typeof document === "undefined") return
  fontsInjected = true
  const id = "sh-fonts"
  if (document.getElementById(id)) return
  const l = document.createElement("link")
  l.id = id
  l.rel = "stylesheet"
  l.href =
    "https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Instrument+Serif:ital@0;1&display=swap"
  document.head.appendChild(l)
}

/** Sets (or, without a value, clears) a state flag on the hero and on its fixed layer, which share the state styles. */
function mark(root: HTMLElement, fixed: HTMLElement | null, key: string, value?: string) {
  for (const el of fixed ? [root, fixed] : [root]) {
    if (value === undefined) delete el.dataset[key]
    else el.dataset[key] = value
  }
}

function renderHeadline(text: string, accent: string) {
  const lines = text.split("\n")
  return lines.map((line, li) => {
    let content: React.ReactNode = line
    const a = accent && accent.trim()
    if (a) {
      const idx = line.indexOf(a)
      if (idx >= 0) {
        content = (
          <>
            {line.slice(0, idx)}
            <span className="sh-accent">{a}</span>
            {line.slice(idx + a.length)}
          </>
        )
      }
    }
    return (
      <span className="sh-line" key={li}>
        {content}
      </span>
    )
  })
}

export default function SculptureHero(props: SculptureHeroProps) {
  const {
    src = DEFAULTS.src,
    darkSrc = DEFAULTS.darkSrc,
    mobileSrc = DEFAULTS.mobileSrc,
    mobileDarkSrc = DEFAULTS.mobileDarkSrc,
    imageAlt = DEFAULTS.imageAlt,
    imageBackground,
    brand = DEFAULTS.brand,
    navLinks = DEFAULTS.navLinks,
    navCta = DEFAULTS.navCta,
    showNav = true,
    eyebrow = DEFAULTS.eyebrow,
    headline = DEFAULTS.headline,
    headlineAccent = DEFAULTS.headlineAccent,
    body = DEFAULTS.body,
    primaryCta = DEFAULTS.primaryCta,
    secondaryCta = DEFAULTS.secondaryCta,
    hint = DEFAULTS.hint,
    hintTouch = DEFAULTS.hintTouch,
    tagline,
    scrollCue,
    background: lightBackground = DEFAULTS.background,
    darkBackground = DEFAULTS.darkBackground,
    theme = "light",
    themeToggle = true,
    onThemeChange,
    textColor,
    accentColor,
    headingFont = DEFAULTS.headingFont,
    accentFont = DEFAULTS.accentFont,
    bodyFont = DEFAULTS.bodyFont,
    loadFonts = true,
    sculptureScale = 1,
    sculptureX = 0,
    sculptureY = 0,
    interactive = true,
    strength = 1,
    radius = 220,
    particleDensity = 1,
    particleSpread = 1,
    dotSize = 1,
    turbulence = 1,
    liquid = 1,
    streaks = true,
    restStyle = "image",
    returnSpeed = 1,
    ambient = false,
    ambientIntensity = 1,
    speed = 1,
    intro = false,
    height = "100svh",
    backdropText = "forma",
    scrollForms,
    ribbon,
    showCredit = true,
    className,
    style,
  } = props

  const follow = !!scrollForms
  const rootRef = React.useRef<HTMLElement>(null)
  const stageRef = React.useRef<HTMLDivElement>(null)
  const fixedRef = React.useRef<HTMLDivElement>(null)
  const fixedStageRef = React.useRef<HTMLDivElement>(null)
  const heroRect = React.useRef<Rect>({ x: 0, y: 0, w: 1, h: 1 })
  const formsRef = React.useRef(scrollForms)
  const ribbonRef = React.useRef(ribbon)
  const imgRef = React.useRef<HTMLImageElement>(null)
  const hintRef = React.useRef<HTMLDivElement>(null)
  const artRef = React.useRef<HTMLDivElement>(null)
  const backdropRef = React.useRef<HTMLDivElement>(null)
  const engineRef = React.useRef<LiquidEngine | null>(null)
  const aspectRef = React.useRef(1983 / 793)
  const [isTouch, setIsTouch] = React.useState(false)

  const layout = React.useRef({ scale: sculptureScale, x: sculptureX, y: sculptureY })

  const [mode, setMode] = React.useState<"light" | "dark">(theme)
  // a new theme prop wins over the switch; adjusted during render rather than in an effect
  const [themeProp, setThemeProp] = React.useState(theme)
  if (theme !== themeProp) {
    setThemeProp(theme)
    setMode(theme)
  }
  const background = mode === "dark" ? darkBackground : lightBackground
  const bgRgb = React.useMemo(() => hexToRgb(background, [0.92, 0.91, 0.9]), [background])
  // text follows the background unless set: light on dark grounds, dark on light ones
  const darkBg = bgRgb[0] * 0.2126 + bgRgb[1] * 0.7152 + bgRgb[2] * 0.0722 < 0.45
  const fg = textColor || (darkBg ? "#F1EFEA" : DEFAULTS.textColor)
  const acc = accentColor || fg
  const imgBgRgb = React.useMemo(
    () => (imageBackground ? hexToRgb(imageBackground, [0.918, 0.914, 0.906]) : null),
    [imageBackground]
  )
  const [isMobile, setIsMobile] = React.useState(false)
  const mobileRef = React.useRef(false)
  // pick the image for the current theme and layout, falling back sensibly
  const activeSrc =
    (isMobile && mode === "dark" && (mobileDarkSrc || darkSrc)) ||
    (isMobile && mode === "light" && mobileSrc) ||
    (mode === "dark" && darkSrc) ||
    src

  const engineOpts = (rm: boolean): EngineOptions => ({
    interactive,
    strength: clamp(strength, 0, 2),
    radius: clamp(radius, 40, 600),
    density: clamp(particleDensity, 0.15, 2),
    dotSize: clamp(dotSize, 0.2, 3),
    spread: clamp(particleSpread, 0, 2),
    turbulence: clamp(turbulence, 0, 2),
    liquid: clamp(liquid, 0, 2),
    streaks,
    restStyle,
    returnSpeed: clamp(returnSpeed, 0, 2),
    ambient,
    ambientIntensity: clamp(ambientIntensity, 0, 2),
    speed: clamp(speed, 0.25, 3),
    intro,
    reducedMotion: rm,
    bg: bgRgb,
    imgBg: imgBgRgb,
  })
  const optsRef = React.useRef(engineOpts)
  // the engine and the layout read the latest props through refs, refreshed before any effect runs
  React.useLayoutEffect(() => {
    layout.current = {
      scale: clamp(sculptureScale, 0.3, 3),
      x: sculptureX,
      y: sculptureY,
    }
    optsRef.current = engineOpts
    formsRef.current = scrollForms
    ribbonRef.current = ribbon
  })

  React.useEffect(() => {
    if (loadFonts) injectFonts()
  }, [loadFonts])

  const relayout = React.useCallback(() => {
    const root = rootRef.current
    const art = artRef.current
    if (!root || !art) return
    const w = root.clientWidth
    const h = root.clientHeight
    const mob = w < 640
    if (mob !== mobileRef.current) {
      mobileRef.current = mob
      setIsMobile(mob)
    }
    // the sculpture's column, in the hero's coordinates
    const b = root.getBoundingClientRect()
    const a = art.getBoundingClientRect()
    const box = { x: a.left - b.left, y: a.top - b.top, w: a.width, h: a.height }
    const rect = computeRect(w, h, aspectRef.current, box, layout.current)
    heroRect.current = rect
    const fixed = fixedRef.current
    const bd = backdropRef.current
    if (bd) {
      const chars = Math.max(1, (bd.textContent || "").length)
      bd.style.fontSize = Math.min(rect.h, (rect.w * 0.92) / (chars * 0.56)) + "px"
      bd.style.left = rect.x + rect.w / 2 + "px"
      bd.style.top = rect.y + rect.h / 2 + "px"
      // on the fixed layer the word still scrolls away with the hero
      if (fixed) bd.style.translate = `0 ${b.top}px`
    }
    const img = imgRef.current
    if (img) {
      img.style.left = rect.x + "px"
      img.style.top = rect.y + "px"
      img.style.width = rect.w + "px"
      img.style.height = rect.h + "px"
      // A cached image can paint at its natural size before hydration; reveal only the measured rectangle.
      img.style.visibility = "visible"
    }
    const hintEl = hintRef.current
    if (hintEl) {
      hintEl.style.left = clamp(rect.x + rect.w / 2, 80, w - 80) + "px"
      hintEl.style.top = Math.min(rect.y + rect.h * 0.95, box.y + box.h - 20) + "px"
    }
    if (fixed) engineRef.current?.resize(fixed.clientWidth, fixed.clientHeight, rect)
    else engineRef.current?.resize(w, h, rect)
  }, [])

  // engine lifecycle (re-created only when the image changes)
  React.useEffect(() => {
    const root = rootRef.current
    // following the page, the canvas lives on a layer fixed to the viewport, behind the page's text
    const fixed = fixedRef.current
    const stage = fixed ? fixedStageRef.current : stageRef.current
    if (!root || !stage) return
    // a fresh canvas per engine: a released WebGL context can never be reused
    const canvas = document.createElement("canvas")
    canvas.className = "sh-canvas"
    stage.appendChild(canvas)
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)")
    const coarse = window.matchMedia("(hover: none), (pointer: coarse)")
    setIsTouch(coarse.matches)
    let engine: LiquidEngine | null = null
    const fail = () => {
      mark(root, fixed, "gl", "off")
    }
    try {
      engine = new LiquidEngine(canvas, optsRef.current(mq.matches), fail)
      engineRef.current = engine
      if (fixed)
        engine.morph = (dt) => {
          const b = root.getBoundingClientRect()
          const r = heroRect.current
          const hero = { x: r.x + b.left, y: r.y + b.top, w: r.w, h: r.h }
          const still: SculptureShape = { kind: "image", rect: hero }
          const view = { w: fixed.clientWidth, h: fixed.clientHeight }
          return formsRef.current?.(hero, view, dt) ?? { from: still, to: still, mix: 0 }
        }
    } catch {
      fail()
    }

    const ro = new ResizeObserver(() => relayout())
    ro.observe(root)
    // the column moves when fonts load or the copy reflows
    if (artRef.current) ro.observe(artRef.current)
    // a fixed canvas is always on screen; the hero's own rests while the hero is scrolled away
    const io = fixed
      ? null
      : new IntersectionObserver((entries) => {
          for (const e of entries) engine?.setVisible(e.isIntersecting && !document.hidden)
        })
    io?.observe(root)
    const onVis = () => engine?.setVisible(!document.hidden)
    document.addEventListener("visibilitychange", onVis)
    const onMq = () => engine?.setOptions({ reducedMotion: mq.matches })
    mq.addEventListener?.("change", onMq)
    const onScroll = () => {
      const bd = backdropRef.current
      if (bd) bd.style.translate = `0 ${root.getBoundingClientRect().top}px`
      engine?.refresh()
    }
    if (fixed) {
      window.addEventListener("scroll", onScroll, { passive: true })
      window.addEventListener("resize", relayout)
    }

    // on the fixed layer the whole page stirs the sculpture
    const target = fixed ? document.documentElement : root
    const pos = (e: PointerEvent) => {
      if (fixed) return [e.clientX, e.clientY] as const
      const b = root.getBoundingClientRect()
      return [e.clientX - b.left, e.clientY - b.top] as const
    }
    let touched = false
    const markTouched = () => {
      if (!touched) {
        touched = true
        root.dataset.touched = "1"
      }
    }
    const onMove = (e: PointerEvent) => {
      const [x, y] = pos(e)
      const touch = e.pointerType === "touch"
      if (touch && e.buttons === 0 && e.pressure === 0) return
      engine?.pointer("move", x, y, touch)
      markTouched()
    }
    const onDown = (e: PointerEvent) => {
      const [x, y] = pos(e)
      engine?.pointer("down", x, y, e.pointerType === "touch")
      markTouched()
    }
    const onUp = (e: PointerEvent) => {
      const [x, y] = pos(e)
      engine?.pointer("up", x, y, e.pointerType === "touch")
    }
    const onLeave = (e: PointerEvent) => {
      const [x, y] = pos(e)
      engine?.pointer("leave", x, y, e.pointerType === "touch")
    }
    target.addEventListener("pointermove", onMove, { passive: true })
    target.addEventListener("pointerdown", onDown, { passive: true })
    target.addEventListener("pointerup", onUp, { passive: true })
    target.addEventListener("pointercancel", onUp, { passive: true })
    target.addEventListener("pointerleave", onLeave, { passive: true })

    return () => {
      ro.disconnect()
      io?.disconnect()
      document.removeEventListener("visibilitychange", onVis)
      mq.removeEventListener?.("change", onMq)
      window.removeEventListener("scroll", onScroll)
      window.removeEventListener("resize", relayout)
      target.removeEventListener("pointermove", onMove)
      target.removeEventListener("pointerdown", onDown)
      target.removeEventListener("pointerup", onUp)
      target.removeEventListener("pointercancel", onUp)
      target.removeEventListener("pointerleave", onLeave)
      engine?.destroy()
      engineRef.current = null
      canvas.remove()
      mark(root, fixed, "gl")
    }
  }, [relayout])

  // (re)load the sculpture whenever the theme or layout asks for another image;
  // the canvas dips out while the static image covers the swap
  React.useEffect(() => {
    const root = rootRef.current
    const fixed = fixedRef.current
    const engine = engineRef.current
    if (!root) return
    let cancelled = false
    const image = new Image()
    image.crossOrigin = "anonymous"
    image.decoding = "async"
    const swapping = root.dataset.gl === "on"
    if (swapping) mark(root, fixed, "swap", "1")
    image.onload = () => {
      if (cancelled) return
      aspectRef.current = image.naturalWidth / image.naturalHeight || aspectRef.current
      relayout()
      if (engine && root.dataset.gl !== "off") {
        try {
          engine.onFirstFrame = () => {
            if (cancelled) return
            mark(root, fixed, "gl", "on")
            mark(root, fixed, "swap")
          }
          engine.ribbon = ribbonRef.current ?? null
          engine.setImage(image)
          relayout()
        } catch {
          mark(root, fixed, "gl", "off")
        }
      } else mark(root, fixed, "swap")
    }
    image.onerror = () => {
      mark(root, fixed, "swap")
    }
    // let the fade-out start before the GPU upload
    const t = window.setTimeout(() => (image.src = activeSrc), swapping ? 280 : 0)
    return () => {
      cancelled = true
      window.clearTimeout(t)
      image.onload = null
      image.onerror = null
    }
  }, [activeSrc, relayout])

  // live option updates without re-creating the engine
  React.useEffect(() => {
    const e = engineRef.current
    if (!e) return
    const rm = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    e.setOptions(optsRef.current(rm))
  }, [interactive, strength, radius, particleDensity, dotSize, particleSpread, turbulence, liquid, streaks, restStyle, returnSpeed, ambient, ambientIntensity, speed, intro, bgRgb, imgBgRgb])

  React.useLayoutEffect(() => {
    relayout()
  }, [sculptureScale, sculptureX, sculptureY, relayout])

  const vars = {
    "--sh-bg": background,
    "--sh-fg": fg,
    "--sh-acc": acc,
    "--sh-head": headingFont,
    "--sh-accent": accentFont,
    "--sh-body": bodyFont,
    "--sh-h": height,
  } as React.CSSProperties

  const hintText = isTouch ? hintTouch : hint
  const backdrop = backdropText ? (
    <div ref={backdropRef} className="sh-backdrop" aria-hidden="true">
      {backdropText}
    </div>
  ) : null

  return (
    <>
      {follow && (
        <div ref={fixedRef} className="sh-fixed" style={vars} aria-hidden="true">
          {backdrop}
          <div ref={fixedStageRef} className="sh-stage" />
        </div>
      )}
      <section
        ref={rootRef}
        className={"sh-root" + (follow ? " sh-follow" : "") + (className ? " " + className : "")}
        style={{ ...vars, ...style }}
      >
        <style>{CSS}</style>
        {follow ? null : backdrop}
        <div ref={stageRef} className="sh-stage" aria-hidden="true">
          {/* eslint-disable-next-line @next/next/no-img-element -- placed by hand over the canvas, which samples the same file */}
          <img ref={imgRef} className="sh-fallback" src={activeSrc} alt="" crossOrigin="anonymous" draggable={false} />
        </div>
        <span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>{imageAlt}</span>

        {showNav && (
          <nav className="sh-nav" aria-label="Primary">
            <a className="sh-brand" href="#top">
              {brand}
            </a>
            <ul className="sh-links">
              {navLinks.map((l, i) => (
                <li key={i}>
                  <a className="sh-link" href={l.href}>
                    {l.label}
                  </a>
                </li>
              ))}
              {themeToggle && (
                <li className="sh-keep">
                  <button
                    type="button"
                    className="sh-theme"
                    aria-label={mode === "dark" ? "Switch to light theme" : "Switch to dark theme"}
                    onClick={() => {
                      const next = mode === "dark" ? "light" : "dark"
                      setMode(next)
                      onThemeChange?.(next)
                    }}
                  >
                    {mode === "dark" ? <SunIcon /> : <MoonIcon />}
                  </button>
                </li>
              )}
              {navCta && navCta.label && (
                <li className="sh-keep">
                  <a className="sh-navcta" href={navCta.href}>
                    {navCta.label}
                  </a>
                </li>
              )}
            </ul>
          </nav>
        )}

        {interactive && hintText ? (
          <div ref={hintRef} className="sh-hint" aria-hidden="true">
            {hintText}
          </div>
        ) : null}

        <div className="sh-content">
          <div>
            {eyebrow ? <p className="sh-eyebrow">{eyebrow}</p> : null}
            <h1 className="sh-h1">{renderHeadline(headline, headlineAccent)}</h1>
            {body ? <p className="sh-body">{body}</p> : null}
            {primaryCta?.label || secondaryCta?.label ? (
              <div className="sh-ctas">
                {primaryCta?.label ? (
                  <a className="sh-btn" href={primaryCta.href}>
                    {primaryCta.label}
                    <Arrow />
                  </a>
                ) : null}
                {secondaryCta?.label ? (
                  <a className="sh-txt" href={secondaryCta.href}>
                    {secondaryCta.label}
                    <Arrow />
                  </a>
                ) : null}
              </div>
            ) : null}
          </div>
          {/* the sculpture's place beside the copy; the canvas draws it there */}
          <div ref={artRef} className="sh-art" />
        </div>

        {tagline || scrollCue?.label ? (
          <div className="sh-foot">
            {tagline ? <span className="sh-tagline">{tagline}</span> : null}
            {scrollCue?.label ? (
              <a className="sh-scroll" href={scrollCue.href}>
                {scrollCue.label}
                <Arrow />
              </a>
            ) : null}
          </div>
        ) : null}

        {showCredit && (
          <a className="sh-credit" href="https://guglielmogiannattasio.it" target="_blank" rel="noopener noreferrer">
            by guglielmogiannattasio.it
          </a>
        )}
      </section>
    </>
  )
}
