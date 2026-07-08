import { describe, it, expect, beforeEach } from "vitest";
import { Container } from "./di.js";

describe("DI Container", () => {
  let container: Container;

  beforeEach(() => {
    container = new Container();
  });

  it("should register and resolve instances as singletons", () => {
    const instance = { api: "test" };
    container.register("TestInstance", instance);

    const resolved = container.resolve<typeof instance>("TestInstance");
    expect(resolved).toBe(instance);
  });

  it("should register and resolve factories, caching the result", () => {
    let callCount = 0;
    container.registerFactory("TestFactory", (c) => {
      callCount++;
      return { id: callCount };
    });

    const res1 = container.resolve<{ id: number }>("TestFactory");
    const res2 = container.resolve<{ id: number }>("TestFactory");

    expect(res1.id).toBe(1);
    expect(res2.id).toBe(1); // Cached singleton
    expect(res1).toBe(res2);
    expect(callCount).toBe(1);
  });

  it("should throw an error when resolving an unregistered token", () => {
    expect(() => container.resolve("UnregisteredToken")).toThrowError(
      "Dependency injection token not found: UnregisteredToken"
    );
  });

  it("should clear all registered dependencies", () => {
    container.register("Test", { foo: "bar" });
    container.clear();

    expect(() => container.resolve("Test")).toThrow();
  });
});
