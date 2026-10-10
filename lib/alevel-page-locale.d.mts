export type AlevelPageLocale = "zh" | "en";
export const ALEVEL_PAGE_LOCALE_KEY: string;
export function isAlevel9709ModuleName(name: unknown): boolean;
export const ALEVEL_PAGE_COPY: Record<AlevelPageLocale, Record<string, string>>;
export function alevelPageLabel(value: string, locale: AlevelPageLocale): string;
export function alevelQuestionCount(count: number, locale: AlevelPageLocale): string;
export type AlevelTagInput = { tags?: string[]; tagsZh?: string[]; tagsEn?: string[] };
export function alevelTagVersions(question?: AlevelTagInput): { zh: string[]; en: string[] };
export function localizeAlevelTags(question: AlevelTagInput, locale: AlevelPageLocale): string[];
