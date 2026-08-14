# dsh-tool-browser

[![npm version](https://img.shields.io/npm/v/dsh-tool-browser)](https://www.npmjs.com/package/dsh-tool-browser)
[![npm downloads](https://img.shields.io/npm/dm/dsh-tool-browser)](https://www.npmjs.com/package/dsh-tool-browser)
[![License](https://img.shields.io/npm/l/dsh-tool-browser)](https://github.com/MashedPotato817/dsh-tool-browser)

给 DeepSeek Harness（DSH）的**原生浏览器自动化工具插件**，由 Playwright 驱动。
默认直接使用本机安装的 **Microsoft Edge**（`channel: "msedge"`，无需下载浏览器），
Edge 缺失时自动回退到 Playwright 自带的 Chromium。

## 能力

面向模型的只读/交互工具（全部注册进 DSH 的 `ctx.tools`）：

| 工具 | 作用 |
|---|---|
| `browser_navigate` | 打开 URL，返回标题与最终地址 |
| `browser_snapshot` | 返回页面可见文本（body innerText，限长） |
| `browser_click` | 按 CSS 选择器点击元素 |
| `browser_type` | 按 CSS 选择器向输入框填入文本 |
| `browser_press_key` | 按键盘键（Enter / Escape 等） |
| `browser_evaluate` | 在页面执行 JS 表达式并返回 JSON 结果 |
| `browser_take_screenshot` | 截图保存为 PNG，返回文件路径 |
| `browser_console_messages` | 返回页面控制台消息 |
| `browser_wait_for` | 等待固定毫秒数 |
| `browser_back` | 返回上一页 |
| `browser_fill_form` | 一次填多个表单字段 |
| `browser_select_option` | 下拉框选择选项 |
| `browser_hover` | 悬停元素 |
| `browser_drag` | 拖拽（源元素 → 目标元素） |
| `browser_resize` | 调整视口尺寸 |
| `browser_open_tab` | 新开标签页（可带 URL） |
| `browser_tabs` | 列出所有标签页 |
| `browser_switch_tab` | 切换到指定标签页 |
| `browser_close_tab` | 关闭当前标签页 |

设计要点：

- **共享页面**：插件实例维护一个浏览器 + 一个页面，会话内浏览状态连续；工具默认互斥（非并发安全），避免相互干扰。
  - 限制：使用该插件的所有会话共享同一个页面，跨会话会互相影响；需要隔离时请用独立 profile 实例。
- **中止安全**：每个工具转发 `exec.signal`，超时/中止策略不会挂死 agent 回合。
- **结果结构化**：全部返回 `{ text }`，快照/求值结果限长，控制 KV cache 影响。

## 安装

已发布到 npm，一条命令安装（推荐，自动拉取 registry 最新版）：

```bash
dsh plugin --profile <name> add dsh-tool-browser
```

GitHub / 本地开发备选：

```bash
dsh plugin --profile <name> add https://github.com/MashedPotato817/dsh-tool-browser.git
# 或本地：dsh plugin --profile <name> add /path/to/dsh-tool-browser
```

在 profile 的 `cordis.patch.yml` 里启用：

```yaml
- insert:
    - id: dsh-tool-browser
      name: dsh-tool-browser
      config:             # 可选，下列为默认值
        channel: msedge    # 浏览器 channel
        headless: true
        allowedHosts: []   # 空 = 允许全部 host
```

## 快速开始

三步即可在 DeepSeek Harness（DSH）里获得浏览器自动化能力：

```bash
# 1. 安装插件
dsh plugin --profile <name> add dsh-tool-browser

# 2. 在 cordis.patch.yml 里 insert 启用（见上）

# 3. 启动 DSH 后，模型会自动拥有 browser_* 工具，直接在对话里让 agent 操作浏览器：
#    「打开 https://example.com 并截图」
```

### 调用示例

安装并启用后，这些工具会注册进 DSH 的 `ctx.tools`，agent 无需额外 import 即可直接调用：

```js
// 在 DSH 插件 / 对话中，模型按工具名直接调用，无需手工引用
await ctx.tools.browser_navigate({ url: "https://example.com" });
await ctx.tools.browser_snapshot({});
await ctx.tools.browser_click({ target: "button#submit" });
await ctx.tools.browser_evaluate({ script: "document.title" });
await ctx.tools.browser_take_screenshot({});
```

> 工具名与 DSH 内置 `browser_*` 能力一一对应，完整清单见上文「能力」表。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `channel` | `msedge` | Playwright 浏览器 channel（`msedge` / `chrome` / 缺省=自带 Chromium） |
| `allowedHosts` | `[]` | 允许访问的 host 白名单（空=全部允许，`*`=全部，如 `example.com`）；`data:`/`about:` 始终允许 |
| `headless` | `true` | 无头模式（调试可设 `false`） |
| `outputDir` | 系统临时目录 | 截图输出目录 |
| `timeoutMs` | `60000` | 工具调用总超时 |
| `navigationTimeoutMs` | `60000` | 页面导航超时 |
| `actionTimeoutMs` | `10000` | 单次动作（点击/输入）超时 |
| `snapshotMaxChars` | `12000` | snapshot 文本上限 |
| `evaluateMaxChars` | `4000` | evaluate 结果上限 |
| `viewportWidth/Height` | `1280x720` | 视口尺寸 |

## 开发

```bash
npm install
npm run check   # 语法校验
npm test        # smoke + 真实浏览器集成测试（本机 Edge；CI 用自带 Chromium）
```

## License

MIT
