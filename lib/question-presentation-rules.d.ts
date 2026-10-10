export const UNDERLINE_OPEN: string;
export const UNDERLINE_CLOSE: string;
export function markDocxUnderline(value: string): string;
export function splitDisplayUnderlines(value: string): Array<{ underlined: boolean; value: string }>;
export function isCompactConclusionChoice(input: { type: string; stem: string; imageCount: number; optionCount: number }): boolean;
export function automaticQuestionImageLayout(input: { imageCount: number; stemLength: number; paragraphCount: number; type?: string; stem?: string; optionCount?: number }): "below" | "below-right" | null;
export function optionColumnCount(options: string[]): 2 | 4;
export function shouldUseBelowLayout(input: { imageCount: number; stemLength: number; paragraphCount: number; type?: string; stem?: string; optionCount?: number }): boolean;
