// PDF.js relies on canvas geometry globals that Chromium provides but jsdom does not.
if (!(globalThis as any).DOMMatrix) {
  (globalThis as any).DOMMatrix = class DOMMatrix {};
}
if (!(globalThis as any).Path2D) {
  (globalThis as any).Path2D = class Path2D {};
}
if (!(globalThis as any).ImageData) {
  (globalThis as any).ImageData = class ImageData {};
}

afterEach(() => cleanup());
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
