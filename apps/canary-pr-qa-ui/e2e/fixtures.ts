import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { type HarnessState, readHarnessState } from "./state";

/** Copy the specs assert on, exactly as `src/i18n.ts` ships it. */
export const copy = {
  createAccount: "Créer mon compte administrateur",
  firstRunTitle: "Créez votre compte administrateur",
  // Legacy copy and apps/canary-pr-qa/test/e2e.test.ts:929 assert this exact title.
  loginTitle: "Connectez-vous",
  repoMessage: "Dépôts enregistrés",
} as const;

/** URLs and credentials of the shared world `global-setup.ts` started. */
export function harnessState(): HarnessState {
  return readHarnessState();
}

/**
 * Signs in through the local login form, exactly as an operator would. The
 * first administrator is created by `login.spec.ts` (the project dependencies
 * in `playwright.config.ts` run it first); a missing account shows up here as
 * the first-run title, and the assertion below spells that out.
 */
export async function signIn(page: Page, state: HarnessState): Promise<void> {
  await page.goto(state.baseUrl);
  await expect(page.locator("#authTitle")).toHaveText(copy.loginTitle);
  await page.fill("#username", state.username);
  await page.fill("#password", state.password);
  await page.click("#accountSubmit");
  await expect(page.locator("#work")).toBeVisible();
  await expect(page.locator("#connection")).toContainText(state.username);
}
