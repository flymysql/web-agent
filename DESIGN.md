# AI Web Agent — 设计文档

一个浏览器自动化 Agent:理解页面结构、理解用户需求并制定计划、操控页面，并能把成功的任务沉淀为**可保存、可复用、可定时/触发**的工作流。

---

## 1. 系统组成

```
shared/      跨端共享的类型、协议、工具定义
server/      Express + WebSocket 后端(规划 / 编排 / 调度 / 安全 / 持久化)
extension/   Chrome MV3 扩展
  background/  service worker:WS 桥接、按 tabId 路由工具执行
  content/     页面理解(page-context)、页面操控(browser-tools)、悬浮球 UI
  popup/       弹窗 UI:创建任务、工作流管理
```

数据流:`popup/content → background(SW) → WebSocket/REST → server`。
浏览器侧工具由 server 通过 WS 下发 `tool.execute`，content script 执行后回 `tool.result`。

---

## 2. 核心概念

- **Workflow(工作流)**:可复用的模板。包含步骤、参数占位符、触发方式。**持久化、可编辑**。
- **Task / Run(任务运行)**:一次具体执行,有状态机、日志、结果。可由工作流实例化,也可来自一次性请求。
- 关系:`Workflow 1 ── N Task`。`Task.workflowId` 回链来源工作流。一次成功的临时 Task 可"另存为" Workflow。

---

## 3. 关键技术决策

| 决策点 | 选择 |
|---|---|
| 存储 | **先 JSON 文件**,落盘到 `server/.data/`;通过 `Repository` 接口抽象,后续可平滑替换为 SQLite |
| LLM | **OpenAI 兼容端点**(`/chat/completions`),通过环境变量配置 base URL / model / key;支持本地模型(Ollama、LM Studio)与国内模型(DeepSeek、Qwen/DashScope 兼容模式、智谱等) |
| 规则回退 | **不提供**。未配置或调用失败时,规划直接报明确错误,不降级到关键词规则 |
| 触发方式 | **多选**:`manual`(手动)/ `scheduled`(定时)/ `onPageOpen`(匹配 URL 打开即触发) |
| 工具执行路由 | 按 `task.tabId` 执行,而非"当前激活标签" |

### LLM 配置(环境变量)

```
LLM_BASE_URL   默认 https://api.openai.com/v1
LLM_API_KEY    本地模型可留空
LLM_MODEL      默认 gpt-4o-mini;本地示例 qwen2.5、deepseek-chat 等
```

常见端点示例:
- Ollama:`LLM_BASE_URL=http://localhost:11434/v1`，`LLM_MODEL=qwen2.5`
- LM Studio:`LLM_BASE_URL=http://localhost:1234/v1`
- DeepSeek:`LLM_BASE_URL=https://api.deepseek.com/v1`，`LLM_MODEL=deepseek-chat`
- 通义千问(兼容模式):`LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1`

---

## 4. 数据模型(shared/types)

```ts
type TriggerType = 'manual' | 'scheduled' | 'onPageOpen';

interface WorkflowTrigger {
  type: TriggerType;
  intervalMs?: number;   // scheduled:执行间隔
  urlPattern?: string;   // onPageOpen:匹配的 URL(子串或通配)
}

interface WorkflowParam {
  key: string;           // 占位符名,步骤 args 中以 {{key}} 引用
  label: string;
  default?: string;
}

interface WorkflowStep {
  id: string;
  description: string;
  tool: string;
  args: Record<string, unknown>;   // 可含 {{param}} 占位
  riskLevel: RiskLevel;
  requiresConfirmation: boolean;
}

interface Workflow {
  id: string;
  name: string;
  description?: string;
  startUrl?: string;               // 复跑前先导航
  params: WorkflowParam[];
  steps: WorkflowStep[];
  triggers: WorkflowTrigger[];     // 多选
  createdAt: number;
  updatedAt: number;
}
```

`Task` 增加 `workflowId?: string`。

---

## 5. 存储层(P1)

```ts
interface Repository<T extends { id: string }> {
  get(id: string): T | undefined;
  list(): T[];
  upsert(entity: T): T;
  delete(id: string): void;
}
```

- `JsonRepository<T>`:启动时从 `server/.data/<name>.json` 载入,变更时写回(同步写,量小够用)。
- `tasks` 与 `workflows` 各一个集合。现有 `tasks/store.ts` 的对外函数签名保持不变,内部改为走持久化集合,降低改动面。

---

## 6. REST / 协议

现有任务接口保留。新增工作流接口:

```
GET    /api/workflows
POST   /api/workflows
GET    /api/workflows/:id
PUT    /api/workflows/:id
DELETE /api/workflows/:id
POST   /api/workflows/:id/run            body: { params }  → 实例化为 Task 并规划
POST   /api/tasks/:id/save-as-workflow   body: { name, triggers, params }
```

实例化:复制 `workflow.steps`,对 args 做 `{{param}}` 替换;若有 `startUrl`,首步导航。

---

## 7. 规划与执行

- **P2 阶段**:`createPlan` 仅走 LLM,产出 `TaskPlan`;失败即报错。
- **P3 阶段(后续)**:升级为 ReAct 闭环——每步执行后回传最新 `pageContext`,LLM 基于"目标+当前页面+历史动作"决定下一步;预生成计划仅作意图概览。闭环成功后,把实际 `toolCalls` 泛化为 `WorkflowStep[]`(可变值提为 `{{param}}`)实现"录制即工作流"。

高风险步骤沿用现有确认机制(`safety/audit.ts` 关键词检测 + 敏感字段脱敏)。

---

## 8. 触发方式实现

- `manual`:用户在 UI 点击复跑。
- `scheduled`:`scheduler` 为带该触发的工作流注册 `setInterval`,到点实例化并执行(需扩展在线)。
- `onPageOpen`:content script 在页面加载时上报 URL,后端匹配 `urlPattern` 命中则实例化执行(P2 落模型与匹配,wiring 逐步完善)。

---

## 9. 安全(P4,后续收口)

- 本地 token 鉴权:server 启动生成随机 token,扩展握手携带,挡住任意网页访问 `localhost`。
- `fetch` 工具 SSRF 白名单:默认禁内网与云元数据地址。

---

## 10. 里程碑

`P0 连接` → `P1 持久化` → `P2 工作流(模型/CRUD/复跑/另存/触发)` → `P3 Agent 闭环 + 自动录制` → `P4 安全`。

P0–P2 完成即可实现核心闭环:**跑一次 → 保存 → 之后一键/定时复用**。
