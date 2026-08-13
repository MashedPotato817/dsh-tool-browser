# dsh-tool-browser 使用指南

## 安装

三种方式（按推荐排序）：

```bash
# 1) npm（发布后可用，最简）
dsh plugin --profile <name> add dsh-tool-browser

# 2) GitHub 仓库
dsh plugin --profile <name> add https://github.com/MashedPotato817/dsh-tool-browser.git

# 3) 本地源码（开发调试）
dsh plugin --profile <name> add /path/to/dsh-tool-browser
```

启用（在 `~/.dsh/profiles/<name>/cordis.patch.yml`）：

```yaml
- insert:
    - id: dsh-tool-browser
      name: dsh-tool-browser
```

## 配置

| 键 | 默认值 | 说明 |
|---|---|---|
| `channel` | `msedge` | 浏览器 channel；设 `chrome` 或删掉用自带 Chromium |
| `headless` | `true` | 无头模式；调试时可设 `false` 看真实窗口 |
| `allowedHosts` | `[]` | host 白名单（空=全部放行，`*`=全部，如 `example.com`） |
| `outputDir` | 系统临时目录 | 截图保存目录 |
| `timeoutMs` | `60000` | 工具调用总超时 |
| `snapshotMaxChars` | `12000` | snapshot 文本上限 |
| `evaluateMaxChars` | `4000` | evaluate 结果上限 |

## 19 个工具

**页面**：`browser_navigate`（打开 URL）、`browser_back`（返回）、`browser_snapshot`（读页面文本）、`browser_take_screenshot`（截图存档）
**交互**：`browser_click`（点击）、`browser_type`（输入）、`browser_fill_form`（多字段表单）、`browser_select_option`（下拉）、`browser_hover`（悬停）、`browser_drag`（拖拽）、`browser_press_key`（按键）
**数据**：`browser_evaluate`（执行 JS 取结构化数据）、`browser_console_messages`（控制台）、`browser_wait_for`（等待）
**标签页**：`browser_open_tab`、`browser_tabs`、`browser_switch_tab`、`browser_close_tab`
**视口**：`browser_resize`

## 典型用法（对模型说的话）

**打开网页并截图**
> 用浏览器打开 https://example.com，截图保存，然后告诉我页面标题和主要内容。

模型流程：`browser_navigate` → `browser_snapshot`（读文本）→ `browser_take_screenshot`（存档）

**读复杂页面（无视觉模型）**
> 打开 https://github.com/xxx，用 browser_snapshot 读取页面内容，总结 README。

**填表单并提交**
> 打开登录页，用 browser_fill_form 填用户名和密码，再点提交按钮。

**多标签对比**
> 用 browser_open_tab 开两个标签，分别打开 A 和 B 页面，来回切换对比内容。

**测试网页游戏**
> 打开 index.html，用 browser_evaluate 检查 canvas 是否初始化，再截图看看渲染结果。

## 给模型的提示词片段

> 浏览网页时：先 `browser_navigate` 打开，再 `browser_snapshot` 读文本决定下一步；需要视觉细节时用 `browser_take_screenshot`（给人/视觉模型看）；拿结构化数据用 `browser_evaluate`。
