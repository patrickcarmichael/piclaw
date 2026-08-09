import {
  extensionKvDelete,
  extensionKvGet,
  extensionKvSet,
} from "../db/extension-kv.js";

const EXTENSION_ID = "piclaw.runtime.mutation-safety";
const QUARANTINE_KEY = "quarantine";

export interface MutationQuarantine {
  version: 1;
  trigger: "repetition_limit" | "tool_budget";
  toolName: string;
  fingerprint: string;
  successfulRepetitions: number;
  previousActiveToolNames?: string[];
  createdAt: string;
}

function isMutationQuarantine(value: unknown): value is MutationQuarantine {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.version === 1
    && (record.trigger === "repetition_limit" || record.trigger === "tool_budget")
    && typeof record.toolName === "string"
    && record.toolName.length > 0
    && record.toolName.length <= 128
    && typeof record.fingerprint === "string"
    && /^[a-f0-9]{64}$/.test(record.fingerprint)
    && Number.isInteger(record.successfulRepetitions)
    && Number(record.successfulRepetitions) >= 1
    && (record.previousActiveToolNames === undefined
      || (Array.isArray(record.previousActiveToolNames)
        && record.previousActiveToolNames.length <= 256
        && record.previousActiveToolNames.every((name) => typeof name === "string" && name.length > 0 && name.length <= 128)))
    && typeof record.createdAt === "string"
    && Number.isFinite(Date.parse(record.createdAt));
}

export function getMutationQuarantine(chatJid: string): MutationQuarantine | null {
  const value = extensionKvGet<unknown>(EXTENSION_ID, QUARANTINE_KEY, "chat", chatJid);
  return isMutationQuarantine(value) ? value : null;
}

export function setMutationQuarantine(
  chatJid: string,
  input: Omit<MutationQuarantine, "version" | "createdAt">,
): MutationQuarantine {
  const previousActiveToolNames = [...new Set(input.previousActiveToolNames ?? [])]
    .filter((name) => typeof name === "string" && name.length > 0)
    .map((name) => name.slice(0, 128))
    .slice(0, 256);
  const quarantine: MutationQuarantine = {
    version: 1,
    trigger: input.trigger,
    toolName: input.toolName.slice(0, 128),
    fingerprint: input.fingerprint,
    successfulRepetitions: Math.max(1, Math.floor(input.successfulRepetitions)),
    ...(previousActiveToolNames.length > 0 ? { previousActiveToolNames } : {}),
    createdAt: new Date().toISOString(),
  };
  if (!isMutationQuarantine(quarantine)) {
    throw new Error("Invalid mutation quarantine metadata.");
  }
  extensionKvSet(EXTENSION_ID, QUARANTINE_KEY, quarantine, "chat", chatJid);
  return quarantine;
}

export function clearMutationQuarantine(chatJid: string): boolean {
  return extensionKvDelete(EXTENSION_ID, QUARANTINE_KEY, "chat", chatJid);
}
