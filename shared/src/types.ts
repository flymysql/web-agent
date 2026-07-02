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

/**
 * Default handling for high-risk actions: pause and ask each time, auto-run
 * them, or auto-reject them. Chosen by the user in the composer and carried on
 * each task; site-agnostic (independent of which tool/site is involved).
 */
export type ConfirmPolicy = 'ask' | 'auto' | 'reject';

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

/**
 * A deterministic post-condition for a single action, verified locally with
 * ZERO LLM calls. Mirrors the `expect` browser tool's arguments so the same
 * check can run in the page. Site-agnostic by construction.
 */
export interface StepExpectation {
  /** An element that should be present after the step. */
  selector?: string;
  /** Whether `selector` should be visible (default) or gone. */
  state?: 'visible' | 'gone';
  /** Substring the page text should contain. */
  text?: string;
  /** Substring the URL should contain. */
  urlIncludes?: string;
  /** Attribute (on `selector`) whose value should equal `equals`. */
  attribute?: string;
  equals?: string;
  /** Weakest check: just require the page to have changed vs. before the step. */
  changed?: boolean;
}

/**
 * One action emitted by the batched decision LLM. The agent executes a run of
 * these consecutively, verifying each with `expect` (deterministic, no LLM) or,
 * only when no deterministic check is possible, a light `verify` LLM check.
 */
export interface PlannedStep {
  tool: string;
  args: Record<string, unknown>;
  /** Deterministic post-condition; verified locally with zero LLM. */
  expect?: StepExpectation;
  /** Natural-language check used ONLY when `expect` is absent (hybrid: 1 light LLM call). */
  verify?: string;
  /** Short rationale, surfaced in the task logs. */
  thought?: string;
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
  /** Computed accessible name (aria-label / associated label / title / text). */
  accessibleName?: string;
  /** Id of the PageRegion this element belongs to (see PageContext.regions). */
  regionId?: string;
  /** True when the control is disabled (native disabled or aria-disabled). */
  disabled?: boolean;
  /** aria-expanded state for disclosure controls (panels, menus, comboboxes). */
  expanded?: boolean;
  /** Checkbox/radio checked state, or aria-checked for custom widgets. */
  checked?: boolean;
  /** aria-selected state (tabs, options, grid cells). */
  selected?: boolean;
  /** Current value of an input/textarea/select (truncated; omitted for passwords). */
  value?: string;
  /** The control is required (native required or aria-required). */
  required?: boolean;
  /** The control is read-only (native readOnly or aria-readonly). */
  readOnly?: boolean;
  /** True when this is a file-picker input (<input type=file>). */
  isFileInput?: boolean;
  /** The file input's accept attribute (allowed types), when present. */
  accepts?: string;
  /** aria-haspopup value: menu/listbox/dialog/tree/grid — reveals a popup on activate. */
  hasPopup?: string;
  /** aria-current value (page/step/true) marking the active item in a set. */
  current?: string;
}

/**
 * A semantic block of the page derived from landmarks / ARIA roles / semantic
 * containers. Purely structural and site-agnostic — the `role` is a generic
 * category inferred from the DOM, never a hardcoded site/page label.
 */
export interface PageRegion {
  /** Stable-within-snapshot id, e.g. "region-3". */
  id: string;
  /** Generic role: navigation/search/main/form/dialog/list/table/toolbar/... */
  role: string;
  /** Accessible name or nearest heading text, when available. */
  label?: string;
  rect?: { x: number; y: number; width: number; height: number };
  /** True when this region is a modal/dialog currently on top of the page. */
  modalTop?: boolean;
  /** How many interactive elements were assigned to this region. */
  elementCount?: number;
}

export interface PageContext {
  url: string;
  title: string;
  visibleText: string;
  interactiveElements: InteractiveElement[];
  formFields: InteractiveElement[];
  links: Array<{ text: string; href: string; selector: string }>;
  /** Semantic blocks of the page (landmarks, dialogs, lists, forms, ...). */
  regions?: PageRegion[];
  /** Document heading outline (h1-h6 / role=heading), in document order. */
  headings?: Array<{ level: number; text: string }>;
  /** Id of the region that is the currently focused modal/dialog, if any. */
  activeDialogRegionId?: string;
  /** Latest text from aria-live / role=alert|status regions (dynamic feedback). */
  announcements?: string[];
  /** Iframes on the page and whether their content is reachable (same-origin). */
  iframes?: Array<{ selector: string; sameOrigin: boolean; title?: string }>;
  /** Inner scroll containers (virtualized lists, log panels) worth scrolling. */
  scrollables?: Array<{ selector: string; label?: string; canScrollDown: boolean }>;
  /**
   * A concise, server-computed summary of what changed since the previous step
   * (new/removed blocks, appeared dialog/toast, URL change). Not filled by the
   * extractor — the orchestrator sets it before each decision.
   */
  changeSummary?: string;
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

/**
 * Anti-flail counters for the agent loop. Persisted on the task so they SURVIVE
 * a pause/resume (e.g. a high-risk confirmation), which otherwise re-enters the
 * loop with everything reset — letting a stuck task loop forever as long as it
 * periodically hits a confirmation gate.
 */
export interface AgentGuardState {
  totalFailures: number;
  consecutiveFailures: number;
  errorCounts: Record<string, number>;
  actionCounts: Record<string, number>;
  thoughtCounts: Record<string, number>;
  redundantReads: number;
  replanned: boolean;
  /** Consecutive decision steps that produced no observable page/collected change. */
  noProgressSteps: number;
  /** Fingerprint of the last state considered "progress". */
  lastProgressDigest?: string;
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

/**
 * How a workflow parameter's value is produced at run time:
 * - 'prompt'   : ask the user (or use the run-time supplied value / default).
 * - 'generate' : produce it automatically at run time from `instruction` (LLM),
 *                for steps whose content isn't fixed (e.g. an auto-generated
 *                text, a fresh value each run).
 * - 'constant' : always use `default` as a fixed literal.
 */
export type WorkflowParamMode = 'prompt' | 'generate' | 'constant';

export interface WorkflowParam {
  key: string;
  label: string;
  default?: string;
  /** Defaults to 'prompt' when omitted (backward compatible). */
  mode?: WorkflowParamMode;
  /** Natural-language instruction describing how to produce the value (mode='generate'). */
  instruction?: string;
}

export interface WorkflowStep {
  id: string;
  description: string;
  tool: string;
  args: Record<string, unknown>;
  riskLevel: RiskLevel;
  requiresConfirmation: boolean;
}

/**
 * One raw user interaction captured during a recording session, before the LLM
 * "understand" pass turns it into clean WorkflowStep[]. Site-agnostic: `tool`
 * and `args` reuse the normal browser tool vocabulary.
 */
export interface RecordedAction {
  tool: string;
  args: Record<string, unknown>;
  /** Stable selector for the target element, when the action has one. */
  selector?: string;
  /** Human-meaningful label of the target (accessible name / text), for the LLM. */
  label?: string;
  /** The page URL at the time the action was captured. */
  url?: string;
  at: number;
  /**
   * Spoken narration / guidance the user gave near this action (aligned by
   * timestamp during the "understand" pass). A hint for the LLM, not literal copy.
   */
  note?: string;
}

/**
 * One spoken utterance captured while recording. `kind` distinguishes passive
 * narration ("I'm clicking the filter") from explicit agent-guidance the user
 * spoke on a key step ("here the agent should pick today's date"). Site-agnostic.
 */
export interface RecordingNarration {
  text: string;
  at: number;
  kind: 'narration' | 'guidance';
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

/**
 * A user-provided file attached to a task as AI input. Read on the client:
 * text files have their content extracted into `text`; images are carried as a
 * base64 `dataUrl` and only understood when a vision-capable model is enabled.
 */
export interface TaskAttachment {
  name: string;
  mime: string;
  kind: 'text' | 'image';
  /** Extracted UTF-8 content for text files (may be truncated). */
  text?: string;
  /** `data:` URL for image files. */
  dataUrl?: string;
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
  /** Files the user attached as extra AI input for this task. */
  attachments?: TaskAttachment[];
  /**
   * The page the task STARTED on. Unlike `url` (which tracks the latest observed
   * page and changes as the agent navigates), this is captured once and stays
   * fixed, so a workflow saved from this task remembers the right starting page.
   */
  startUrl?: string;
  plan?: TaskPlan;
  currentStepIndex: number;
  checkpoint?: TaskCheckpoint;
  /** Persisted anti-flail counters (see AgentGuardState) — survive pause/resume. */
  guardState?: AgentGuardState;
  /**
   * Remaining actions from the last batched decision, executed optimistically
   * without re-invoking the LLM. Persisted so the queue survives pause/resume
   * (e.g. a high-risk confirmation re-enters the agent loop).
   */
  pendingBatch?: PlannedStep[];
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
  /**
   * How high-risk actions are handled in THIS task: 'ask' pauses for the user
   * each time (default), 'auto' runs them without asking, 'reject' auto-denies
   * them without asking. Seeded from the composer's default and can be switched
   * to 'auto' by the "confirm & don't ask again" button.
   */
  confirmPolicy?: ConfirmPolicy;
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
