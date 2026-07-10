export type McpIntegrationScope =
  | { kind: "global" }
  | { kind: "task"; taskId: string };

export type McpServerTransport =
  | {
      kind: "stdio";
      command: string;
      args?: string[];
    }
  | {
      kind: "http";
      url: string;
    };

/** Declarative server metadata only. Registering it never installs or starts a server. */
export interface McpIntegrationDefinition {
  id: string;
  displayName: string;
  description?: string;
  transport: McpServerTransport;
}

export interface McpIntegrationState {
  trust: "untrusted" | "trusted";
  enabled: boolean;
}

export interface RegisteredMcpIntegration {
  definition: McpIntegrationDefinition;
  scope: McpIntegrationScope;
  state: McpIntegrationState;
  createdAt: string;
  updatedAt: string;
}

export type McpIntegrationStateUpdate = Partial<McpIntegrationState>;

const INTEGRATION_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function validateMcpIntegrationDefinition(
  definition: unknown,
): asserts definition is McpIntegrationDefinition {
  if (!isRecord(definition)) {
    throw new Error("Integration definition must be an object.");
  }
  if (typeof definition.id !== "string" || !INTEGRATION_ID.test(definition.id)) {
    throw new Error(
      "Integration id must contain only letters, numbers, dots, underscores, or hyphens.",
    );
  }
  if (
    typeof definition.displayName !== "string" ||
    !definition.displayName.trim()
  ) {
    throw new Error("Integration display name is required.");
  }
  if (
    definition.description !== undefined &&
    typeof definition.description !== "string"
  ) {
    throw new Error("Integration description must be a string.");
  }
  if (!isRecord(definition.transport)) {
    throw new Error("Integration transport is required.");
  }
  if (definition.transport.kind === "stdio") {
    if (
      typeof definition.transport.command !== "string" ||
      !definition.transport.command.trim()
    ) {
      throw new Error("A stdio integration requires a command.");
    }
    if (
      definition.transport.args !== undefined &&
      (!Array.isArray(definition.transport.args) ||
        definition.transport.args.some(
          (argument) => typeof argument !== "string",
        ))
    ) {
      throw new Error("Stdio integration arguments must be strings.");
    }
    return;
  }
  if (definition.transport.kind !== "http") {
    throw new Error("Integration transport must be stdio or http.");
  }

  let url: URL;
  try {
    if (typeof definition.transport.url !== "string") throw new Error();
    url = new URL(definition.transport.url);
  } catch {
    throw new Error("An HTTP integration requires a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("An HTTP integration URL must use http or https.");
  }
  if (url.username || url.password) {
    throw new Error("An HTTP integration URL must not contain credentials.");
  }
}

export function cloneMcpIntegrationDefinition(
  definition: McpIntegrationDefinition,
): McpIntegrationDefinition {
  return definition.transport.kind === "stdio"
    ? {
        id: definition.id,
        displayName: definition.displayName,
        ...(definition.description === undefined
          ? {}
          : { description: definition.description }),
        transport: {
          kind: "stdio",
          command: definition.transport.command,
          ...(definition.transport.args === undefined
            ? {}
            : { args: [...definition.transport.args] }),
        },
      }
    : {
        id: definition.id,
        displayName: definition.displayName,
        ...(definition.description === undefined
          ? {}
          : { description: definition.description }),
        transport: { kind: "http", url: definition.transport.url },
      };
}
