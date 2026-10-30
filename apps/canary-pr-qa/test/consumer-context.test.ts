import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { consumerContext } from "../src/consumer-context.js";
import { GitHub } from "../src/github.js";
import { contextSchema } from "../src/replay.js";

/**
 * Le cas structurel d'un incident réel, sur un dépôt inventé : un « refactor »
 * d'une ligne inverse le signe d'une valeur calculée dans un module pur ; le
 * seul écran qui l'affiche n'est pas dans le diff. Le planificateur doit
 * recevoir l'écran (libellé, formatage, contrôles) et le test qui fixe le signe.
 *
 * Tout passe par `consumerContext`, le seul point d'entrée du module, avec un
 * lecteur en mémoire à la place de l'API GitHub.
 */
const MODULE = [
  "export interface Diff { readonly delta: number }", // 1
  "", // 2
  "export function rawDelta(a: number, b: number): number {", // 3
  "  return a - b;", // 4
  "}", // 5
  "", // 6
  "export function assess(input: { measured: number; planned: number }): Diff {", // 7
  "  const delta = input.planned - input.measured;", // 8
  "  return { delta };", // 9
  "}", // 10
  "", // 11
  "export const UNITS = [1, 2, 5];", // 12
].join("\n");

// La ligne 8 du nouveau fichier est la seule changée.
const PATCH = [
  "@@ -6,5 +6,5 @@ export function rawDelta(a: number, b: number): number {",
  " ",
  " export function assess(input: { measured: number; planned: number }): Diff {",
  "-  const delta = rawDelta(input.measured, input.planned);",
  "+  const delta = input.planned - input.measured;",
  "   return { delta };",
  " }",
].join("\n");

const SCREEN = [
  'import { useState } from "react";',
  "import {",
  "  assess,",
  "  UNITS,",
  '} from "@acme/core";',
  "",
  "export function Header() {",
  "  return <h1>Home</h1>;",
  "}",
  "",
  "function Totals({ planned }: { planned: number }) {",
  "  const [measured] = useState(0);",
  "  const result = assess({ measured, planned });",
  "  return <aside>",
  "    <p>Delta, measured minus planned</p>",
  "    <p>{format(result.delta)}</p>",
  "  </aside>;",
  "}",
  "",
  "export default function Page() {",
  "  return <Totals planned={1240} />;",
  "}",
].join("\n");

const SPEC = [
  'import { assess } from "../core";',
  "",
  'describe("assess", () => {',
  '  it("is negative on a shortage", () => {',
  "    expect(assess({ measured: 1200, planned: 1240 }).delta).toBe(-40);",
  "  });",
  "});",
].join("\n");

const MANIFEST = JSON.stringify({
  name: "@acme/core",
  exports: { ".": "./src/index.ts" },
});

function repository(extra: Record<string, string> = {}) {
  return new Map<string, string>(
    Object.entries({
      "packages/core/package.json": MANIFEST,
      "packages/core/src/core.ts": MODULE,
      "packages/core/src/index.ts": 'export * from "./core";\n',
      "packages/core/src/__tests__/core.spec.ts": SPEC,
      "ui/app/page.tsx": SCREEN,
      // Importe le paquet, mais aucun symbole touché : ce n'est pas un consommateur.
      "ui/app/other.tsx":
        'import { UNITS } from "@acme/core";\nexport const n = UNITS.length;\n',
      ...extra,
    })
  );
}

/** Un dépôt en mémoire : l'arbre et les fichiers, avec le journal des lectures. */
function reader(files: Map<string, string>) {
  const reads: string[] = [];
  return {
    reads,
    read: {
      tree: () => {
        reads.push("tree");
        return Promise.resolve({
          tree: [...files].map(([path, text]) => ({
            path,
            size: text.length,
            type: "blob",
          })),
        });
      },
      file: (path: string) => {
        reads.push(path);
        return Promise.resolve(files.get(path));
      },
    },
  };
}

function search(
  files: Map<string, string>,
  changed: { filename: string; patch?: string }[],
  budget = 20_000
) {
  return consumerContext({
    budget,
    files: changed,
    maxFiles: 400,
    read: reader(files).read,
    ref: "head",
  });
}

const CHANGED = [{ filename: "packages/core/src/core.ts", patch: PATCH }];

describe("consommateurs d'un symbole touché", () => {
  it("trouve l'écran par le nom de paquet et le barrel, et le test par l'import relatif", async () => {
    const { consumers, warnings } = await search(repository(), CHANGED);
    expect(warnings).toEqual([]);
    // Code applicatif d'abord, test ensuite ; ni le barrel, ni other.tsx.
    expect(consumers.map((item) => item.path)).toEqual([
      "ui/app/page.tsx",
      "packages/core/src/__tests__/core.spec.ts",
    ]);
    const screen = consumers[0];
    // Seul l'export dont la déclaration contient la ligne changée (8) est retenu.
    expect(screen?.symbols).toEqual(["assess"]);
    expect(screen?.imports).toBe("packages/core/src/core.ts");
    // La déclaration entière qui utilise le symbole : le libellé rendu y est.
    expect(screen?.excerpts).toHaveLength(1);
    expect(screen?.excerpts[0]?.startLine).toBe(11);
    expect(screen?.excerpts[0]?.endLine).toBe(18);
    expect(screen?.excerpts[0]?.text).toContain(
      "Delta, measured minus planned"
    );
    expect(screen?.excerpts[0]?.text).not.toContain("<h1>Home</h1>");
    expect(consumers[1]?.excerpts[0]?.text).toContain("toBe(-40)");
  });

  it("une ligne changée hors de tout export retient tous les exports", async () => {
    const between = [
      "@@ -1,3 +1,3 @@",
      " export interface Diff { readonly delta: number }",
      "-",
      "+ ",
      " export function rawDelta(a: number, b: number): number {",
    ].join("\n");
    const { consumers } = await search(repository(), [
      { filename: "packages/core/src/core.ts", patch: between },
    ]);
    // La valeur peut sortir par n'importe quel export : other.tsx (UNITS) entre.
    const other = consumers.find((item) => item.path === "ui/app/other.tsx");
    expect(other?.symbols).toEqual(["UNITS"]);
    // page.tsx n'écrit UNITS que dans son import : seul `assess` y est un usage.
    expect(
      consumers.find((item) => item.path === "ui/app/page.tsx")?.symbols
    ).toEqual(["assess"]);
  });

  it("n'ajoute pas un fichier modifié : le diff le porte déjà", async () => {
    const { consumers } = await search(repository(), [
      ...CHANGED,
      { filename: "ui/app/page.tsx" },
    ]);
    expect(consumers.map((item) => item.path)).toEqual([
      "packages/core/src/__tests__/core.spec.ts",
    ]);
  });

  it("nomme ce que le budget a coupé au lieu de le taire", async () => {
    const { consumers, warnings } = await search(repository(), CHANGED, 220);
    const spent = consumers
      .flatMap((item) => item.excerpts)
      .reduce((sum, excerpt) => sum + excerpt.text.length, 0);
    expect(spent).toBeLessThanOrEqual(220);
    // L'écran (plus long) ne tient pas ; le test, examiné ensuite, tient.
    expect(consumers.map((item) => item.path)).toEqual([
      "packages/core/src/__tests__/core.spec.ts",
    ]);
    expect(warnings).toEqual([
      "Consumer context budget exhausted: 1 excerpt(s) of ui/app/page.tsx omitted",
    ]);
  });

  it("résout un alias paths de tsconfig", async () => {
    const { consumers } = await search(
      new Map([
        [
          "ui/tsconfig.json",
          '{ // commentaire\n "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./*"] } } }',
        ],
        ["ui/lib/core.ts", MODULE],
        ["ui/app/page.tsx", SCREEN.replace("@acme/core", "@/lib/core")],
      ]),
      [{ filename: "ui/lib/core.ts", patch: PATCH }]
    );
    expect(consumers.map((item) => item.path)).toEqual(["ui/app/page.tsx"]);
  });

  it("ignore l'usage écrit dans la ligne d'import elle-même", async () => {
    const { consumers } = await search(
      repository({
        "ui/app/imports-only.tsx":
          'import { assess } from "@acme/core";\nexport const y = 1;\n',
      }),
      CHANGED
    );
    expect(consumers.map((item) => item.path)).not.toContain(
      "ui/app/imports-only.tsx"
    );
  });

  it("un budget nul ne lit rien, pas même l'arbre", async () => {
    const memory = reader(repository());
    const found = await consumerContext({
      budget: 0,
      files: CHANGED,
      maxFiles: 400,
      read: memory.read,
      ref: "head",
    });
    expect(found).toEqual({ consumers: [], warnings: [] });
    expect(memory.reads).toEqual([]);
  });
});

/**
 * Le cas réel : la tête de la PR mesurée (un diff d'une ligne qui inverse le
 * signe d'un écart dans un module de domaine pur). Sous-ensemble minimal du
 * dépôt à la révision de tête : le module modifié, son barrel, l'écran qui le
 * consomme, son test et les manifestes qui résolvent le nom de paquet.
 */
const here = import.meta.dirname;
const pr21 = JSON.parse(
  gunzipSync(
    readFileSync(join(here, "historical", "pr21-consumers.json.gz"))
  ).toString()
) as {
  changed: { filename: string; patch?: string; status: string }[];
  files: Record<string, string>;
  ref: string;
};
const pr21Files = new Map(Object.entries(pr21.files));

describe("PR réelle : l'écran et le test qui fixent le signe de l'écart", () => {
  it("trouve exactement l'écran et le test, avec le libellé et l'oracle signé", async () => {
    const { consumers, warnings } = await consumerContext({
      budget: 24_000,
      files: pr21.changed,
      maxFiles: 400,
      read: reader(pr21Files).read,
      ref: pr21.ref,
    });
    expect(warnings).toEqual([]);
    expect(
      consumers.map((item) => [
        item.path,
        item.excerpts.map((excerpt) => [excerpt.startLine, excerpt.endLine]),
      ])
    ).toEqual([
      ["apps/web/app/page.tsx", [[340, 395]]],
      ["packages/domain/src/__tests__/cash.spec.ts", [[79, 109]]],
    ]);
    const text = consumers
      .flatMap((item) => item.excerpts)
      .map((excerpt) => excerpt.text)
      .join("\n");
    expect(text).toContain("Écart, compté − attendu");
    expect(text).toContain("formatAmountFr(centsToEuros(variance))");
    expect(text).toContain("toBe(-4_000)");
  });
});

describe("GitHub.context : la recherche ne prend que le budget laissé", () => {
  const PR = "https://github.com/acme/shop/pull/21";
  const HEAD = "c".repeat(40);
  const BASE = "b".repeat(40);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function stub(github: GitHub) {
    const paths: string[] = [];
    vi.spyOn(github, "request").mockImplementation((path: string) => {
      paths.push(path);
      if (path === "/repos/acme/shop/pulls/21") {
        return Promise.resolve({
          title: "refactor",
          body: null,
          state: "open",
          changed_files: pr21.changed.length,
          head: { sha: HEAD, repo: { full_name: "acme/shop" } },
          base: { sha: BASE, repo: { full_name: "acme/shop" } },
        });
      }
      if (path.startsWith("/repos/acme/shop/pulls/21/files")) {
        return Promise.resolve(pr21.changed);
      }
      if (path.startsWith(`/repos/acme/shop/git/trees/${HEAD}`)) {
        return Promise.resolve({
          tree: [...pr21Files].map(([file, text]) => ({
            path: file,
            size: text.length,
            type: "blob",
          })),
        });
      }
      const file = /^\/repos\/acme\/shop\/contents\/(.+)\?ref=/.exec(path)?.[1];
      const text = file ? pr21Files.get(decodeURIComponent(file)) : undefined;
      return text === undefined
        ? Promise.reject(new Error("HTTP 404"))
        : Promise.resolve({
            encoding: "base64",
            content: Buffer.from(text).toString("base64"),
          });
    });
    return paths;
  }

  it("contexte de dépendances épuisé (cas de la PR 20) : aucun arbre lu, aucun champ consumers", async () => {
    // Les deux révisions du module modifié dépassent à elles seules 10 000
    // caractères : le budget de consommateurs est nul.
    const github = new GitHub(
      loadConfig({ QA_CONTEXT_CHARS: "10000", QA_DATA_DIR: tmpdir() })
    );
    const paths = stub(github);
    const context = await github.context(PR);
    expect(
      context.context.reduce((sum, item) => sum + item.content.length, 0)
    ).toBe(10_000);
    expect(paths.some((path) => path.includes("/git/trees/"))).toBe(false);
    expect("consumers" in context).toBe(false);
  });

  it("budget disponible : l'arbre est lu une fois et les deux consommateurs arrivent", async () => {
    const github = new GitHub(loadConfig({ QA_DATA_DIR: tmpdir() }));
    const paths = stub(github);
    const context = await github.context(PR);
    expect(paths.filter((path) => path.includes("/git/trees/"))).toEqual([
      `/repos/acme/shop/git/trees/${HEAD}?recursive=1`,
    ]);
    expect(context.consumers?.map((item) => item.path)).toEqual([
      "apps/web/app/page.tsx",
      "packages/domain/src/__tests__/cash.spec.ts",
    ]);
    // Un rejeu relit le matériel que le run avait reçu, sans en perdre un mot.
    expect(contextSchema.parse(context).consumers).toEqual(context.consumers);
  });
});
