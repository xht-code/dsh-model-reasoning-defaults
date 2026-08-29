# DSH Model Reasoning Defaults

[![License: MIT](https://img.shields.io/github/license/xht-code/dsh-model-reasoning-defaults)](LICENSE)
[![Release](https://img.shields.io/github/v/release/xht-code/dsh-model-reasoning-defaults)](https://github.com/xht-code/dsh-model-reasoning-defaults/releases)
[![Stars](https://img.shields.io/github/stars/xht-code/dsh-model-reasoning-defaults)](https://github.com/xht-code/dsh-model-reasoning-defaults/stargazers)
[![Issues](https://img.shields.io/github/issues/xht-code/dsh-model-reasoning-defaults)](https://github.com/xht-code/dsh-model-reasoning-defaults/issues)

为 DSH (DeepSeek Harness) 生态中的 LLM 模型调用配置默认推理等级（`reasoningEffort`），并在请求进入底层调用链前自动按路由规则完成补齐。

- **仓库**：<https://github.com/xht-code/dsh-model-reasoning-defaults>

## 安装 / 更新

安装插件到指定的 DSH profile：

```bash
dsh plugin --profile web add dsh-model-reasoning-defaults
```

更新插件到最新版本：

```bash
dsh plugin --profile web update dsh-model-reasoning-defaults@latest
```

卸载插件：

```bash
dsh plugin --profile web remove dsh-model-reasoning-defaults
```

---

## 核心特性

- **多层级灵活路由**：支持从具体模型、Provider 通配到全局兜底的 6 级优先级匹配机制。
- **设置页可视化编辑**：在 Web 设置页「推理等级默认」中直接增删路由并选择等级，保存即时生效（带修订号并发保护）。
- **全入口统一注入**：无缝覆盖 Agent 主循环（`agent/request`）、直接调用（`llm.stream`）以及预准备入口（`prepareCall` / `resolveCallConfig`）。
- **对象安全与不可变性保证**：采用非破坏性浅复制机制，安全处理 `Object.freeze` 深冻结请求，原请求对象与未命中的配置始终保持只读与纯净。
- **宿主标识直读**：loop 请求识别直接使用 DSH 导出的 `isAgentLoopRequest`（基于宿主 `markAgentLoopRequest` 进程标识），不维护自建登记表，跨模块副本与热重载天然一致。
- **无缝热重载（Hot-Reload Safe）**：基于 `RuntimePatchState` 管理多 Fiber 状态，配置变更即时生效，仅在最后一个插件 Fiber 卸载时还原原始方法，杜绝方法悬挂。

---

## 路由匹配优先级

当请求未显式携带 `reasoningEffort` 且提供了 `provider` 与 `model` 时，插件将依次按以下候选键顺序检索配置映射，命中即停：

| 优先级 | 匹配格式 | 匹配语义 | 示例 |
| :--- | :--- | :--- | :--- |
| **1** | `provider:model` | 精确匹配指定提供商下的具体模型 | `my-gateway:deepseek-reasoner` |
| **2** | `provider:*` | 匹配指定提供商下的所有模型 | `my-gateway:*` |
| **3** | `provider/*` | 斜杠兼容写法（等价于 `provider:*`） | `my-gateway/*` |
| **4** | `provider` | 裸提供商名称写法（等价于 `provider:*`） | `my-gateway` |
| **5** | `*:model` | 跨提供商匹配同名模型 | `*:deepseek-reasoner` |
| **6** | `*` | 全局兜底默认值 | `*` |

> [!NOTE]
> - 若请求已显式声明 `reasoningEffort`，插件将**严格保持原值**，绝不覆盖。
> - 配置中的路由键与推理等级值均由 Schema 校验强制要求为**非空字符串**（`/^\S+$/`），空键或空白值将在配置阶段直接报错拦截；结构化层级中缺 `id` 或缺等级的条目无法生成路由，会在插件激活时以告警形式提示并被忽略。

---

## 配置指南

### 方式 1：在 Web 设置页中直接编辑（推荐）

打开 Web 端 **设置 →「推理等级默认」**，即可增删路由行并从下拉框选择推理等级，保存后对新请求**即时生效**（无需重启或重载）。数据存储在本插件注册的 `model-reasoning-defaults` 设置命名空间（落盘于 `settings.yaml`），经宿主统一 settings API 写入：

```yaml
# settings.yaml（设置页保存后的落盘结果）
model-reasoning-defaults:
  defaults:
    "deepseek-official:*": high
    "*": medium
```

> [!NOTE]
> - 路由键支持全部六级写法；等级下拉框为已知集合（off/minimal/low/medium/high/xhigh/max），也接受手工输入其它值。
> - 编辑器带修订号保护：两个标签页同时编辑时，后保存的一方会被拒绝而不是静默覆盖。
> - 面板内嵌匹配语义说明（六级优先级次序与生效优先级），输入路由键时可参考已配置的 Provider/Model 建议。

### 方式 2：直接在 DSH 模型设置中声明（零侵入）

在 DSH 设置服务（宿主通常从 `$DSH_HOME/settings.yaml` 装载）中，插件会自动读取 `llm-pi-ai` 与 `llm-deepseek` 命名空间里已声明的思考等级，无需单独配置插件项：

```yaml
# settings.yaml
llm-pi-ai:
  providers:
    my-gateway:
      apiKeyEnv: GATEWAY_API_KEY
      baseURL: https://gateway.example/v1
      # 1. Provider 级默认思考等级（llm-pi-ai 原生字段）
      reasoning: medium
      models:
        # 2. 模型级默认思考等级（本插件扩展读取的字段，见下方说明）
        - id: deepseek-reasoner
          reasoning: high
        - id: deepseek-chat
          reasoning: low

    # 3. 官方目录 Provider：在 modelOverrides 中为具体模型指定默认思考等级
    #    （同为扩展读取字段）
    anthropic:
      apiKeyEnv: ANTHROPIC_API_KEY
      modelOverrides:
        claude-3-7-sonnet:
          reasoning: high

llm-deepseek:
  # 4. DeepSeek 官方 Provider 默认思考等级（原生字段，映射到 deepseek-official 路由）
  reasoningEffort: high
```

> [!IMPORTANT]
> - 上例第 2、3 处的模型级 `reasoning` 是**本插件扩展读取的约定字段**：`llm-pi-ai` 的 schema 在模型层声明的原生字段是 `reasoningEfforts`（"可选等级集合 + 线格式映射"的能力声明，语义是模型**能选什么**），并非默认值选择（模型**默认选什么**）；本插件读取的 `reasoning` 依赖其设置解析对未声明键的透传行为。若上游收紧解析策略，这部分提取会静默失效（届时请改用方式 3 / 方式 4 显式声明）。另注意：注入的默认等级若不在目标模型 `reasoningEfforts` 声明集合内，会被适配器拒绝。
> - 每个来源只认单一规范字段：`llm-pi-ai` 用 `reasoning`，`llm-deepseek` 用 `reasoningEffort`，两者不可混写。

### 方式 3：在插件配置中按 Provider/Model 结构声明

插件的配置通过 loader 补丁体系按 entry id 定位。在用户补丁层（如 `~/.dsh/profiles/<profile>/cordis.patch.yml`）按同一 id 覆盖 `config`：

```yaml
# cordis.patch.yml
- id: model-reasoning-defaults
  config:
    # 全局兜底
    reasoningEffort: low

    # 跨 Provider 通用模型默认值
    models:
      o3-mini: high

    # 按 Provider 组织
    providers:
      my-gateway:
        reasoningEffort: medium
        models:
          deepseek-reasoner: high
          deepseek-chat: low
      another-gateway: low
```

### 方式 4：扁平路由映射字典

直接使用扁平的 `defaults` 路由字典，与结构化形式是同等的配置入口：

```yaml
# cordis.patch.yml
- id: model-reasoning-defaults
  config:
    defaults:
      "my-gateway:deepseek-reasoner": "high"
      "my-gateway:*": "medium"
      "*:o3-mini": "high"
      "*": "low"
```

> [!TIP]
> 各配置形式可以自由组合，归一化到同一张路由表后统一检索。命中由上表的**键特异性**全局裁决，与配置来自哪个文件无关；来源仅在**同一路由键**冲突时按以下优先级覆盖（高 → 低）：
>
> 1. 插件 cordis 配置（patch 层 `defaults` 显式路由键 > 结构化 `providers`/`models` 项）
> 2. 设置页 UI（`model-reasoning-defaults` 命名空间，方式 1）
> 3. 设置服务自动提取项（`llm-pi-ai` / `llm-deepseek` 原生字段，方式 2）
>
> 例如设置服务给出精确键 `my-gateway:deepseek-reasoner: high`、插件仅配通配键 `providers.my-gateway = medium` 时，精确键胜出（得 `high`）。

---

## 工作机制与架构原理

插件通过双层拦截架构，在保持与 DSH 宿主解耦的同时，确保所有调用路径行为一致：

```
                           [LLM Request Entry]
                                    │
         ┌──────────────────────────┴──────────────────────────┐
         ▼                                                     ▼
  【Agent Loop 请求】                                   【手写 / 辅助请求】
  (agent/request Waterfall)                             (llm.stream / prepareCall)
         │                                                     │
  注入默认 reasoningEffort                          isAgentLoopRequest 判定
  到调用配置种子（loop 随后据此构建完整                     │
  请求并深冻结、打宿主进程标识）              ┌─────────────┴─────────────┐
         │                                       ▼                           ▼
         │                                [loop 请求命中]               [手写请求未命中]
         └───────────────────┬───────────────────┘                           │
                             │                                          浅复制对象并注入
                             ▼                                          默认 reasoningEffort
                    按原引用透传，保留 Process-local 标记                     │
                             │                                              │
                             └───────────────────┬──────────────────────────┘
                                                 ▼
                                        进入真实 llm.stream / Waterfall
```

### 1. Agent 主循环请求处理
- 注册全局 `agent/request` waterfall 监听器。此阶段操作的是调用配置种子，完整请求对象尚未构建；插件按路由计算默认等级并注入 `reasoningEffort`。
- loop 随后将该配置连同派生消息组装为完整请求，深冻结并打上宿主 `markAgentLoopRequest` 进程标识。
- 请求进入 `llm.stream` 入口时，入口包装用宿主导出的 `isAgentLoopRequest` 识别 loop 请求，**直接按原引用透传**——浅复制会丢失该进程标识，导致 compaction 与请求观察者把会话请求误判为手写一次性请求。

### 2. 手写及辅助调用处理
- 直接调用 `llm.stream(options)` 时，入口包装在 waterfall **开始前**执行拦截。
- 对不带 loop 标识的请求（包括带 `purpose: 'compaction'` 的辅助请求），通过浅复制补齐 `reasoningEffort` 后再进入下游链路。

### 3. 配置准备与解析入口
- 同步拦截 `llm.prepareCall` 与 `llm.resolveCallConfig`，在预计算阶段统一应用相同的路由查找规则，并完整透传 `AbortSignal`。

### 4. 共享状态与热重载安全
- LLM 方法包装层内部维护 `RuntimePatchState`，通过 `defaults: Map<symbol, ReasoningDefaults>` 跟踪每个活跃 Fiber 的配置版本。
- 插件重新加载时，新 Fiber 创建的配置层会立即生效并覆盖旧配置；旧 Fiber 卸载时仅移除自身 token，只有当所有 Fiber 都卸载时才彻底还原原始 LLM 方法。

---

## 客户端支持

本插件包含 Web 客户端扩展（`src/client/index.ts`）：
- 注册到 DSH 设置页槽位 `settings.section`（「推理等级默认」面板）：增删路由行、从已知等级集合下拉选择，保存写入本插件的 `model-reasoning-defaults` 设置命名空间。
- 数据经宿主统一 settings Remote（`remote.settings.describe` / `update`）实时读取渲染；保存携带 `expectedRevision` 修订号，并发编辑时由宿主裁决而非静默覆盖。
- 路由键输入带建议弹层（来自 `llm-pi-ai` / `llm-deepseek` 已配置的 Provider/Model），面板内展示匹配语义与生效优先级说明。

---

## 开发与构建

本项目为**自包含 npm 工程**，所有 `@deepseek-ai/*` 依赖通过 lockfile 统一锁定，无需本地关联宿主源码。

### 常用命令

```bash
# 安装依赖
pnpm install

# 完整构建（产出 Node ESM、浏览器 CJS bundle 及对应类型定义声明）
pnpm build

# 类型检查（依次检验 Host、Client 和 Tests）
pnpm typecheck

# 运行单元测试
pnpm test

# 监听开发（实时重编译 host 与 client 产物）
pnpm dev
```

### Profile 安装与卸载（本地开发）

本地开发时以符号链接形式装入 DSH Web Profile：

```bash
dsh plugin --profile web add link:"$PWD"
```

卸载插件：

```bash
dsh plugin --profile web remove dsh-model-reasoning-defaults
```

### 构建产物结构

`pnpm build` 由 `tsdown` 与 `tsc` 联合驱动：
- `lib/index.mjs` + `lib/index.d.mts`：Host 端 Node ESM 产物与声明文件。
- `lib/client.js`：由 DSH `__ModuleLoader__` 包装的浏览器端 CJS 产物。
- `lib/types/client/index.d.ts`：通过 `tsconfig.client.json` 独立生成的客户端类型声明。

---

## 注意事项与设计说明

1. **推理等级有效性校验时机**：
   配置阶段仅校验字符串非空，具体推理等级（如 `low` / `medium` / `high`）是否被目标模型支持，由 DSH 底层适配器在实际发起请求时校验（未支持将抛出 `UNSUPPORTED_REASONING_EFFORT`）。插件会在激活时与设置提取过程中对照已知等级集合（`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`）提示可疑取值，但不阻断注入，以便上游新增等级时无需同步升级本插件。
2. **会话持久化影响**：
   由插件注入的默认值经 `llm.prepareCall` 后将作为显式参数写入请求头。在长会话进行中若热更新修改了配置规则，已创建的历史请求头不会被回溯修改。
3. **发布与打包约束**：
   本包以 Profile Bundle 形式发布到 npm，`dsh plugin add` 即可安装。`@deepseek-ai/*` 与 `react` 均配置为 external import，运行时实例由宿主环境统一提供。

---

## 贡献指南

欢迎提交 [Issue](https://github.com/xht-code/dsh-model-reasoning-defaults/issues) 与 Pull Request：

1. Fork 本仓库并新建特性分支；
2. 本地运行 `pnpm install` 安装依赖，确保 `pnpm test` 与 `pnpm typecheck` 全部通过；
3. 提交信息请遵循 [Conventional Commits](https://www.conventionalcommits.org/) 规范，并使用中文描述；
4. 通过 Pull Request 合入 `main` 分支，说明改动动机与验证方式。

---

## 开源协议

本项目基于 [MIT](./LICENSE) 协议开源。

Copyright (c) 2026 [xht-code](https://github.com/xht-code)
