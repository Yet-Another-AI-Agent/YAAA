export type Token<T = any> = string | symbol | { new (...args: any[]): T } | Function;

export class Container {
  private registry = new Map<Token, any>();
  private factories = new Map<Token, (...args: any[]) => any>();

  register<T>(token: Token<T>, instance: T): void {
    this.registry.set(token, instance);
  }

  registerFactory<T>(token: Token<T>, factory: (c: Container) => T): void {
    this.factories.set(token, factory);
  }

  resolve<T>(token: Token<T>): T {
    if (this.registry.has(token)) {
      return this.registry.get(token);
    }
    if (this.factories.has(token)) {
      const factory = this.factories.get(token)!;
      const instance = factory(this);
      this.registry.set(token, instance); // Cache singleton
      return instance;
    }
    throw new Error(`Dependency injection token not found: ${String(token)}`);
  }

  clear(): void {
    this.registry.clear();
    this.factories.clear();
  }
}

export const container = new Container();
