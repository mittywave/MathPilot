export type MathSourceRange = { start:number; end:number; value:string; display:boolean };
export type MathSourceIssue = { offset:number; message:string };
export function repairMathSource(source:string):string;
export function normalizeProseLineBreaks(text:string):string;
export function restoreDecodedCommands(text:string):string;
export function scanMathSource(text:string):{ranges:MathSourceRange[];issues:MathSourceIssue[]};
export function splitMathParagraphs(text:string):string[];
