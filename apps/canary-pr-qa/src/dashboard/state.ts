import type { Principal } from "../access.js";
import type { Preflight, SetupStatus } from "./contracts.js";
export type View = "home" | "new" | "runs" | "settings";
interface DashboardState {
  activeView: View;
  canWrite: boolean;
  catalogReady: boolean;
  current?: string;
  currentUser?: Principal;
  modelsInitialized: boolean;
  modelsLoading: boolean;
  preflight?: Preflight;
  preflightBusy: boolean;
  requestedRun?: string;
  setupCode: string;
  setupInfo?: SetupStatus;
  setupMode: boolean;
  stream?: EventSource;
}
export const state: DashboardState = {
  canWrite: false,
  activeView: "home",
  requestedRun: /^#[0-9a-f-]{36}$/.test(location.hash)
    ? location.hash.slice(1)
    : undefined,
  modelsLoading: false,
  modelsInitialized: false,
  catalogReady: false,
  preflightBusy: false,
  setupCode: new URLSearchParams(location.hash.slice(1)).get("setup") || "",
  setupMode: false,
};
