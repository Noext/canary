import { spawn } from "node:child_process";
import { cp, mkdir, readdir, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";
import { createLogger } from "@usecanary/logger";
import type { BrowserAuth } from "@usecanary/protocol";
import { z } from "zod";
import type { Config } from "./config.js";
import { QaError } from "./diagnostics.js";
import { fetchText } from "./http.js";
import { verifyPreviewUrl } from "./preview.js";
import { checkBudget, runScope } from "./run-scope.js";
import type { Action, Assertion, Locator } from "./schema.js";

const logger = createLogger({ name: "pr-qa-browser" });

/** Budget d'instantané transmis au modèle : la planification et l'exécution gardent cette taille. */
export const MODEL_SNAPSHOT_CHARS = 14_000;

/**
 * Plafond de l'instantané conservé comme évidence de validation du plan. Au
 * plafond, l'instantané est coupé : le contrôle d'évidence est « non concluant »
 * et ne refuse aucun scénario.
 */
export const PLAN_EVIDENCE_SNAPSHOT_CHARS = 200_000;

const MARKER = "CANARY_PR_QA_OBSERVATION:";
const observationSchema = z.object({
  url: z.string(),
  snapshot: z.string(),
  actual: z.unknown().optional(),
  evidence: z.string().optional(),
  provenanceUrls: z.array(z.string().url()).max(5).optional(),
  /** Nom accessible réellement visé, renseigné seulement après un repli typographique. */
  targetName: z.string().optional(),
});
export type Observation = z.infer<typeof observationSchema>;

/**
 * Nom accessible retenu par le repli typographique, relu depuis une observation
 * enregistrée (`StepResult.observation`) : la substitution est une preuve du run,
 * donc rendue aux surfaces que l'opérateur lit, pas seulement au log du daemon.
 */
export function resolvedTargetName(observation: string): string | undefined {
  try {
    const parsed = observationSchema.safeParse(JSON.parse(observation));
    return parsed.success ? parsed.data.targetName : undefined;
  } catch {
    return;
  }
}

/**
 * Graphies équivalentes d'un même signe : le premier membre est le
 * représentant vers lequel le repli ramène les autres. Un lecteur ne distingue
 * pas « Justification de l’écart » de « Justification de l'écart » ; Playwright,
 * avec `exact: true`, compare le nom accessible caractère par caractère et ne
 * résout jamais l'autre graphie.
 */
const TYPOGRAPHIC_CLASSES: readonly (readonly string[])[] = [
  ["'", "\u2018", "\u2019"],
  ['"', "\u00ab", "\u00bb"],
  [" ", "\u00a0", "\u202f"],
];

/** Repli de chaque graphie vers le représentant de sa classe, sa propre graphie comprise. */
const TYPOGRAPHIC_FOLD = new Map<string, string>(
  TYPOGRAPHIC_CLASSES.flatMap((members) =>
    members.map((member): [string, string] => [member, members[0] ?? member])
  )
);

/**
 * Plafond des variantes essayées après l'échec du nom exact : chaque position
 * repliable multiplierait les candidats, et un nom reste lisible au-delà.
 */
const MAX_TYPOGRAPHIC_VARIANTS = 16;

/** Nom ramené aux graphies représentatives de ses signes. */
export function foldTypography(value: string): string {
  return [...value].map((char) => TYPOGRAPHIC_FOLD.get(char) ?? char).join("");
}

/**
 * Codepoints des signes par lesquels deux noms repliables diffèrent, dans
 * l'ordre d'apparition : deux noms que `foldTypography` confond ont la même
 * longueur, donc l'écart se lit position par position. C'est ce qui rend la
 * différence nommable sans ambiguïté (`U+0027` contre `U+2019`).
 */
export function typographicCodepoints(value: string, other: string): string {
  const points = new Set<string>();
  const compared = [...other];
  for (const [index, char] of [...value].entries()) {
    if (char !== compared[index] && TYPOGRAPHIC_FOLD.has(char)) {
      const code = (char.codePointAt(0) ?? 0).toString(16).toUpperCase();
      points.add(`U+${code.padStart(4, "0")}`);
    }
  }
  return [...points].join(" ");
}

/**
 * Graphies que ce signe peut prendre : toute sa classe. L'espace ordinaire
 * n'en sort pas, parce que `typographicVariants` ne le replie jamais.
 */
function typographicEquivalents(char: string): string[] {
  const members = TYPOGRAPHIC_CLASSES.find((klass) => klass.includes(char));
  return !members || char === " " ? [char] : [...members];
}

/**
 * Noms accessibles que le même locator role+nom peut viser par repli. L'espace
 * ordinaire ne se replie pas position par position : un nom en compte
 * plusieurs, et le produit dépasserait le plafond pour la plupart des noms. Le
 * repli couvre donc l'apostrophe et le guillemet (la cause observée) ainsi que
 * l'espace insécable ramené à l'espace ordinaire ; l'écart inverse reste nommé
 * par le diagnostic, jamais cliqué.
 */
export function typographicVariants(name: string): string[] {
  let variants = [""];
  for (const char of name) {
    const equivalents = typographicEquivalents(char);
    if (variants.length * equivalents.length > MAX_TYPOGRAPHIC_VARIANTS) {
      return [];
    }
    variants = variants.flatMap((prefix) =>
      equivalents.map((equivalent) => prefix + equivalent)
    );
  }
  return variants.filter((variant) => variant !== name);
}

/**
 * `getByLabel` compare le texte du libellé associé, pas le nom accessible du
 * contrôle : ce texte est la concaténation de tous les nœuds texte du `<label>`
 * englobant, donc aussi celle des `option` d'un `<select>` — dont le rôle
 * implicite est `listbox` pour un `<select multiple>` — ou du contenu initial
 * d'un `<textarea>`. Un libellé réduit à un `sr-only` — « Pharmacie active »,
 * run e6df6014 — ne correspond plus exactement et le locator ne résout rien.
 *
 * Le nom accessible, lui, reste juste : on garde le libellé exact comme cible,
 * avec son attente automatique complète, et l'union par nom accessible n'est
 * tentée qu'après un échec de *résolution* de celui-ci. Décider à partir d'un
 * `count()` immédiat serait faux : un contrôle homonyme déjà monté gagnerait
 * contre le contrôle visé qui n'est pas encore monté.
 */
function labelTargets(value: string): { strict: string; fallback: string } {
  const name = JSON.stringify(value);
  const exact = `{ name: ${name}, exact: true }`;
  const strict = `page.getByLabel(${name}, { exact: true })`;
  const fallback = ["combobox", "listbox", "textbox"].reduce(
    (expression, role) =>
      `${expression}.or(page.getByRole(${JSON.stringify(role)}, ${exact}))`,
    strict
  );
  return { strict, fallback };
}

/**
 * Émis dans le script compilé par `locatorCall` : rejoue l'appel sur le nom
 * accessible uniquement si le libellé exact n'a rien résolu — s'il a résolu un
 * contrôle non actionnable, l'erreur remonte au lieu de viser un autre contrôle.
 */
/**
 * Émis dans le script compilé par `locatorCall` : rejoue l'appel sur le nom
 * accessible uniquement si le libellé exact n'a rien résolu — s'il a résolu un
 * contrôle non actionnable, l'erreur remonte au lieu de viser un autre contrôle.
 *
 * Déclaré en fonction, et non en `const` : `compileProbe` injecte sa lecture
 * juste après `let actual;`, avant cette déclaration, et une liaison `const`
 * serait dans sa zone morte temporelle à cet endroit.
 */
const RESOLVE_LABEL_HELPER = `async function resolveLabel(strict, fallback, act) {
  try {
    return await act(strict);
  } catch (error) {
    if (!/Timeout \\d+ms exceeded|strict mode violation/.test(String(error))) throw error;
    if (await strict.count()) throw error;
    return await act(fallback);
  }
}`;

/**
 * Émis dans le script compilé par `locatorCall` : rejoue le même appel sur les
 * graphies équivalentes du nom accessible, uniquement après l'échec du nom
 * exact et uniquement si ces graphies atteignent exactement un élément au
 * total. Une cible absente de la page ne peut donc pas devenir un clic sur un
 * homonyme, et deux graphies concurrentes gardent l'échec d'origine. Le nom
 * réellement visé est publié dans l'observation, jamais tu.
 */
const RESOLVE_NAME_HELPER = `async function resolveName(exact, role, names, act) {
  try {
    return await act(exact);
  } catch (error) {
    if (!/Timeout \\d+ms exceeded|strict mode violation/.test(String(error))) throw error;
    if (await exact.count()) throw error;
    let used;
    let matched = 0;
    for (const name of names) {
      const candidate = page.getByRole(role, { name, exact: true });
      const count = await candidate.count();
      matched += count;
      if (count === 1) used = { candidate, name };
    }
    if (!(used && matched === 1)) throw error;
    targetName = used.name;
    return await act(used.candidate);
  }
}`;

/**
 * Émis dans le script compilé par `locatorCall` pour les lectures qui mesurent
 * un locator vide sans lever (`isVisible`) : elles rendent false au lieu du
 * délai qui déclencherait le repli après échec, donc le repli n'aurait jamais
 * lieu. La graphie réellement exposée est ici résolue avant la lecture, `build`
 * reconstruisant le locator de la même famille — nom accessible d'un rôle,
 * texte, placeholder — et deux graphies concurrentes lèvent un échec explicite
 * au lieu d'être départagées au hasard. Une cible réellement absente garde la
 * lecture honnête de la graphie exacte (false), sans laquelle `hidden` ne serait
 * plus exprimable.
 *
 * L'ambiguïté est jetée sous forme d'objet `{ name, message }`, pas d'un
 * `new Error` : un `Error` créé dans le bac à sable QuickJS perd son message en
 * traversant la frontière (seule la pile remonte jusqu'au CLI), donc l'opérateur
 * ne lirait pas la cause. Un objet dont `message` est propre la porte jusqu'au
 * rapport.
 */
const RESOLVE_SPELLING_READ_HELPER = `async function readSpelling(exact, build, label, names, planned, read) {
  if (await exact.count()) return await read(exact);
  let used;
  let matched = 0;
  const exposed = [];
  for (const name of names) {
    const candidate = build(name);
    const count = await candidate.count();
    matched += count;
    if (count) exposed.push(JSON.stringify(name) + " (" + count + ")");
    if (count === 1) used = { candidate, name };
  }
  if (matched === 0) return await read(exact);
  if (!(used && matched === 1)) {
    throw { name: "AmbiguousTargetError", message: "Ambiguous " + label + " " + JSON.stringify(planned) + ": the page exposes " + exposed.join(" and ") + ", so no spelling is chosen; retarget the assertion on one unambiguous spelling" };
  }
  targetName = used.name;
  return await read(used.candidate);
}`;

/**
 * Émis dans le script compilé par `locatorCount` : une assertion de comptage ne
 * choisit pas un élément, elle compte le signe visé sous toutes ses graphies. Le
 * total additionne la graphie exacte et ses variantes — deux graphies exactes ne
 * peuvent pas désigner le même élément — donc le verdict porte sur le nombre
 * réel d'éléments, jamais sur celui d'une graphie choisie au hasard. Aucune
 * unicité n'est exigée ici : un compte faux reste un compte faux au lieu de
 * devenir une erreur d'ambiguïté. La substitution n'est publiée que lorsqu'une
 * graphie unique remplace la graphie exacte absente.
 */
const RESOLVE_SPELLING_COUNT_HELPER = `async function countSpelling(exact, build, names) {
  const count = await exact.count();
  const exposed = [];
  let total = count;
  for (const name of names) {
    const found = await build(name).count();
    if (found) exposed.push(name);
    total += found;
  }
  if (count === 0 && exposed.length === 1) targetName = exposed[0];
  return total;
}`;

/**
 * Même règle pour un locator `by:"label"` : `resolveLabel` ne rejoue le repli
 * par nom accessible qu'après le délai d'un libellé introuvable, délai qu'une
 * lecture qui mesure ne produit jamais. Quand le libellé exact ne résout rien,
 * la lecture suit donc l'union par nom accessible au lieu de mesurer un locator
 * vide.
 */
const RESOLVE_LABEL_READ_HELPER = `async function readLabel(strict, fallback, read) {
  return (await strict.count()) ? await read(strict) : await read(fallback);
}`;

/**
 * Graphie littérale visée par un locator dont la graphie d'un signe peut
 * différer de celle de la page : nom accessible d'un rôle, texte, placeholder.
 * `css` et `testId` ne portent aucun texte, `label` a son propre repli.
 */
function spellingValue(locator: Locator): string | undefined {
  if (locator.by === "role") {
    return locator.name;
  }
  if (locator.by === "text" || locator.by === "placeholder") {
    return locator.value;
  }
  return;
}

/** Variantes repliables de la graphie visée, jamais calculées pour un autre type. */
function spellingVariants(locator: Locator): string[] {
  const value = spellingValue(locator);
  return value === undefined ? [] : typographicVariants(value);
}

/** Construction du locator pour une graphie de la même famille que le locator visé. */
function spellingBuilder(locator: Locator): string {
  switch (locator.by) {
    case "role":
      return `(name) => page.getByRole(${JSON.stringify(locator.value)}, { name: name, exact: true })`;
    case "text":
      return "(name) => page.getByText(name, { exact: true })";
    case "placeholder":
      return "(name) => page.getByPlaceholder(name, { exact: true })";
    default:
      throw new Error("Unsupported locator");
  }
}

/** Famille nommée dans l'échec d'ambiguïté, pour que la cause soit lisible sans le script. */
function spellingLabel(locator: Locator): string {
  switch (locator.by) {
    case "role":
      return `accessible name (role ${JSON.stringify(locator.value)})`;
    case "text":
    case "placeholder":
      return locator.by;
    default:
      throw new Error("Unsupported locator");
  }
}

/**
 * Appel Playwright sur le contrôle visé, `call` étant un suffixe de méthode
 * (`click({ timeout: 10000 })`). Un locator `by:"label"` reçoit le repli par nom
 * accessible, un locator `by:"role"` le repli par graphie du nom `name`, les
 * autres sont appelés directement.
 *
 * `mode` dit ce que l'appel fait d'un locator vide : une action ou une lecture
 * qui lève (`click`, `innerText`) est rejouée sur le repli après l'échec de la
 * graphie exacte, alors qu'une lecture qui mesure (`isVisible`) doit résoudre la
 * graphie exposée d'abord — un locator vide y rend false sans jamais lever.
 */
export function locatorCall(
  locator: Locator,
  call: string,
  mode: "act" | "measure" = "act"
): string {
  if (locator.by === "label") {
    const { strict, fallback } = labelTargets(locator.value);
    const read = `(locator) => locator.${call}`;
    return mode === "measure"
      ? `readLabel(${strict}, ${fallback}, ${read})`
      : `resolveLabel(${strict}, ${fallback}, ${read})`;
  }
  const read = `(locator) => locator.${call}`;
  const names = spellingVariants(locator);
  if (mode === "measure" && names.length > 0) {
    // La lecture reçoit aussi la graphie du plan et sa famille : c'est ce que
    // l'échec d'ambiguïté nomme, faute de pouvoir désigner une seule graphie.
    const planned = JSON.stringify(spellingValue(locator));
    return `readSpelling(${locatorExpression(locator)}, ${spellingBuilder(locator)}, ${JSON.stringify(spellingLabel(locator))}, ${JSON.stringify(names)}, ${planned}, ${read})`;
  }
  return nameFallback(locator, read) ?? `${locatorExpression(locator)}.${call}`;
}

/**
 * Lecture d'une assertion `count` : la multiplicité est le sujet, donc aucune
 * unicité n'est exigée. Le total additionne les graphies du même signe, et un
 * compte qui ne tombe pas juste reste une assertion fausse, pas une ambiguïté.
 */
export function locatorCount(locator: Locator): string {
  if (locator.by === "label") {
    const { strict, fallback } = labelTargets(locator.value);
    return `readLabel(${strict}, ${fallback}, (locator) => locator.count())`;
  }
  const names = spellingVariants(locator);
  return names.length === 0
    ? `${locatorExpression(locator)}.count()`
    : `countSpelling(${locatorExpression(locator)}, ${spellingBuilder(locator)}, ${JSON.stringify(names)})`;
}

/**
 * Repli typographique d'un locator role+nom : `undefined` quand le nom ne porte
 * aucun signe repliable, ou quand ses variantes dépassent le plafond.
 */
function nameFallback(locator: Locator, act: string): string | undefined {
  if (locator.by !== "role") {
    return;
  }
  const names = typographicVariants(locator.name);
  return names.length === 0
    ? undefined
    : `resolveName(${locatorExpression(locator)}, ${JSON.stringify(locator.value)}, ${JSON.stringify(names)}, ${act})`;
}

/**
 * Même repli, pour un corps de plusieurs instructions : `body` manipule le
 * locator reçu sous le nom `locator`.
 */
function locatorRun(locator: Locator, body: string): string {
  if (locator.by === "label") {
    const { strict, fallback } = labelTargets(locator.value);
    return `resolveLabel(${strict}, ${fallback}, async (locator) => { ${body} })`;
  }
  return (
    nameFallback(locator, `async (locator) => { ${body} }`) ??
    `(async (locator) => { ${body} })( ${locatorExpression(locator)} )`
  );
}

export function locatorExpression(locator: Locator): string {
  const value = JSON.stringify(locator.value);
  switch (locator.by) {
    case "css":
      return `page.locator(${value})`;
    case "role":
      return `page.getByRole(${value}, { name: ${JSON.stringify(locator.name)}, exact: true })`;
    case "text":
      return `page.getByText(${value}, { exact: true })`;
    case "label":
      return labelTargets(locator.value).strict;
    case "placeholder":
      return `page.getByPlaceholder(${value}, { exact: true })`;
    case "testId":
      return `page.getByTestId(${value})`;
    default:
      throw new Error("Unsupported locator");
  }
}

export function assertionMatches(
  assertion: Assertion,
  actual: unknown
): boolean {
  if (assertion.kind === "visible") {
    return actual === true;
  }
  if (assertion.kind === "hidden") {
    return actual === false;
  }
  if (assertion.kind === "text") {
    return (
      typeof actual === "string" &&
      actual
        .replace(/\s+/g, " ")
        .trim()
        .includes(assertion.expected.replace(/\s+/g, " ").trim())
    );
  }
  return actual === assertion.expected;
}

function readAssertion(assertion: Assertion, locator?: Locator): string {
  if (assertion.kind === "visual") {
    if (!locator) {
      throw new Error("Visual assertion requires target");
    }
    return `Buffer.from(await ${locatorCall(locator, `screenshot({ animations: "disabled", timeout: 5000 })`)}).toString("base64")`;
  }
  if (assertion.kind === "url") {
    return "page.url()";
  }
  if (!locator) {
    throw new Error("A locator is required for this assertion");
  }
  switch (assertion.kind) {
    case "text":
      return `await ${locatorCall(locator, "innerText({ timeout: 5000 })")}`;
    case "value":
      return `await ${locatorCall(locator, "inputValue({ timeout: 5000 })")}`;
    case "count":
      return `await ${locatorCount(locator)}`;
    default:
      return `await ${locatorCall(locator, "isVisible()", "measure")}`;
  }
}
function compileAssertion(
  action: Extract<Action, { type: "assert" }>,
  assertion?: Assertion
): string {
  if (!assertion || assertion.id !== action.assertionId) {
    throw new Error("Unknown planned assertion");
  }
  const read = readAssertion(assertion, action.locator);
  if (assertion.kind === "visual") {
    return `actual = ${read};`;
  }
  const expected =
    "expected" in assertion ? assertion.expected : assertion.kind === "visible";
  const matches =
    assertion.kind === "text"
      ? `typeof actual === "string" && actual.replace(/\\s+/g, " ").trim().includes(${JSON.stringify(String(expected).replace(/\s+/g, " ").trim())})`
      : `actual === ${JSON.stringify(expected)}`;
  return `for (let attempt = 0; attempt < 30; attempt++) { actual = ${read}; if (${matches}) break; await page.waitForTimeout(100); }`;
}
export function compileProbe(
  assertion: Assertion,
  preview: string,
  reload = false
): string {
  const read = readAssertion(assertion, assertion.target);
  return compileAction({ type: "observe" }, preview).replace(
    "let actual;",
    `let actual; ${reload ? 'await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });' : ""} actual = ${read};`
  );
}
function compileInteraction(action: Action): string {
  if (!("locator" in action && action.locator)) {
    throw new Error("Not a browser action");
  }
  switch (action.type) {
    case "click":
      return `await ${locatorCall(action.locator, "click({ timeout: 10000 })")};`;
    case "fill":
      return `await ${locatorCall(action.locator, `fill(${JSON.stringify(action.value)}, { timeout: 10000 })`)};`;
    case "press":
      return `await ${locatorCall(action.locator, `press(${JSON.stringify(action.key)}, { timeout: 10000 })`)};`;
    case "select":
      return `await ${locatorCall(action.locator, `selectOption(${JSON.stringify(action.value)}, { timeout: 10000 })`)};`;
    case "check":
      return `await ${locatorCall(action.locator, `setChecked(${action.checked}, { timeout: 10000 })`)};`;
    default:
      throw new Error("Unsupported browser action");
  }
}
export interface CompileOptions {
  /**
   * Budget de l'instantané joint comme évidence de validation du plan. Le même
   * relevé alimente l'instantané du modèle, tronqué à MODEL_SNAPSHOT_CHARS.
   */
  evidenceSnapshotChars?: number;
}
export function compileAction(
  action: Action,
  previewUrl: string,
  assertion?: Assertion,
  options: CompileOptions = {}
): string {
  const preview = new URL(previewUrl);
  let command = "";
  if (action.type === "goto") {
    const target = new URL(action.path, preview);
    if (
      target.origin !== preview.origin ||
      target.username ||
      target.password
    ) {
      throw new Error("Navigation must remain on the preview origin");
    }
    command = `await page.goto(${JSON.stringify(target.href)}, { waitUntil: "domcontentloaded", timeout: 15000 });`;
  } else if (action.type === "download") {
    command = `await ${locatorRun(
      action.locator,
      `const waiting = page.waitForEvent("download", { timeout: 10000 });
await locator.click({ timeout: 10000 });
const download = await waiting;
if (await download.failure()) throw new Error("Download failed");
actual = download.suggestedFilename();`
    )};`;
  } else if (action.type === "popup") {
    command = `await ${locatorRun(
      action.locator,
      `const waiting = page.waitForEvent("popup", { timeout: 10000 });
await locator.click({ timeout: 10000 });
const popup = await waiting;
await popup.waitForLoadState("domcontentloaded");
actual = popup.url();
provenanceUrls.push(actual);
if (!actual.startsWith(${JSON.stringify(`${preview.origin}/`)})) throw new Error("Popup left approved origin");
await popup.close();`
    )};`;
  } else if (action.type === "assert") {
    command = compileAssertion(action, assertion);
  } else if (action.type !== "observe") {
    command = compileInteraction(action);
  }
  // Un seul relevé de l'arbre d'accessibilité : l'instantané du modèle reste
  // tronqué comme avant, l'évidence de validation du plan est jointe à part.
  const evidence = options.evidenceSnapshotChars
    ? `, evidence: ariaSnapshot.slice(0, ${options.evidenceSnapshotChars})`
    : "";
  return `const page = await browser.getPage("qa");
let targetName;
let actual;
const provenanceUrls = [];
${RESOLVE_LABEL_HELPER}
${RESOLVE_LABEL_READ_HELPER}
${RESOLVE_NAME_HELPER}
${RESOLVE_SPELLING_READ_HELPER}
${RESOLVE_SPELLING_COUNT_HELPER}
${command}
const url = page.url();
if (url !== "about:blank" && !url.startsWith(${JSON.stringify(`${preview.origin}/`)})) throw new Error("Page left the allowed preview origin");
const ariaSnapshot = (await page.snapshotForAI({ depth: 12 })).full;
console.log(${JSON.stringify(MARKER)} + JSON.stringify({ url, snapshot: ariaSnapshot.slice(0, ${MODEL_SNAPSHOT_CHARS})${evidence}, actual, targetName, provenanceUrls }));`;
}

export class Canary {
  private readonly config: Config;
  constructor(config: Config) {
    this.config = config;
  }
  command(
    args: string[],
    script?: string
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    if (
      args[0] === "session" &&
      ["end", "abort"].includes(args[1] ?? "") &&
      runScope.getStore()
    ) {
      return runScope.exit(() => this.command(args, script));
    }
    checkBudget();
    if (this.config.QA_BROWSER_SERVICE_URL) {
      return fetchText(
        `${this.config.QA_BROWSER_SERVICE_URL}/command`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.QA_BROWSER_SERVICE_TOKEN}`,
          },
          body: JSON.stringify({ args, script }),
        },
        (this.config.QA_STEP_TIMEOUT_SECONDS + 45) * 1000
      ).then((r) =>
        z
          .object({ code: z.number(), stdout: z.string(), stderr: z.string() })
          .parse(JSON.parse(r.text))
      );
    }
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [this.config.CANARY_CLI_PATH, "--json", ...args],
        {
          stdio: ["pipe", "pipe", "pipe"],
          env: browserEnvironment(this.config),
        }
      );
      const signal = runScope.getStore()?.signal;
      const cancel = () => child.kill("SIGKILL");
      signal?.addEventListener("abort", cancel, { once: true });
      let stdout = "";
      let stderr = "";
      let exceeded = false;
      const timer = setTimeout(
        () => {
          exceeded = true;
          child.kill("SIGKILL");
        },
        (this.config.QA_STEP_TIMEOUT_SECONDS + 30) * 1000
      );
      const collect = (channel: "stdout" | "stderr", data: Buffer) => {
        if (channel === "stdout") {
          stdout += data.toString();
        } else {
          stderr += data.toString();
        }
        if (stdout.length + stderr.length > 4_000_000) {
          exceeded = true;
          child.kill("SIGKILL");
        }
      };
      child.stdout.on("data", (data: Buffer) => collect("stdout", data));
      child.stderr.on("data", (data: Buffer) => collect("stderr", data));
      child.stdin.on("error", () => {
        /* child may fail before consuming stdin */
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        if (exceeded) {
          reject(
            new QaError(
              "CANARY_COMMAND_LIMIT",
              "Canary command timed out or exceeded output budget",
              "Run doctor and inspect ~/.canary/daemon.log. Check Chromium resources and timeout settings before increasing limits."
            )
          );
        } else {
          resolve({ code: code ?? 1, stdout, stderr });
        }
      });
      child.stdin.end(script);
    });
  }
  async start(name: string, auth?: BrowserAuth): Promise<string> {
    const result = await this.command(
      [
        "session",
        "start",
        "--headless",
        "--name",
        name.slice(0, 180),
        "--network-hosts",
        // The Canary CLI takes the list as one comma-separated argument.
        // `applyPreviewHosts` keeps this string and `allowedHosts` in sync, so a
        // dashboard list reaches the session policy without a restart.
        this.config.PREVIEW_ALLOWED_HOSTS,
        ...(this.config.QA_ALLOW_PRIVATE_PREVIEWS === "true"
          ? ["--allow-private"]
          : []),
        ...(auth ? ["--auth-stdin"] : []),
      ],
      auth ? JSON.stringify(auth) : undefined
    );
    if (result.code !== 0) {
      throw new QaError(
        "CANARY_START_FAILED",
        `Canary session start failed: ${result.stderr.slice(-2000)}`,
        "Run doctor, inspect ~/.canary/daemon.log and verify the installed Chromium/runtime, its system libraries and session volume permissions. Rebuild the supplied image for missing dependencies."
      );
    }
    return z.object({ sessionId: z.string() }).parse(JSON.parse(result.stdout))
      .sessionId;
  }
  async act(id: string, label: string, script: string): Promise<Observation> {
    const result = await this.command(
      [
        "run",
        "--session",
        id,
        "--step",
        label,
        "--timeout",
        String(this.config.QA_STEP_TIMEOUT_SECONDS),
      ],
      script
    );
    if (result.code !== 0) {
      throw new Error(`Canary action failed: ${result.stderr.slice(-2000)}`);
    }
    const line = result.stdout
      .split("\n")
      .find((item) => item.startsWith(MARKER));
    if (!line) {
      throw new Error(
        "Canary returned no observation; refusing unverified action"
      );
    }
    const observation = observationSchema.parse(
      JSON.parse(line.slice(MARKER.length))
    );
    if (observation.targetName) {
      // Le plan vise un nom, la page en expose un autre : la substitution est
      // une preuve du run, elle ne peut pas rester tacite.
      logger.info(
        {
          runId: runScope.getStore()?.id,
          step: label,
          name: observation.targetName,
        },
        "Nom accessible résolu par repli typographique"
      );
    }
    const sha = runScope.getStore()?.previewSha;
    if (sha) {
      for (const url of new Set([
        observation.url,
        ...(observation.provenanceUrls ?? []),
      ])) {
        if (url.startsWith("http")) {
          await verifyPreviewUrl(url, sha, this.config);
        }
      }
    }
    return observation;
  }
  async end(id: string, destination: string): Promise<string[]> {
    const result = await this.command(["session", "end", id]);
    if (result.code !== 0) {
      await this.command(["session", "abort", id]).catch(() => undefined);
      await this.purge(id).catch(() => undefined);
      throw new Error(
        `Canary could not finalize evidence: ${result.stderr.slice(-1000)}`
      );
    }
    const data = z
      .object({
        artifactsDir: z.string(),
        artifacts: z.array(
          z.object({ kind: z.string(), path: z.string(), bytes: z.number() })
        ),
      })
      .parse(JSON.parse(result.stdout));
    const videos = data.artifacts.filter(
      (artifact) => artifact.kind === "video" && artifact.bytes > 0
    );
    if (!videos.length) {
      throw new QaError(
        "EVIDENCE_VIDEO_MISSING",
        "Canary produced no non-empty video; evidence is incomplete",
        "Check daemon.log, free space, ffmpeg/browser installation and session finalization. This run cannot be passed without a recorded video."
      );
    }
    if (
      !(
        data.artifacts.some(
          (artifact) => artifact.kind === "trace" && artifact.bytes > 0
        ) &&
        data.artifacts.some(
          (artifact) => artifact.kind === "screenshot" && artifact.bytes > 0
        )
      )
    ) {
      throw new Error("Canary produced no complete trace/screenshot evidence");
    }
    await mkdir(destination, { recursive: true });
    // Never export browser profiles, cookies databases or arbitrary files from ~/.canary.
    const files = [
      "report.html",
      "results.json",
      ...data.artifacts.map((artifact) =>
        artifact.path.slice(data.artifactsDir.length + 1)
      ),
    ];
    for (const file of files) {
      if (file.includes("..") || !file || file.startsWith("/")) {
        throw new Error("Unsafe Canary artifact path");
      }
      const source = join(data.artifactsDir, file);
      await mkdir(join(destination, file, ".."), { recursive: true });
      await cp(source, join(destination, file));
    }
    const copied = await listFiles(destination);
    await this.purge(id);
    return copied;
  }
  async purge(id: string) {
    if (!/^(?!.*\.\.)[A-Za-z0-9._-]{1,128}$/.test(id)) {
      throw new Error("Invalid session ID for purge");
    }
    if (this.config.QA_BROWSER_SERVICE_URL) {
      await runScope.exit(() => this.command(["purge", id]));
      return;
    }
    const root = join(homedir(), ".canary", "sessions");
    const path = join(root, id);
    const actual = await realpath(path).catch(() => path);
    if (relative(root, actual).startsWith("..")) {
      throw new Error("Session symlink escaped root");
    }
    await rm(path, { recursive: true, force: true });
  }
  async abort(id: string) {
    await this.command(["session", "abort", id]).catch(() => undefined);
    await this.purge(id).catch(() => undefined);
  }
}

async function listFiles(directory: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    if ((await stat(path)).isDirectory()) {
      files.push(...(await listFiles(path, `${prefix}${basename(name)}/`)));
    } else {
      files.push(`${prefix}${name}`);
    }
  }
  return files;
}

export function browserEnvironment(config: Config): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "HOME",
    "TMPDIR",
    "NODE_USE_ENV_PROXY",
    "PLAYWRIGHT_BROWSERS_PATH",
    "CANARY_DAEMON_PORT",
    "CANARY_DAEMON_TOKEN",
    "CANARY_LOG_LEVEL",
    "CANARY_EGRESS_PROXY",
  ];
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    allowed.flatMap((key) =>
      process.env[key] ? [[key, process.env[key]]] : []
    )
  );
  env.CANARY_NETWORK_ALLOWED_HOSTS = config.PREVIEW_ALLOWED_HOSTS;
  env.CANARY_NETWORK_ALLOW_PRIVATE = config.QA_ALLOW_PRIVATE_PREVIEWS;
  return env;
}
