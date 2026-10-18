import type { DiagramQuality, DiagramRotation } from "./types";

export function isPhotographedDiagram(quality: DiagramQuality | null | undefined): boolean;
export function normalizeDiagramRotation(value: unknown): DiagramRotation;
export function correctionForCapturedRotation(value: unknown): DiagramRotation;
export function rotateNormalizedBox<T extends { x: number; y: number; width: number; height: number }>(box: T, rotation: unknown): T;
export function fitWithinMaxEdge(width: number, height: number, maxEdge: number): { width: number; height: number; scale: number };
