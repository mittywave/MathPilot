export function orderedImportTimestamp(batchStartedAt: number, index: number): number;
export function retainedQuestionCreatedAt(value: unknown, now?: number): number;
export type ImportPosition = { pageNumber: number; type: string; number: string };
export function crossPageRepeat(previous: ImportPosition | undefined, current: ImportPosition, firstOnPage: boolean): boolean;
export function numberedImportTarget<T extends { selected: boolean; documentNumber: string }>(items: T[], number: string): { target: T | undefined; clash: T[] };
