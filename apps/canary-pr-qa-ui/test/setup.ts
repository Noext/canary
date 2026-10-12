import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Vitest does not run Testing Library's automatic cleanup: without this, each
// component test in a file keeps the DOM of the previous one mounted.
afterEach(cleanup);
