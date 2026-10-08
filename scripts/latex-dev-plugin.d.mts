import type { IncomingMessage } from "node:http";
import type { Plugin } from "vite";

export class LatexRequestError extends Error {
  status: number;
  constructor(message: string, status?: number);
}
export function validateLatexFiles(body: unknown): { main: string; entries: [string, Buffer][] };
export function latexIssues(output: string): string[];
export function latexDevPlugin(options?: { root?: string; signedIn?: (request: IncomingMessage) => Promise<boolean> }): Plugin;
