## Working rules

### Version bump

迭代版本号时按 `docs/agents/version-bump.md` 的清单执行（共 7 处，含 package-lock 两处与 Cargo.lock 本包条目），改完用清单里的 grep 核验命令检查残留。

### No coding before explicit approval

在我没有明确说"开始写代码 / 开始开发 / 动手吧"等指令之前，绝对禁止写任何代码。收到需求后应先理解需求，向用户复述确认，并询问是否需要开始开发；得到明确许可后才开始写代码。

## Agent skills

### Issue tracker

Issues 作为 markdown 文件存放在 `.scratch/<feature>/` 下（local-markdown tracker）。See `docs/agents/issue-tracker.md`.

### Triage labels

五个 canonical roles 的 label string 与 role name 相同：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。See `docs/agents/triage-labels.md`.

### Domain docs

Single-context 布局：repo root 下一个 `CONTEXT.md` + `docs/adr/`。See `docs/agents/domain.md`.
