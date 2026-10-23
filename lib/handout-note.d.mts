export type NoteSpan = { text: string; bold: boolean };
export type NoteFigure = { src: string; caption: NoteSpan[] };
export type NoteTableCell = { colSpan: number; rowSpan: number; content: string };
export type NoteLine =
  | { kind: "heading"; level: 1 | 2 | 3; spans: NoteSpan[] }
  | { kind: "item"; marker: string; spans: NoteSpan[] }
  | { kind: "text"; spans: NoteSpan[] }
  | { kind: "table"; rows: NoteTableCell[][] }
  | { kind: "figures"; figures: NoteFigure[]; side: NoteSpan[][] };
export type NoteBox = { x: number; y: number; width: number; height: number };
export type RecognizedNoteFigure = { bbox: NoteBox; caption: string; captionBox: NoteBox | null };
export type RecognizedNoteCell = { colSpan: number; rowSpan: number; text: string; bbox: NoteBox | null; figures: RecognizedNoteFigure[] };
export type RecognizedNoteBlock =
  | { type: "heading"; level: 1 | 2 | 3; text: string; bbox: NoteBox | null }
  | { type: "paragraph"; text: string; bbox: NoteBox | null }
  | { type: "item"; marker: string; text: string; bbox: NoteBox | null }
  | { type: "table"; rows: RecognizedNoteCell[][]; bbox: NoteBox | null }
  | { type: "figures"; figures: RecognizedNoteFigure[]; side: string; sideBox: NoteBox | null };

export const ITEM_MARKER: RegExp;
export const SAFE_IMAGE: RegExp;
export function proofSteps(line: string): string[];
export function noteSpans(text: string): NoteSpan[];
export function parseHandoutNote(note: string | null | undefined): NoteLine[];
export function noteImageSources(note: string | null | undefined): string[];
export function escapeCaption(caption: string | null | undefined): string;
export function noteTableMarkup(rows: NoteTableCell[][]): string;
export function noteFromBlocks(blocks: RecognizedNoteBlock[], figureSource: (figure: RecognizedNoteFigure) => string | null): string;
