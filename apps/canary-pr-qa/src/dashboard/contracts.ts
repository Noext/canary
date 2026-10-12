/**
 * Dashboard HTTP contract, server side.
 *
 * The browser copy of this contract lives in `@usecanary/pr-qa-ui`
 * (`src/api/contracts.ts` + `src/api/schemas.ts`). Keep both in sync: the UI
 * validates every response at runtime, so a change here that is not mirrored
 * there fails loudly instead of rendering `undefined`.
 */

export interface SetupStatus {
  ai: { defaultModel: string; endpoint: string };
  github: { mode: "missing" | "technical" | "app"; repositories: string[] };
  preview: {
    automatic: boolean;
    hosts?: string[];
    shaHeader?: string;
    shaPath?: string;
  };
}

export interface Preflight {
  model: string;
  pr: { number: number; repo: string; sha: string; title: string };
  preview: { sha: string; url: string };
  ready: boolean;
}
