import { describe, expect, test } from "bun:test";
import {
  queueFollowupPlaceholderMessage,
  replaceQueuedFollowupPlaceholderMessage,
  sendWebMessage,
  type MessageWriteContext,
} from "../../../../src/channels/web/messaging/message-write-flows.js";

describe("web message write flows", () => {
  test("sendWebMessage stores and broadcasts agent responses and can force thread roots", () => {
    const events: string[] = [];
    const context: MessageWriteContext = {
      defaultAgentId: "default",
      store: {
        storeMessage: () => ({
          id: 42,
          timestamp: "2026-01-01T00:00:00.000Z",
          data: { type: "agent_response", content: "hello" },
        }),
        replaceMessageContent: () => null,
        setMessageThreadToSelf: (id) => events.push(`thread:${id}`),
      },
      broadcaster: {
        broadcastAgentResponse: (interaction) => events.push(`broadcast:${interaction.id}`),
        broadcastInteractionUpdated: () => {},
      },
      followups: {
        enqueue: () => {},
      },
    };

    sendWebMessage("web:default", "hello", { forceRoot: true }, context);

    expect(events).toEqual(["thread:42", "broadcast:42"]);
  });

  test("queueFollowupPlaceholderMessage enqueues placeholders without broadcasting", () => {
    const events: string[] = [];
    const context: MessageWriteContext = {
      defaultAgentId: "default",
      store: {
        storeMessage: () => ({
          id: 7,
          timestamp: "2026-01-01T00:00:00.000Z",
          data: { type: "agent_response", content: "queued" },
        }),
        replaceMessageContent: () => null,
        setMessageThreadToSelf: () => {},
      },
      broadcaster: {
        broadcastAgentResponse: (interaction) => events.push(`broadcast:${interaction.id}`),
        broadcastInteractionUpdated: () => {},
      },
      followups: {
        enqueue: (chatJid, rowId) => events.push(`enqueue:${chatJid}:${rowId}`),
      },
    };

    const interaction = queueFollowupPlaceholderMessage("web:default", "queued", 99, context);

    expect(interaction?.id).toBe(7);
    expect(events).toEqual(["enqueue:web:default:7"]);
  });

  test("replaceQueuedFollowupPlaceholderMessage updates interaction metadata and broadcasts", () => {
    const events: string[] = [];
    const context: MessageWriteContext = {
      defaultAgentId: "default",
      store: {
        storeMessage: () => null,
        replaceMessageContent: () => ({
          id: 55,
          timestamp: "2026-01-01T00:00:00.000Z",
          data: { type: "agent_response", content: "updated" },
        }),
        setMessageThreadToSelf: () => {},
      },
      broadcaster: {
        broadcastAgentResponse: () => {},
        broadcastInteractionUpdated: (interaction) => events.push(`updated:${interaction.id}`),
      },
      followups: {
        enqueue: () => {},
      },
    };

    const interaction = replaceQueuedFollowupPlaceholderMessage(
      "web:default",
      55,
      "updated",
      [],
      undefined,
      123,
      context
    );

    expect(interaction?.data.agent_id).toBe("default");
    expect(interaction?.data.thread_id).toBe(123);
    expect(events).toEqual(["updated:55"]);
  });

  test("runs the placeholder completion fence after persistence and before update broadcast", () => {
    const events: string[] = [];
    const context: MessageWriteContext = {
      defaultAgentId: "default",
      store: {
        storeMessage: () => null,
        replaceMessageContent: () => {
          events.push("persist");
          return {
            id: 55,
            timestamp: "2026-01-01T00:00:00.000Z",
            data: { type: "agent_response", content: "updated" },
          };
        },
        setMessageThreadToSelf: () => {},
      },
      broadcaster: {
        broadcastAgentResponse: () => {},
        broadcastInteractionUpdated: () => events.push("broadcast"),
      },
      followups: { enqueue: () => {} },
    };

    replaceQueuedFollowupPlaceholderMessage(
      "web:default",
      55,
      "updated",
      [],
      undefined,
      undefined,
      context,
      false,
      () => {
        events.push("complete");
        return true;
      },
    );
    expect(events).toEqual(["persist", "complete", "broadcast"]);

    events.length = 0;
    replaceQueuedFollowupPlaceholderMessage(
      "web:default",
      55,
      "updated",
      [],
      undefined,
      undefined,
      context,
      false,
      () => {
        events.push("complete-rejected");
        return false;
      },
    );
    expect(events).toEqual(["persist", "complete-rejected"]);
  });
});
