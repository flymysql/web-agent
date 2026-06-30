/** Task lifecycle states */
export type TaskStatus =
  | 'pending'
  | 'planning'
  | 'running'
  | 'paused'
  | 'waiting_confirmation'
  | 'needs_input'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * What the user selected in the composer. `auto` lets the model classify the
 * message (chat / agent / clarify); the others force a specific behaviour.
 */
export type RequestMode = 'auto' | 'ask' | 'agent' | 'plan';

/** How a request was routed once classified. */
export type TaskIntent = 'chat' | 'agent' | 'clarify';

/** Honest terminal quality of an agent run (vs. just the lifecycle status). */
export type TaskOutcome = 'success' | 'partial' | 'gave_up' | 'failed';

export type TaskKind = 'once' | 'loop';

export type RiskLevel = 'low' | 'medium' | 'high';

export interface PlanStep {
  id: string;
  description: string;
  tool: string;
  args: Record<string, unknown>;
  riskLevel: RiskLevel;
  requiresConfirmation: boolean;
}

export interface TaskPlan {
  goal: string;
  steps: PlanStep[];
  estimatedDuration?: string;
  risks?: string[];
}

export interface InteractiveElement {
  id: string;
  tag: string;
  role?: string;
  type?: string;
  text?: string;
  placeholder?: string;
  name?: string;
  href?: string;
  selector: string;
  visible: boolean;
  rect?: { x: number; y: number; width: number; height: number };
}

export interface PageContext {
  url: string;
  title: string;
  visibleText: string;
  interactiveElements: InteractiveElement[];
  formFields: InteractiveElement[];
  links: Array<{ text: string; href: string; selector: string }>;
  timestamp: number;
}

export interface ToolCallRecord {
  id: string;
  taskId: string;
  stepId?: string;
  tool: string;
  args: Record<string, unknown>;
  result?: unknown;
  error?: string;
  startedAt: number;
  completedAt?: number;
  riskLevel: RiskLevel;
  confirmed?: boolean;
}

export interface TaskCheckpoint {
  stepIndex: number;
  lastToolCallId?: string;
  pageContext?: PageContext;
  savedAt: number;
}

export interface TaskLogEntry {
  id: string;
  timestamp: number;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  data?: Record<string, unknown>;
}

export type TriggerType = 'manual' | 'scheduled' | 'onPageOpen';

export interface WorkflowTrigger {
  type: TriggerType;
  /** scheduled: execution interval in ms */
  intervalMs?: number;
  /** onPageOpen: URL substring or glob-like pattern to match */
  urlPattern?: string;
}

export interface WorkflowParam {
  key: string;
  label: string;
  default?: string;
}

export interface WorkflowStep {
  id: string;
  description: string;
  tool: string;
  args: Record<string, unknown>;
  riskLevel: RiskLevel;
  requiresConfirmation: boolean;
}

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  startUrl?: string;
  params: WorkflowParam[];
  steps: WorkflowStep[];
  triggers: WorkflowTrigger[];
  createdAt: number;
  updatedAt: number;
}

/**
 * 'agent' = ReAct loop (observe→decide→act); 'replay' = deterministic static
 * steps; 'chat' = a read-only conversational answer (no tools executed).
 */
export type TaskMode = 'agent' | 'replay' | 'chat';

/** One durable item collected by the agent (e.g. a summarized article). */
export interface CollectedItem {
  /** Stable dedup key, typically the item URL. */
  key: string;
  title?: string;
  /** Full content/summary — stored untruncated; only truncated in UI. */
  content: string;
  at: number;
}

export interface Task {
  id: string;
  sessionId?: string;
  userRequest: string;
  status: TaskStatus;
  kind: TaskKind;
  mode: TaskMode;
  /** The composer mode the user chose for this request (defaults to 'auto'). */
  requestMode?: RequestMode;
  /** How the request was classified once routed. */
  intent?: TaskIntent;
  /** Honest result quality, independent of the lifecycle status. */
  outcome?: TaskOutcome;
  /** A direct conversational reply (chat mode) or a clarifying question. */
  assistantMessage?: string;
  /** When status === 'needs_input', the question the agent is asking the user. */
  clarifyQuestion?: string;
  maxSteps?: number;
  workflowId?: string;
  /** Generalized steps recorded from a successful agent run, ready to save as a workflow */
  recordedSteps?: WorkflowStep[];
  tabId?: number;
  url?: string;
  plan?: TaskPlan;
  currentStepIndex: number;
  checkpoint?: TaskCheckpoint;
  toolCalls: ToolCallRecord[];
  logs: TaskLogEntry[];
  /** Durable results gathered during a map-reduce style run (deduped by key). */
  collected?: CollectedItem[];
  result?: string;
  error?: string;
  loopIntervalMs?: number;
  loopMaxIterations?: number;
  loopIteration: number;
  pendingConfirmation?: {
    stepId: string;
    tool: string;
    args: Record<string, unknown>;
    reason: string;
  };
  createdAt: number;
  updatedAt: number;
}

/** Role of a message in the conversation thread. */
export type ChatRole = 'user' | 'assistant' | 'system';

/**
 * One turn in a conversation thread. `kind` distinguishes a plain text turn
 * from an agent run reference (linking to a Task that streamed its progress).
 */
export interface ChatMessage {
  id: string;
  role: ChatRole;
  kind: 'text' | 'run';
  content: string;
  /** For kind === 'run', the task that produced this turn. */
  taskId?: string;
  createdAt: number;
}

/** A chat session / conversation grouping multiple tasks with shared context */
export interface ChatSession {
  id: string;
  title: string;
  taskIds: string[];
  /** Ordered conversation turns (added in the message-thread model). */
  messages?: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface ExtensionSession {
  sessionId: string;
  connectedAt: number;
  lastSeenAt: number;
  activeTabId?: number;
  activeUrl?: string;
}

export interface AuditEntry {
  id: string;
  taskId: string;
  action: string;
  tool?: string;
  args?: Record<string, unknown>;
  riskLevel: RiskLevel;
  confirmed: boolean;
  maskedFields?: string[];
  timestamp: number;
}
