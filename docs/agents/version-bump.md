# Version bump checklist

发布新版本时按此清单更新版本号，一处都不漏。以迭代到 `X.Y.Z` 为例。

## 需要更新的文件（共 7 处）

| # | 文件 | 位置 | 说明 |
|---|------|------|------|
| 1 | `package.json` | `"version"` | npm 包版本 |
| 2 | `package-lock.json` | 顶部 + `"packages"` 内**两处** `"version"` | 历史上曾漏过（长期停在 1.1.0），务必检查 |
| 3 | `src-tauri/tauri.conf.json` | `"version"` | Tauri 应用版本，窗口标题 `v{version}` 与 NSIS 安装包版本均取自此 |
| 4 | `src-tauri/Cargo.toml` | `version` | Rust crate 版本 |
| 5 | `src-tauri/Cargo.lock` | `name = "poly-task-panel"` 条目下的 `version` | **只改本包条目**，同名版本号的第三方依赖（如 `autocfg`）不要动 |
| 6 | `README.md` | 顶部 `版本：**X.Y.Z**` | |
| 7 | `ABOUT.md` | 顶部 `**版本**：X.Y.Z` + 新增 `## X.Y.Z 更新` 小节 | 更新日志写在最上面，旧版本小节依次下移 |

## 不需要手动改的

- `src-tauri/gen/schemas/` — Tauri 构建时自动生成
- `src-tauri/target/` — 构建产物，下次 `build.bat` 自然带上新版本
- `server.js` / `public/index.html` / `test/` — 无硬编码版本号；UI 若要显示版本应动态读取，不要写死

## 核验命令

改完后跑一遍，确认没有残留旧版本号（排除依赖自身版本与构建产物）：

```bash
grep -rn "旧版本号" \
  --include="*.json" --include="*.toml" --include="*.md" \
  --exclude-dir=node_modules --exclude-dir=target \
  . | grep -v node_modules
```

预期：只剩第三方依赖自身的版本号命中（如 `autocfg 1.5.1`），以及 `ABOUT.md` 里历史更新日志小节标题。

## 快捷方式（Linux/Git Bash）

```bash
VER=1.5.2
sed -i "s/\"version\": \"旧版本\"/\"version\": \"$VER\"/" package.json package-lock.json src-tauri/tauri.conf.json
sed -i "s/^version = \"旧版本\"/version = \"$VER\"/" src-tauri/Cargo.toml
```

`Cargo.lock`、`README.md`、`ABOUT.md` 建议手动改（lock 要精确定位本包条目，文档要写更新日志）。
