<p align="center">
  <a href="README.md">English</a> |
  <a href="README.ko.md">한국어</a> |
  <strong><a href="README.zh.md">简体中文</a></strong> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.fr.md">Français</a>
</p>

# Agent Tracker

在 VS Code 中查看 Claude 和 Codex 的当前用量及重置倒计时，并通过对话日志追踪 Token 消耗与耗时的扩展。

## 主要功能

### 在状态栏查看用量

- **当前用量** — 在 VS Code 状态栏查看 Claude 和 Codex 的订阅用量比例及重置倒计时。
- **详情卡片** — 点击即可查看 5 小时和每周用量、重置时间，以及 Codex 可用的用量重置次数。
- **自动与手动刷新** — 默认每 15 分钟查询一次，也可点击刷新按钮立即更新。

![状态栏与用量详情卡片](resource/readme/at-1.png)

### 按对话、时间段和模型比较 Token 与耗时

- **Token 与耗时统计** — 通过表格和图表，按对话、日、月、项目或模型查看总 Token 数、每次请求的平均 Token 数和平均耗时。
- **使用记录** — 查看技能、插件、子代理和模型的使用次数及占比。
- **改进使用方式** — 比较更换模型或引入技能、插件前后的每次请求平均 Token 数与耗时，调整代理的使用方式。

![按模型统计的平均 Token 数与技能使用统计](resource/readme/at-2.png)

点击卡片中的 **使用统计**，或在命令面板运行 **Agent Tracker：打开使用统计**。打开统计页面时，扩展会根据本地对话日志计算统计数据。

## 安装与卸载

### 安装

需要 Node.js **22.15 及以上**、VS Code **1.101 及以上**，且终端中可以运行 `code` 命令。请先通过 Claude Code 或 Codex CLI 登录。

```sh
npx agent-tracker-vscode@latest
```

如需通过 npm 全局安装安装器命令，请运行：

```sh
npm install -g agent-tracker-vscode@latest
agent-tracker-vscode
```

安装后，在 VS Code 命令面板运行 **Developer: Reload Window**。更新时使用相同的安装命令。macOS 上若没有 `code` 命令，请先运行 **Shell Command: Install 'code' command in PATH**。

如需安装到指定配置文件，请使用已创建的配置文件名称：

```sh
npx agent-tracker-vscode@latest --profile "Work"
```

再次点击状态栏项目以关闭卡片，需要应用可选的 [本地 VS Code 补丁（韩语说明）](docs/research/StatusBarPopup.md)。

### 卸载

在 VS Code 扩展列表中选择 **Agent Tracker → 卸载**，或运行：

```sh
code --uninstall-extension agent-tracker.agent-tracker
```

如果安装时指定了配置文件，请在卸载命令中也添加 `--profile "Work"`。如需同时删除全局安装的 npm 包，请运行：

```sh
npm uninstall -g agent-tracker-vscode
```

npm 包和 VS Code 扩展需要分别卸载。

## VS Code 扩展设置

点击卡片中的 **设置**，或在 VS Code 设置中搜索 `@ext:agent-tracker.agent-tracker`。
以下设置键均以 `agentTracker.` 为前缀。

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `language` | `auto` | 跟随 VS Code 语言。可选择韩语、英语、简体中文、日语、西班牙语或法语 |
| `claude.enabled` / `codex.enabled` | `true` | 分别启用各提供商的用量查询与日志统计 |
| `quota.refreshPolicy` | `automatic` | 自动查询。`manual` 仅在点击刷新时查询 |
| `quota.pollingIntervalSeconds` | `900` | 自动查询间隔（秒），最小 30 秒；非活动窗口中暂停 |
| `codex.showStatusBar` | `true` | 在状态栏显示 Codex，隐藏后仍继续查询用量 |
| `display.percentage` | `used` | 显示已用比例；`remaining` 显示剩余比例 |
| `display.detail` | `detailed` | 显示 7 天和 5 小时用量；`compact` 仅显示 5 小时用量 |
| `display.colorMode` | `automatic` | 使用主题颜色，也可选 `white`、`black` 或 `custom` |
| `display.customColor` | `#ffffff` | `custom` 模式使用的 HEX 颜色 |
| `codex.showReserve` | `false` | 显示账户提供的 GPT Reserve 用量 |
| `codex.showResetCredits` | `true` | 显示账户提供的用量重置次数及下一次到期时间 |
| `usage.enabled` | `true` | 启用本地对话日志的 Token 与耗时统计 |
| `usage.skillsEnabled` | `true` | 统计技能、插件、子代理和模型的使用次数 |
| `usage.showApiCosts` | `false` | 显示估算的 API 费用（美元），订阅使用显示为 0 |
| `usage.excludeEmptyUsage` | `true` | 图表和平均值排除既无模型信息也无 Token 信息的请求，表格中仍保留 |
| `usage.timezone` | 系统时区 | 日、月统计的时区，例如 `Asia/Seoul` |
| `dataHome` | `~` | 包含 `.claude` 和 `.codex` 的共同父文件夹，在用户设置中指定 |
| `claude.cleanupPeriodDays` | `null` | Claude 日志保留天数。大于等于 1 时写入 Claude 设置；`null` 保留现有值 |
| `codex.executable` | `codex` | Codex CLI 命令或可执行文件路径 |

运行 **Agent Tracker：删除统计数据** 可清空汇总结果。原始对话日志会保留，重新打开统计页面时会重新计算。

[使用与开发参考（韩语）](docs/Development.ko.md)
