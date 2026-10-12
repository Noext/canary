import { expect, test } from "@playwright/test";
import { copy, harnessState } from "./fixtures";

/**
 * Flow A: the first run and the local session.
 *
 * A real setup ticket is issued server-side by the harness (`LocalAuth`), the
 * account is created through the first-run screen, and the same credentials are
 * used again after a sign-out — the session must survive a browser reload.
 */
test("creates the first administrator from the setup link, signs out and back in", async ({
  page,
}) => {
  const state = harnessState();
  await page.goto(`${state.baseUrl}/#setup=${state.setupTicket}`);
  await expect(page.locator("#authTitle")).toHaveText(copy.firstRunTitle);
  // A setup link is enough: no operator command to copy, and the form is usable.
  await expect(page.locator("#setupInstructions")).toBeHidden();
  await expect(page.locator("#accountSubmit")).toBeEnabled();
  await expect(page.locator("#accountSubmit")).toHaveText(copy.createAccount);

  await page.fill("#username", state.username);
  await page.fill("#password", state.password);
  await page.fill("#confirmPassword", state.password);
  await page.click("#accountSubmit");

  await expect(page.locator("#work")).toBeVisible();
  await expect(page.locator("#connection")).toContainText(state.username);
  await expect(page.locator("#connection")).toContainText("Administrateur");
  // Réglages is the admin-only panel: its visibility proves the role came back
  // from the server with the session, not from a client-side guess.
  await expect(page.locator("#nav-settings")).toBeVisible();

  await page.click("#logout");
  await expect(page.locator("#authTitle")).toHaveText(copy.loginTitle);
  await expect(page.locator("#work")).toHaveCount(0);

  await page.fill("#username", state.username);
  await page.fill("#password", state.password);
  await page.click("#accountSubmit");
  await expect(page.locator("#work")).toBeVisible();
  await expect(page.locator("#connection")).toContainText(state.username);

  await page.reload();
  await expect(page.locator("#work")).toBeVisible();
  await expect(page.locator("#connection")).toContainText(state.username);

  await page.click("#nav-settings");
  await expect(page.locator("#viewTitle")).toHaveText(
    "Réglages de votre espace"
  );
});
