import type { Principal } from "../access.js";
import type { GitHubSetup } from "../github-setup.js";
import type { Job } from "../queue.js";

export interface SetupStatus {
  ai: { endpoint: string; defaultModel: string };
  github: { mode: "missing" | "technical" | "app"; repositories: string[] };
  preview: {
    automatic: boolean;
    hosts?: string[];
    shaPath?: string;
    shaHeader?: string;
  };
}
export interface Preflight {
  model: string;
  pr: { title: string; repo: string; number: number; sha: string };
  preview: { url: string; sha: string };
  ready: boolean;
}
export interface RunJob extends Job {
  error?: string;
  progress?: { phase?: string; scenarioId?: string; action?: string };
}
export interface ApiResponses {
  "/auth/login": Principal;
  "/auth/setup": Principal;
  "/auth/status": { initialized: boolean };
  "/dashboard/status": SetupStatus;
  "/github/app": Awaited<ReturnType<GitHubSetup["status"]>>;
  "/github/app/install": { url: string };
  "/github/app/manifest": { action: string; manifest: unknown };
  "/github/app/refresh": ApiResponses["/github/app"];
  "/github/app/repositories": ApiResponses["/github/app"];
  "/me": Principal;
  "/models": { data: { id: string }[]; defaultModel: string };
  "/runs": RunJob[];
  "/runs/preflight": Preflight;
  "/session": Principal;
}
