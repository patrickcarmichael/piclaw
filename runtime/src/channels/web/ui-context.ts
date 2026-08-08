/**
 * web/ui-context.ts – Extension UI context implementation.
 *
 * Implements the ExtensionUIContext interface used by pi-agent extensions
 * to request user input. Backed by the UI bridge for actual delivery.
 *
 * Consumers: channels/web.ts creates a UIContext for each agent session.
 */

import type { AgentSessionRuntime, ExtensionUIContext } from "@earendil-works/pi-coding-agent";

import type { BoundSessionMutationRunner } from "../../agent-pool.js";
import type { WebChannelLike } from "./core/web-channel-contracts.js";
import { UiBridge, type UiBridgeChannel } from "./theming/ui-bridge.js";

/** Channel shape required to bind web session UI context helpers safely. */
export type UiContextChannel = UiBridgeChannel & { uiBridge?: UiBridge };

function getBridge(channel: UiContextChannel): UiBridge {
  return channel.uiBridge ?? new UiBridge(channel);
}

/** Attach a UiBridge to an agent session for extension UI interactions. */
export async function bindSessionUiContext(
  channel: WebChannelLike | UiContextChannel,
  runtime: AgentSessionRuntime,
  chatJid: string,
  mutate: BoundSessionMutationRunner,
): Promise<void> {
  return getBridge(channel).bindSession(runtime, chatJid, mutate);
}

/** Create an ExtensionUIContext backed by the given UiBridge. */
export function createUiContext(channel: WebChannelLike | UiContextChannel, chatJid: string): ExtensionUIContext {
  return getBridge(channel).createUiContext(chatJid);
}
