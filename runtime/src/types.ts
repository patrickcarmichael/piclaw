/**
 * types.ts – Shared domain types used throughout the piclaw application.
 *
 * These interfaces define the core data shapes for chats, messages, scheduled
 * tasks, and callback signatures. They are imported by most modules including
 * the database layer (db/), channels (channels/), the agent pool (agent-pool.ts),
 * the task scheduler (task-scheduler.ts), IPC (ipc.ts), and the queue (queue.ts).
 */

/**
 * Configuration for a single chat endpoint (web chat, addon channel, etc.).
 * Loaded from the config file and used by the router (router.ts) to decide
 * whether to process inbound messages.
 */
export interface ChatConfig {
  /** Unique identifier for the chat (web channel id or addon-specific JID). */
  jid: string;
  /** Human-readable name for the chat, used in logging and UI. */
  name: string;
  /** When true, the agent only responds when explicitly triggered (e.g. mentioned). */
  requiresTrigger: boolean;
}

/**
 * Represents an inbound message arriving from any channel (web, addon channels, scheduled task).
 * Created by channel adapters and passed to the router/queue for processing.
 */
export interface NewMessage {
  /** Unique message identifier (channel-specific format). */
  id: string;
  /** JID of the chat this message belongs to. */
  chat_jid: string;
  /** Sender identifier (phone number, user id, etc.). */
  sender: string;
  /** Display name of the sender. */
  sender_name: string;
  /** Text content of the message. */
  content: string;
  /** Optional one-word client screen-size hint for agent prompt context. */
  screen_hint?: string | null;
  /** ISO-8601 timestamp of when the message was sent. */
  timestamp: string;
  /** True if the message was sent by the bot itself. */
  is_from_me?: boolean;
  /** True if this message originated from an automated bot action. */
  is_bot_message?: boolean;
  /** Rich content blocks (images, attachments) from the web channel. */
  content_blocks?: unknown[];
  /** OpenGraph / URL preview metadata attached to the message. */
  link_previews?: unknown[];
  /** Thread id for threaded replies in the web channel. */
  thread_id?: number | null;
  /** True only for the terminal persisted assistant message of a run. */
  is_terminal_agent_reply?: boolean;
  /** True for persisted steering-only user records that should not be reprocessed as turns. */
  is_steering_message?: boolean;
  /** Durable operation identity for an operation-bound assistant artifact. */
  operation_id?: string | null;
}

/**
 * A scheduled task persisted in the database (db/tasks.ts).
 * Created via IPC (ipc.ts) and executed by the task scheduler (task-scheduler.ts).
 */
export interface ScheduledTask {
  /** Unique task identifier. */
  id: string;
  /** JID of the chat where results are delivered. */
  chat_jid: string;
  /** The prompt to send to the agent when the task fires. */
  prompt: string;
  /** Optional model override for this task's agent session. */
  model?: string | null;
  /** Task kind: agent prompt, shell command, or built-in internal maintenance task. */
  task_kind?: "agent" | "shell" | "internal";
  /** Shell command to execute (for task_kind === "shell"). */
  command?: string | null;
  /** Working directory for shell command execution. */
  cwd?: string | null;
  /** Optional timeout (seconds) for shell commands. */
  timeout_sec?: number | null;
  /** Whether successful task output should trigger a Pushover nudge. */
  notify_on_complete?: number | boolean | null;
  /** How the task recurs: cron expression, fixed interval, or one-shot. */
  schedule_type: "cron" | "interval" | "once";
  /** The cron expression, interval duration, or ISO date for one-shot tasks. */
  schedule_value: string;
  /** ISO-8601 timestamp of the next scheduled execution (null if completed). */
  next_run: string | null;
  /** ISO-8601 timestamp of the most recent execution. */
  last_run: string | null;
  /** Summary of the most recent execution result. */
  last_result: string | null;
  /** Current lifecycle state of the task. */
  status: "active" | "paused" | "completed";
  /** ISO-8601 timestamp of when the task was created. */
  created_at: string;
}

/**
 * Log entry for a single execution of a ScheduledTask.
 * Stored by db/tasks.ts and surfaced in agent-control info commands.
 */
export interface TaskRunLog {
  /** ID of the parent ScheduledTask. */
  task_id: string;
  /** ISO-8601 timestamp of when this run started. */
  run_at: string;
  /** Wall-clock duration of the run in milliseconds. */
  duration_ms: number;
  /** Whether the run completed successfully or errored. */
  status: "success" | "error";
  /** The agent's response text on success. */
  result: string | null;
  /** Error message/stack on failure. */
  error: string | null;
}

/** Per-chat SSH remote execution profile used to enable remote core tools. */
export interface SshConfig {
  /** Owning chat/session JID. */
  chat_jid: string;
  /** SSH target as user@host or host, optionally with :/remote/path suffix. */
  ssh_target: string;
  /** SSH port. */
  ssh_port: number;
  /** Keychain entry name containing the private key and optional username fallback. */
  private_key_keychain: string;
  /** Optional keychain entry containing known_hosts content. */
  known_hosts_keychain: string | null;
  /** Strict host key checking mode. */
  strict_host_key_checking: "yes" | "accept-new" | "no";
  /** Creation timestamp. */
  created_at: string;
  /** Last config update timestamp. */
  updated_at: string;
  /** Last observed activity timestamp while this SSH profile was in use. */
  last_used_at: string;
}

/** When an SSH config change takes effect for a chat session. */
export type SshConfigApplyTiming = "immediate" | "next_turn" | "next_session";

/** Result of storing/updating a chat SSH config. */
export interface SshConfigSetResult {
  config: SshConfig;
  apply_timing: SshConfigApplyTiming;
}

/** Result of clearing a chat SSH config. */
export interface SshConfigClearResult {
  deleted: boolean;
  apply_timing: SshConfigApplyTiming;
}

/** Per-chat Proxmox API profile used by the native proxmox tool. */
export interface ProxmoxConfig {
  /** Owning chat/session JID. */
  chat_jid: string;
  /** Proxmox API base URL, typically ending in /api2/json. */
  base_url: string;
  /** Keychain entry name containing the Proxmox API token credentials. */
  api_token_keychain: string;
  /** Whether to allow insecure/self-signed TLS when calling the API. */
  allow_insecure_tls: boolean;
  /** Creation timestamp. */
  created_at: string;
  /** Last update timestamp. */
  updated_at: string;
}

/** Result of storing/updating a chat Proxmox config. */
export interface ProxmoxConfigSetResult {
  config: ProxmoxConfig;
  apply_timing: "immediate";
}

/** Result of clearing a chat Proxmox config. */
export interface ProxmoxConfigClearResult {
  deleted: boolean;
  apply_timing: "immediate";
}

/** Per-chat Portainer API profile used by the native portainer tool. */
export interface PortainerConfig {
  /** Owning chat/session JID. */
  chat_jid: string;
  /** Portainer API base URL, typically https://host:9443. */
  base_url: string;
  /** Keychain entry name containing the Portainer API token. */
  api_token_keychain: string;
  /** Whether to allow insecure/self-signed TLS when calling the API. */
  allow_insecure_tls: boolean;
  /** Creation timestamp. */
  created_at: string;
  /** Last update timestamp. */
  updated_at: string;
}

/** Result of storing/updating a chat Portainer config. */
export interface PortainerConfigSetResult {
  config: PortainerConfig;
  apply_timing: "immediate";
}

/** Result of clearing a chat Portainer config. */
export interface PortainerConfigClearResult {
  deleted: boolean;
  apply_timing: "immediate";
}

/**
 * Callback invoked by channel adapters when a new inbound message arrives.
 * Registered by the runtime (runtime.ts) and wired to the router/queue pipeline.
 */
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

/**
 * Callback invoked by channel adapters when chat metadata (name, last-seen
 * timestamp) is updated. Used by the router to maintain chat state in the DB.
 */
export type OnChatMetadata = (chatJid: string, timestamp: string, name?: string) => void;
