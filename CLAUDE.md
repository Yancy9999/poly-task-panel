## Working rules

### Version bump

迭代版本号时按 `docs/agents/version-bump.md` 的清单执行（共 7 处，含 package-lock 两处与 Cargo.lock 本包条目），改完用清单里的 grep 核验命令检查残留。

### Toast：成功不提示，失败才提示

操作成功时不弹任何成功 toast——界面上的状态刷新（列表重渲染、徽标更新、tab 内容变化）本身就是反馈。只有失败才弹 toast（error/warning），失败提示必须保留且说明原因。此规则适用于所有面板与弹窗（Git 抽屉的推送/拉取/提交/撤回/切分支、文件编辑器的保存/创建/重载、设置保存等）。

## 开发原则

- **先确认再动手（最高优先级）**：收到任何开发类需求后，**禁止立即写代码**。必须按以下流程进行：
  1. **理解需求**：通读需求，必要时探索相关代码以掌握现状；
  2. **复述确认**：用自己的话向用户复述需求要点（要做什么、范围、预期结果），并指出我注意到的歧义、遗漏或风险；
  3. **征求许可**：明确询问"是否开始开发？"，**只有当用户明确给出"开始写代码 / 开始开发 / 动手吧"等指令后**，才进入编码。
  - 在未获许可前，只可进行需求理解、代码阅读、方案探讨与确认，**不得创建或修改任何源代码文件**（脚手架/配置/文档类改动同样需先确认）。
- **先思考再编码**：不确定就问，有多种解读时全部呈现，不静默选择。
- **精准修改**：只改必须改的，匹配现有风格。自己的改动产生的孤儿代码（import/变量/方法）必须清理。
- **目标驱动**：把任务转化为可验证目标，多步骤任务给出简要计划并标注验证方式。
- **测试驱动开发（TDD）**：红-绿-重构——先写失败测试，再写最小实现使其通过。

## Agent skills

### Issue tracker

Issues 作为 markdown 文件存放在 `.scratch/<feature>/` 下（local-markdown tracker）。See `docs/agents/issue-tracker.md`.

### Triage labels

五个 canonical roles 的 label string 与 role name 相同：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。See `docs/agents/triage-labels.md`.

### Domain docs

Single-context 布局：repo root 下一个 `CONTEXT.md` + `docs/adr/`。See `docs/agents/domain.md`.
