import { harnessProcess, markStopping } from "./harness-process";

/** Grace given to the harness to close its servers before it is killed. */
const STOP_TIMEOUT_MS = 15_000;

export default async function globalTeardown(): Promise<void> {
  const child = harnessProcess();
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  markStopping();
  const stopped = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  child.kill("SIGTERM");
  const failSafe = setTimeout(() => child.kill("SIGKILL"), STOP_TIMEOUT_MS);
  await stopped;
  clearTimeout(failSafe);
}
