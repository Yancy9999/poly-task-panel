此目录存放打包进 release 的固定版本 node 二进制（node.exe，约 87MB）。

node.exe 不入库（.gitignore 忽略 bundled-node/），由 `src-tauri/fetch-node.js`
在 `tauri build` 前（build.bat 已接入）从 nodejs.org 下载生成。

为什么需要：node-pty 是 native addon，release 运行时用打包的 node.exe
（而非用户 PATH 上的 node）跑 server.js，确保 node-pty 的 .node 二进制 ABI
与运行时 node 必然匹配，消除 ABI 错配风险。详见 memory
`claude-terminal-packaging-node-abi` 与 spec `../.scratch/claude-terminal/spec.md`。

此 README.txt 仅用于让目录在 git 中存在（resources 配置要求目录非空），
保证 dev 构建（cargo check / tauri dev，不依赖 node.exe）也能通过资源校验。
