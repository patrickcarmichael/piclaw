import { createHmac, randomBytes } from "node:crypto";

export type ToolSafetyClassification =
  | { effect: "read_only"; redactArgs?: boolean; redactResult?: boolean }
  | {
    effect: "mutation";
    repetition: "guard" | "allow";
    terminalSideEffect?: boolean;
    redactArgs?: boolean;
    redactResult?: boolean;
  };

export type ToolSafetyPolicy =
  | ToolSafetyClassification
  | ((validatedArgs: Record<string, unknown>) => ToolSafetyClassification);

const TOOL_SAFETY_POLICY = Symbol.for("piclaw.tool-safety-policy");
const attachedPolicies = new WeakMap<object, ToolSafetyPolicy>();
const fingerprintKey = randomBytes(32);

const GUARDED_MUTATION_POLICY: ToolSafetyClassification = { effect: "mutation", repetition: "guard" };

export const keychainToolSafetyPolicy: ToolSafetyPolicy = (validatedArgs) => {
  if (validatedArgs.action === "list" || validatedArgs.action === "get") {
    return { effect: "read_only", redactResult: true };
  }
  return { ...GUARDED_MUTATION_POLICY, redactArgs: true, redactResult: true };
};

/** Attach an explicit safety contract to the concrete registered tool definition. */
export function withToolSafetyPolicy<T extends object>(definition: T, policy: ToolSafetyPolicy): T {
  attachedPolicies.set(definition, policy);
  return definition;
}

export function getToolSafetyPolicy(
  definition: unknown,
  validatedArgs: Record<string, unknown>,
): ToolSafetyClassification | null {
  if (!definition || typeof definition !== "object") return null;
  const record = definition as Record<PropertyKey, unknown>;
  const policy = attachedPolicies.get(definition) ?? record[TOOL_SAFETY_POLICY];
  if (!policy) return null;
  return typeof policy === "function" ? policy(validatedArgs) : policy as ToolSafetyClassification;
}

export function getSessionToolSafetyPolicy(
  session: { getToolDefinition?: (name: string) => unknown },
  toolName: unknown,
  validatedArgs: unknown,
): ToolSafetyClassification | null {
  if (typeof toolName !== "string" || !toolName) return null;
  const getDefinition = (session as unknown as {
    getToolDefinition?: (name: string) => unknown;
  }).getToolDefinition;
  if (typeof getDefinition !== "function") return null;
  const args = validatedArgs && typeof validatedArgs === "object" && !Array.isArray(validatedArgs)
    ? validatedArgs as Record<string, unknown>
    : {};
  return getToolSafetyPolicy(getDefinition.call(session, toolName), args);
}

function canonicalize(value: unknown, seen: Set<object>, depth: number): string {
  if (depth > 24) return '"[depth-limit]"';
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : JSON.stringify(String(value));
  if (typeof value === "bigint") return JSON.stringify(`${value}n`);
  if (typeof value === "undefined") return '"[undefined]"';
  if (typeof value === "function") return '"[function]"';
  if (typeof value === "symbol") return '"[symbol]"';
  if (typeof value !== "object") return JSON.stringify(String(value));
  if (seen.has(value)) return '"[circular]"';

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonicalize(item, seen, depth + 1)).join(",")}]`;
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key], seen, depth + 1)}`)
      .join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

/** Return an opaque, process-keyed fingerprint; raw arguments are never persisted. */
export function createMutationFingerprint(toolName: string, validatedArgs: Record<string, unknown>): string {
  const canonicalArgs = canonicalize(validatedArgs, new Set(), 0);
  return createHmac("sha256", fingerprintKey)
    .update(toolName)
    .update("\0")
    .update(canonicalArgs)
    .digest("hex");
}
