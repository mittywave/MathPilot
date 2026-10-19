export function isDocxOptionBlock(value: string): boolean;
export function splitDocxOptionBlocks(values: string[]): string[];
export function docxNumberedQuestion(text: string): { number: string; stem: string } | null;
export function normalizedDocxPageLookup(value: string): string;
export function docxQuestionHeading(text: string, xml: string): { label: string; number: string } | null;
export function docxTitleLine(text: string, xml: string): boolean;
export function docxInferredQuestionType(blocks: Array<{ text: string; xml: string }>, optionCount: number): "单选题" | "填空题" | "解答题";
export function docxStudioRole(text: string, xml: string): "analysis" | "warning" | null;
export function docxVmlPicturesToDrawing(xml: string, firstId?: number): { xml: string; pictures: number; overlays: number };
