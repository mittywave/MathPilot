import type { HandoutGrade, KnowledgeGraphDocument, KnowledgeGraphNode } from './types';

export type KnowledgeGraphInfo = { id: string; title: string; course: boolean };
export type CourseLesson = { id: string; title: string; grade: HandoutGrade; modules: { id: string; title: string }[] };
export const KNOWLEDGE_GRAPHS: KnowledgeGraphInfo[];
export const DEFAULT_KNOWLEDGE_GRAPH: string;
export function knowledgeGraphInfo(id: string | null | undefined): KnowledgeGraphInfo | null;
export function lessonKey(handoutId: string): string;
export function moduleKey(sectionId: string): string;
export function isCourseNodeKey(key: string | null | undefined): boolean;
export function handoutIdOf(key: string | null | undefined): string;
export function sectionIdOf(key: string | null | undefined): string;
export function handoutHref(node: Pick<KnowledgeGraphNode, 'key' | 'level' | 'parentKey'>): string;
export function courseGraphSeed(): KnowledgeGraphDocument;
export function syncCourseGraph(document: KnowledgeGraphDocument, lessons: CourseLesson[], published?: KnowledgeGraphDocument | null): KnowledgeGraphDocument;
