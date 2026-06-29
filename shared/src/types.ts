/** Task lifecycle states */
export type TaskStatus =
  | 'pending'
  | 'planning'
  | 'running'
  | 'paused'
  | 'waiting_confirmation'
  | 'completed'
  | 'failed'
  | 'cancelled';

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

/** 'agent' = ReAct loop (observe→decide→act); 'replay' = deterministic static steps */
export type TaskMode = 'agent' | 'replay';

export interface Task {
  id: string;
  sessionId?: string;
  userRequest: string;
  status: TaskStatus;
  kind: TaskKind;
  mode: TaskMode;
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

/** A chat session / conversation grouping multiple tasks with shared context */
export interface ChatSession {
  id: string;
  title: string;
  taskIds: string[];
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
