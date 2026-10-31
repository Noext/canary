import { unlink } from "node:fs/promises";
import net from "node:net";

/**
 * Prise du socket Unix du démon sans jamais le voler à un démon vivant.
 *
 * Le démarrage supprimait le socket existant puis écoutait dessus. Deux
 * commandes `canary` lancées ensemble au premier usage démarraient donc deux
 * démons : le second supprimait le socket du premier, qui continuait de tourner
 * injoignable avec ses sessions, ses navigateurs et leurs ffmpeg. Mesuré le
 * 31 octobre 2026 sur le runner CI : un démon orphelin de 10 jours portant 42
 * `chrome-headless` et 232 `ffmpeg`, et des tests E2E dont la session
 * disparaissait (« no longer active on the daemon ») dès qu'un HOME neuf
 * rendait la course visible.
 */
export type SocketClaim = "listening" | "owned-by-another";

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

/** Écoute sur `path` ; rejette sur l'erreur de `listen` sans laisser d'écouteur. */
export function listenOn(server: net.Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ path });
  });
}

/**
 * Vrai quand un processus accepte une connexion sur ce socket. Un délai écoulé
 * compte comme vivant : dans le doute, on ne vole pas le socket.
 */
export function socketAnswers(
  path: string,
  timeoutMs = 1000
): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect({ path });
    const settle = (alive: boolean) => {
      probe.destroy();
      resolve(alive);
    };
    probe.setTimeout(timeoutMs, () => settle(true));
    probe.once("connect", () => settle(true));
    probe.once("error", () => settle(false));
  });
}

/**
 * Prend le socket : écoute directement, et seulement si l'adresse est occupée,
 * distingue un démon vivant (on le laisse servir) d'un fichier périmé (supprimé
 * avant une seconde tentative).
 */
export async function claimUnixSocket(
  server: net.Server,
  path: string
): Promise<SocketClaim> {
  try {
    await listenOn(server, path);
    return "listening";
  } catch (error) {
    if (errorCode(error) !== "EADDRINUSE") {
      throw error;
    }
  }
  if (await socketAnswers(path)) {
    return "owned-by-another";
  }
  try {
    await unlink(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
  }
  await listenOn(server, path);
  return "listening";
}
