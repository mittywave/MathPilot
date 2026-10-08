import type { Plugin } from "vite";

export type ShareNetwork = { id: string; label: string; address: string; subnet: string };
export type RememberedNetwork = { id: string; label: string; rememberedAt: number };
export type ShareState = { session: string | null; remembered: RememberedNetwork[] };

export class ShareRequestError extends Error {
  status: number;
  constructor(message: string, status?: number);
}
export function parseDefaultRoute(output: string): { gateway: string; iface: string } | null;
export function parseRouterMac(output: string): string | null;
export function subnetOf(address: string, netmask: string): string;
export function describeNetwork(input: { gateway: string; address: string; netmask: string; routerMac: string | null }): ShareNetwork;
export function detectNetwork(): Promise<ShareNetwork | null>;
export function localNetworkName(): string;
export function isSharing(state: ShareState, network: ShareNetwork | null): boolean;
export function changeSharing(state: ShareState, network: ShareNetwork | null, change: { sharing: boolean; remember: boolean }, now?: number): ShareState;
export function forgetNetwork(state: ShareState, id: string): ShareState;
export function lanSharePlugin(options?: {
  root?: string;
  detect?: () => Promise<ShareNetwork | null>;
  keepAwake?: (on: boolean) => void;
  refreshMs?: number;
  name?: string;
}): Plugin;
