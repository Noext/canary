import { describe, expect, it } from "vitest";
import { changedFileTexts } from "../src/plan-evidence.js";

const FILES = [
  { changes: 4, filename: "apps/web/lib/small.ts" },
  { changes: 40, filename: "apps/web/app/page.tsx" },
];

/** Un lecteur qui garde la trace des chemins demandés, dans l'ordre. */
function reader(contents: Record<string, string | undefined>) {
  const asked: string[] = [];
  return {
    asked,
    read: (path: string) => {
      asked.push(path);
      return Promise.resolve(contents[path]);
    },
  };
}

describe("les fichiers modifiés, en entier, pour la planification", () => {
  it("trie sur le poids réel quand `changes` manque", async () => {
    const { read } = reader({
      "apps/web/app/page.tsx": "big",
      "apps/web/lib/small.ts": "small",
    });
    const texts = await changedFileTexts(
      [
        { additions: 1, deletions: 0, filename: "apps/web/lib/small.ts" },
        { additions: 40, deletions: 12, filename: "apps/web/app/page.tsx" },
      ],
      read,
      10_000
    );
    expect(texts.map((text) => text.path)).toEqual([
      "apps/web/app/page.tsx",
      "apps/web/lib/small.ts",
    ]);
  });

  it("donne le contenu entier, le plus modifié d'abord", async () => {
    const { read } = reader({
      "apps/web/app/page.tsx": "export const page = 1;",
      "apps/web/lib/small.ts": "export const small = 2;",
    });
    const texts = await changedFileTexts(FILES, read, 10_000);
    expect(texts.map((text) => text.path)).toEqual([
      "apps/web/app/page.tsx",
      "apps/web/lib/small.ts",
    ]);
    expect(texts[0]?.content).toBe("export const page = 1;");
  });

  it("omet un fichier que la PR supprime, sans interrompre les autres", async () => {
    const { read } = reader({ "apps/web/lib/small.ts": "export const x = 2;" });
    const texts = await changedFileTexts(FILES, read, 10_000);
    expect(texts).toEqual([
      { content: "export const x = 2;", path: "apps/web/lib/small.ts" },
    ]);
  });

  it("omet un fichier binaire au lieu de le rendre illisible", async () => {
    const { read } = reader({
      "apps/web/app/page.tsx": "PNG\u0000\u0001binary",
      "apps/web/lib/small.ts": "export const x = 2;",
    });
    const texts = await changedFileTexts(FILES, read, 10_000);
    expect(texts.map((text) => text.path)).toEqual(["apps/web/lib/small.ts"]);
  });

  it("omet le fichier qui ne tient pas entier plutôt que de le tronquer", async () => {
    const { asked, read } = reader({
      "apps/web/app/page.tsx": "x".repeat(80),
      "apps/web/lib/small.ts": "y".repeat(80),
    });
    const texts = await changedFileTexts(FILES, read, 100);
    // 80 tient, 20 de reste ne suffisent pas pour l'autre : il est omis, jamais
    // coupé — un fichier tronqué se présenterait comme disponible.
    expect(texts).toEqual([
      { content: "x".repeat(80), path: "apps/web/app/page.tsx" },
    ]);
    expect(asked).toHaveLength(2);
  });

  it("ne lève pas quand la lecture échoue, et continue", async () => {
    const texts = await changedFileTexts(
      FILES,
      (path) =>
        path === "apps/web/app/page.tsx"
          ? Promise.reject(new Error("HTTP 404"))
          : Promise.resolve("export const x = 2;"),
      10_000
    );
    expect(texts.map((text) => text.path)).toEqual(["apps/web/lib/small.ts"]);
  });
});
