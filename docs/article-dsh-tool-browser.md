# 给 DSH 做原生浏览器自动化插件：dsh-tool-browser 开发记录

## 为什么做

DSH（DeepSeek Harness）缺少浏览器能力。先接现成 **Playwright MCP**（微软官方包，24 个工具，零代码）探路，确认可行后决定做**原生插件**：
不依赖 MCP 中间层、深度集成 DSH 的 tools / 审批 / 结果结构化、可发布可扩展。

## 调研结论

- 官方 200 个 `@deepseek-ai/dsh-*` 包里无浏览器工具；
- npm 候选名（`dsh-tool-browser` 等）全部空闲；
- 社区（dsh-plugin topic / awesome 列表）无人做过；
- → 值得做，包名 `dsh-tool-browser` 可用。

## 架构

- **BrowserSession**：一个浏览器 + 多标签页列表（`pages[]` + 激活索引），Edge 优先（`channel: "msedge"`，用户本机已有，免下载），缺失时回退自带 Chromium。
- **19 个工具**：页面（navigate / back / snapshot / screenshot）、交互（click / type / fill_form / select_option / hover / drag / press_key）、数据（evaluate / console_messages / wait_for）、标签页（open_tab / tabs / switch_tab / close_tab）、视口（resize）。
- **中止安全**：每个工具转发 `exec.signal` + `withAbort`，超时/中止不会挂死 agent 回合。
- **安全**：`allowedHosts` 白名单（空=全放行）；工具默认互斥（共享会话，非并发安全）。
- **无视觉模型设计**：`browser_snapshot`（文本）是模型读页面的主通道；`browser_evaluate` 拿结构化数据；截图存文件给人/视觉模型看。

## 踩坑记录

1. **无视觉模型怎么"看"页面**：模型读的是 `snapshot` 的文本，不是截图；截图只存档。当前模型 `deepseek-v4-flash` 无图像输入，`read_image` 会失败——这是模型能力边界，不是插件问题。
2. **Chrome 下载 191.8 MiB**：改用本机 **Edge**（MCP 的 `--browser msedge` / 插件的 `channel: "msedge"`），省掉整个下载。
3. **Windows 上 spawn `.cmd` 的 EINVAL**：DSH 的 subprocess 用普通 spawn（不经 shell），直接跑 `npx`（`.cmd`）会 EINVAL；MCP 配置因此改用 `node` 直跑 cli.js。原生插件直接用 `playwright` 库，无此问题。
4. **evaluate 结果双重 JSON 序列化**：`browser_evaluate` 总是 JSON 序列化返回值；测试里表达式返回数组（而非 JSON 字符串）才不会双重转义。
5. **沙箱命名管道限制**（测试环境）：`git stash` 等需要管道；集成测试用「文件描述符重定向」绕开；真实用户环境无此限制。

## 工程

- **测试**：`smoke`（注册断言）+ 真实浏览器集成测试（本机 Edge；CI 无 Edge 时回退自带 Chromium）。
- **CI**：GitHub Actions，Node 20/22，ubuntu + `npx playwright install --with-deps chromium`，actions v5。
- **健壮性**：启动 30s 超时、浏览器崩溃自愈（下次调用自动重连）、错误带工具名前缀、URL 白名单。
- **发布**：GitHub Release + npm（`dsh plugin add dsh-tool-browser`）。

## 经验

- **先接现成（MCP）探路，再写原生**——确认价值与形态，避免盲目从零做。
- **Edge 优先，不下载浏览器**——用户本机已有的资源优先利用。
- **无视觉模型靠文本通道**——`snapshot`/`evaluate` 是主力，截图是存档/给人看。
- **一步一步来，先保证强壮性**：最小闭环 → 扩展工具 → 健壮性 → 测试/CI → 发布。
