import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What the end-to-end harness wrote on disk: where the dashboard answers and
 * which fixture it serves. The credentials are real ones the login spec creates
 * through the first-run screen — never a cookie injected from outside.
 */
export interface HarnessState {
  baseUrl: string;
  dataDir: string;
  githubApiUrl: string;
  password: string;
  previewUrl: string;
  prUrl: string;
  setupTicket: string;
  username: string;
}

/** Written by `global-setup.ts`, ignored by git (throwaway local credentials). */
export const harnessStateFile = join(
  import.meta.dirname,
  ".auth",
  "harness.json"
);

export function readHarnessState(): HarnessState {
  return JSON.parse(readFileSync(harnessStateFile, "utf8")) as HarnessState;
}
