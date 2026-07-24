import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// PDF.js expects browser geometry globals that jsdom does not provide.
// Keep these minimal constructor shims in the root Vitest setup so tests run
// consistently whether Vitest is invoked from the workspace or apps/ui.
if (!(globalThis as any).DOMMatrix) {
  (globalThis as any).DOMMatrix = class DOMMatrix {};
}
if (!(globalThis as any).Path2D) {
  (globalThis as any).Path2D = class Path2D {};
}
if (!(globalThis as any).ImageData) {
  (globalThis as any).ImageData = class ImageData {};
}

// The root Vitest config is also used for apps/ui tests, so mirror the UI's
// Vite setup and prevent rendered Dashboard instances leaking between tests.
afterEach(() => {
  if (typeof document !== "undefined") cleanup();
});
