/** Durable acceptance signal for trusted inbound agent-message relays. */
export interface AgentMessageAcceptance {
  chat_jid: string;
  row_id: number;
  thread_id: number | null;
  accepted_at: string;
  created: true;
}

export type AgentMessageAcceptanceHandler = (acceptance: AgentMessageAcceptance) => void;
