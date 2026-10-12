import type { ChildProcess } from "node:child_process";

/**
 * The harness process started by the global setup, kept here so the global
 * teardown (a separate module of the same Playwright process) stops exactly
 * what the setup started.
 */
let running: ChildProcess | undefined;
let stopping = false;

export function setHarnessProcess(child: ChildProcess): void {
  running = child;
}

export function harnessProcess(): ChildProcess | undefined {
  return running;
}

/** Lets the setup tell an expected teardown from a crash mid-run. */
export function markStopping(): void {
  stopping = true;
}

export function isStopping(): boolean {
  return stopping;
}
