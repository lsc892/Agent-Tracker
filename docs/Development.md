# Agent Tracker Usage and Development Reference

[Project overview](../README.md) · [한국어](Development.ko.md)

Agent Tracker is a VS Code extension that shows Claude and Codex subscription usage and token usage per request from local conversation logs.

- **Quota**: A shared status bar item displays Claude and Codex logos, remaining quota bars, usage percentages, and reset times.
- **Usage**: Totals and averages by day, month, project, session, and user request. The toggle next to the provider selector switches both charts and tables between provider and model views.
- **Skill statistics**: Usage counts and overall percentages for skills, subagents, plugins, and models by project and period. Bars in every table show usage relative to the most frequently used item.
- **API costs**: Subscription usage is shown as zero. Estimated USD costs for prepaid API usage are stored by model and token usage; an extension setting controls whether they are displayed.
- **Data diagnostics**: A link at the bottom of the statistics view opens a separate Webview showing file processing status, error locations, quality warnings, and requests whose previous valid statistics were retained.
- **Display language**: Follow the VS Code language automatically, or choose Korean, English, Simplified Chinese, Japanese, Spanish, or French.

## Running the extension

With Node.js 22.15 or later, run the following commands and press **F5** in VS Code. VS Code 1.101 or later is required, and its extension host must include the built-in `node:sqlite` module.

```sh
npm ci
npm run build
```

After applying the local VS Code patch described below, **click the Claude/Codex usage item in the status bar to open a card directly above it, and click again to close it.** When the card is closed, hovering shows each provider's remaining 5-hour quota, time until reset, and a `Click to open/close` hint. This summary hover is hidden while the card is open, and the card stays open when you move the pointer away. Click outside the card or press Esc to close it. The card shows usage percentages, remaining quota, reset times, query status, and the last refresh time for every quota window. The `Detailed` and `Compact` links change how much information appears in the status bar: detailed mode shows 7-day and 5-hour usage, while compact mode shows only 5-hour usage. The card shows all quota windows in both modes. The `Usage statistics` link opens the statistics Webview; the `Settings` link directly below it opens the Agent Tracker extension settings in VS Code. You can also open statistics through **Agent Tracker: Open Dashboard** or **Agent Tracker: Open Usage Statistics** in the Command Palette.

The card displays colored bars and usage percentages for `5h` and `wk` side by side, with the time until reset directly below each item. Usage is yellow at 50% or higher, red at 80% or higher, and green below those thresholds. Additional quota windows appear on separate lines. **Codex: Show Reserve** defaults to OFF and displays a separate usage limit whose server-provided identifier or name is `gpt-reserve`. This setting also applies when the identifier is `base_model_inference` and the name is `gpt-reserve`. **Codex: Show Reset Credits** defaults to ON and shows the number of available usage resets and their next expiry when provided by the server. If expiry details are unavailable, only the count is shown. Setting changes immediately update the display of cached quota. [Codex App Server responses](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt)

The refresh button on the right and the refresh link at the top of the tooltip query only the current quota of tracked providers. While a query is running, the link is replaced by refresh status text. There are no separate refresh or extension management links for individual providers. The tooltip's refresh action appears on the right of the title row. Logo SVGs and the icon font used in the status bar and tooltip are included in `resource/icon`.

Use the following command to create a VSIX. Install the resulting `agent-tracker-0.1.2.vsix` through **Extensions: Install from VSIX...** in VS Code.

```sh
npm run package
```

### Publishing to npm and installing with npx

The separate npm installer package, `agent-tracker-vscode`, includes the VSIX, installs it through the VS Code CLI, and verifies the installed extension ID and version. Users can install or update it with the following commands. Node.js 22.15 or later and the VS Code `code` command on PATH are required.

```sh
npx agent-tracker-vscode@latest
npx agent-tracker-vscode --profile "Work" # Install into a specific profile
npx agent-tracker-vscode --code code-insiders # Select a different VS Code CLI
```

After installation, run **Developer: Reload Window** in an open VS Code window. The installer uses the default profile unless `--profile` is specified. Create the named profile in VS Code first; installation fails if it does not exist. Run `npx agent-tracker-vscode --help` to see all options. On macOS, first run **Shell Command: Install 'code' command in PATH**.

Create the npm tarball to publish from the repository root. The extension's root `package.json` retains `private: true`, while the npm distribution manifest is maintained in `tools/npm/manifest.json`. The version, license, repository, and required Node version come from the extension manifest. The installer uses a separate name because `agent-tracker` is already used by another project on npm.

```sh
npm ci
npm run check
npm run package:npm
npm login --registry https://registry.npmjs.org --auth-type=web
npm publish ./artifacts/npm/agent-tracker-vscode-0.1.2.tgz --access public
```

`package:npm` rebuilds the VSIX from the current source and creates `artifacts/npm/agent-tracker-vscode-<version>.tgz` containing exactly five files: the CLI, extension metadata, VSIX, README, and manifest. The package uses the root `README.md`, whose image and documentation URLs also work on npm. Publishing to npm is a separate command. For subsequent releases, increment the extension version and repeat the same steps. An authenticated npm account with publishing permission is required; complete 2FA if your account settings require it. Before publishing, you can check npx execution from the local tarball as follows:

```sh
npx --yes --package ./artifacts/npm/agent-tracker-vscode-0.1.2.tgz agent-tracker-vscode --help
```

Installation through npm follows the existing extension setup process: configure Claude/Codex CLI logins and the optional workbench patch separately. The installer CLI does not apply the workbench patch.

The click toggle connects to VS Code's internal `ToggleTooltipCommand`, so it requires a local workbench patch in addition to VSIX installation. Run the following commands from the repository root, then **close every VS Code window and restart VS Code.** Reloading a window alone may leave the installation corruption warning because the main process still holds the previous checksum values. Ordinary builds and extension activation do not modify VS Code installation files.

```sh
npm run patch:vscode
npm run patch:vscode -- --check # Check the patch status
npm run restore:vscode         # Restore the original files
```

The patch backs up the original files and integrity information, and connects only Agent Tracker's click command to the internal toggle object. Automatic hover shows a short summary; clicking shows the full card. Summary hover is blocked while the card is open, while hover on other items is preserved. Earlier v1 and v2 patches are upgraded to v3 with their original backups preserved. Actual hover and click behavior was verified in VS Code 1.140.0. Reapply the patch after updating VS Code; the patch stops if it encounters an unsupported internal structure. Default Windows installations are discovered from environment variables and the selected CLI. For other installations, specify `--cli <path to code.cmd>`, `--executable <executable path>`, or `--app-root <resources/app path>`. Without the patch, VS Code's default hover and click-to-open behavior is used, and clicking again to close the card is unavailable.

## Display language

Choose a display language under **Language → Language** in the extension settings. By default, the extension follows the VS Code display language. Korean, English, Simplified Chinese, Japanese, Spanish, and French are supported. Open views and the status bar update immediately when the language changes. Unsupported languages and missing translations fall back to Korean. Command Palette labels and VS Code setting descriptions follow the VS Code display language. See the [localization document (Korean)](research/Localization.md) for the structure and how to add a language.

## Authentication and paths

The extension uses CLI login information from the same environment in which it runs. Sign in through Claude Code or the Codex CLI first. Codex API key accounts are not shown as having ChatGPT subscription quota.

Set a single shared parent folder in user settings under **Data and logs → Data Home**. For example, `D:\AgentData` makes Claude use `D:\AgentData\.claude` and Codex use `D:\AgentData\.codex`. The default, `~`, means the user home directory; an empty value uses the same location. The path set in user settings applies to every workspace. For WSL, SSH, or containers, set it in the user settings of that environment. Subscription usage queries, log collection, session titles, and Claude log retention all use this shared location. The four separate data home/log root settings and the `CLAUDE_CONFIG_DIR` and `CODEX_HOME` environment variables do not change the extension's data location. Existing source logs are not moved or deleted.

| Setting | Default |
|---|---|
| `agentTracker.language` | `auto`; follows the VS Code display language, with Korean as the fallback for unsupported languages |
| `agentTracker.claude.enabled` / `agentTracker.codex.enabled` | Tracking enabled for each provider |
| `agentTracker.quota.refreshPolicy` | `automatic`; use `manual` to refresh only on request |
| `agentTracker.usage.enabled` | Usage statistics enabled |
| `agentTracker.usage.skillsEnabled` | Skill statistics collection enabled; includes calls selected by the AI |
| `agentTracker.usage.showApiCosts` | Estimated API cost display disabled |
| `agentTracker.usage.excludeEmptyUsage` | Requests with an unknown model and no token usage excluded from charts and averages; retained in the table below |
| `agentTracker.claude.cleanupPeriodDays` | `null` preserves the existing Claude setting; enter a retention period of at least 1 day |
| `agentTracker.codex.showReserve` | GPT Reserve display disabled |
| `agentTracker.codex.showResetCredits` | Usage reset credit display enabled |
| `agentTracker.dataHome` | `~`; uses the `.claude` and `.codex` folders below it |
| `agentTracker.codex.executable` | `codex` on PATH |
| `agentTracker.usage.timezone` | System time zone; for example, `Asia/Seoul` |
| `agentTracker.quota.pollingIntervalSeconds` | A shared 900-second interval for Claude and Codex, with a 30-second minimum |
| `agentTracker.codex.showStatusBar` | Codex status bar display enabled |
| `agentTracker.display.percentage` | `used`; use `remaining` for the remaining percentage |
| `agentTracker.display.detail` | `detailed`; use `compact` for a shorter display |
| `agentTracker.display.colorMode` | `automatic`; supports automatic, white, black, and custom colors |
| `agentTracker.display.customColor` | `#ffffff`; the HEX color used in custom mode |

Choose the status bar color under **Display: Color Mode** in the extension settings. The default, **Automatic**, follows the current theme and workspace status bar color, including 2026 Dark, Light, and high-contrast themes. Enter a value such as `#abc`, `#aabbcc`, or `#ffffffcc` under **Display: Custom Color**, or use the **Open color picker** link in the setting description and click the color swatch. The picker provides HEX input, opacity, a preview, and saving to user settings or the current workspace. Applying a color immediately updates the logos, remaining quota bars, text, and refresh button.

For npm installations of Codex on Windows, the extension locates the native executable in the package next to the `.cmd` launcher. For other installation methods, specify the `.exe` path. In WSL, SSH, or containers, use CLI and log paths from the environment where the extension runs.

Disabling tracking for a provider stops its quota queries and statistics collection and hides it from the card and statistics. Existing statistics are retained and shown again when tracking is re-enabled. Claude appears in the status bar whenever its tracking is enabled. `codex.showStatusBar` hides only the Codex status bar display. Automatic refresh uses the same interval for Claude and Codex and runs only while the window is active. When you return to a window, it retries if the last successful query was at least 5 minutes ago or the previous query failed. Manual policy does not query on startup; it queries only when you click refresh.

Setting a retention period under **Claude: Cleanup Period Days** changes only `cleanupPeriodDays` in the Claude data home's `settings.json`, preserving all other settings. Returning the setting to `null` preserves Claude's existing value and stops further automatic updates. Claude's default retention period is 30 days, and Claude Code handles deletion. Agent Tracker does not directly delete conversation logs. [Claude settings](https://code.claude.com/docs/en/settings-reference#cleanupperioddays)

Records whose model cannot be determined are shown as **Unknown**. Requests with neither model nor token information are excluded from charts and averages by default, but remain in the table below. Turn off **Usage: Exclude Empty Usage** to include them in charts and averages as well. Request tables and charts show titles of up to 80 characters extracted from the original requests, without sequence numbers. Session charts place sessions side by side along the horizontal axis. Differences in case and separators in Windows project paths are treated as the same project.

Turning off **Usage: Enabled** cancels any ongoing statistics collection and closes the statistics view. Use the **Delete statistics data** link under that setting or the corresponding Command Palette command to clear file processing information (`manifest`) and aggregated results (`turn_summary`) together. Source conversation logs are preserved. Collection does not restart immediately after deletion; re-enable statistics and reopen the view to recalculate them. Even when every status bar item is hidden, you can reopen settings with **Agent Tracker: Open Settings** in the Command Palette.

## Data processing

When usage statistics are enabled, activation prepares only the SQLite schema. Quota is queried according to the selected providers and refresh policy. A JSONL scan starts when you open usage statistics or re-enable Skill collection in an open statistics view. Showing the quota tooltip, updating countdowns, refreshing quota, switching between detailed and compact displays, changing statistics dates, time zones, groups, or pages, and opening, reloading, or paging through diagnostics do not start a scan. Automatic quota queries are skipped while the window is inactive.

**Usage: Skills Enabled** defaults to ON. It counts skill, subagent, plugin, and model calls made by the AI regardless of whether the user explicitly named the skill. When OFF, new usage counts and the Skill display stop. Stored counts for existing requests are preserved, while token statistics, API costs, and quota remain available. Turning it back ON recalculates logs in an open statistics view. If the view is closed, records skipped while OFF are restored the next time you open it. Records are not counted twice, and restoration covers only the source logs that still exist.

SQLite data is stored in `agent-tracker.sqlite` under the extension's `globalStorageUri`. The persistent tables are `manifest`, `projects`, `sessions`, `turn_summary`, `turn_model_usage`, `turn_costs`, and `session_billing`. Project names are stored once per project; session names are stored once per provider/session ID pair. Request statistics refer to them by ID. Clicking a project or session name in the statistics view opens a list of stored names. Scroll and select a name to apply it immediately to the table and chart. The lists are independent of the date filter and table page, and follow the current provider selection. Selecting a project shows that project's sessions. Choose **All projects** or **All sessions** to clear the selection. Sessions with the same name are shown separately and distinguished by provider, project, and start time. Selecting a name in a list or table queries by its ID. Hover over the name to see the full path or session ID.

**Reset** restores the grouping, period, provider, project, session, chart metric, aggregation basis, and page to their defaults. Stored statistics and billing modes are preserved. The **By provider / By model** toggle to the right of **Provider** switches both the chart and the table for the same grouping and returns to the first table page. In model view, the model column replaces the provider column, and names such as `opus5.5` and `sonnet4.6` appear directly in charts and tables. A square marker before each model name identifies Claude in orange or Codex in blue. Total and average token bars use blue for input, orange for output, purple for cache writes, and green for cache reads. The same colors appear in the `Input / Output / Cache Write / Cache Read` legend above total and average token charts. If a bar's composition is unknown, a gray **Unknown composition** legend item is added. The legend is hidden for average duration, request counts, and empty results. Records whose model cannot be determined appear as **Unknown**. Requests with neither model nor token usage information are excluded from charts and averages by default but remain in tables. Claude's zero-token `<synthetic>` error notices are excluded from model statistics, while request status and tokens consumed before the error are preserved. Earlier records are rebuilt once on the next statistics refresh. There is no separate cumulative section.

Enable **Usage: Show Api Costs** (`agentTracker.usage.showApiCosts`) in the extension settings to display costs in token statistics tables. It defaults to OFF. Subscription usage is shown as zero; prepaid API usage is an estimated USD cost calculated from standard model and token rates published by [Anthropic](https://platform.claude.com/docs/en/about-claude/pricing) and [OpenAI](https://developers.openai.com/api/docs/pricing). If the source does not record the billing mode, the cost is shown as unknown. After selecting a session, choose subscription or API under **Billing method for the selected session** to apply that mode to the entire session and store it in the DB. Models without a known rate retain an unknown cost. Actual bills, prepaid balances, and additional charges are not included. Changing cost settings or billing modes and resetting filters do not start a source scan. Resetting also preserves the cost display setting.

Claude's automatic and custom titles and Codex's session index and state DB titles are used. Sessions without a title are shown as **Unnamed session**. When a session changes, its complete source is reread, duplicate responses are removed, and its statistics are replaced. Unchanged sessions require no body reads. If only a Codex title changes, only the name is updated. Subagent tokens are added to the parent request; duration uses only the parent request's value.

For legacy Codex subagent files with no `root_turn_id` anywhere in the file, the thread is counted as an independent conversation. Its own requests, tokens, and durations are used, with a `standalone-subagent` quality flag. Copied history that matches the parent's source is excluded from duplicate counts. History whose parent cannot be identified is not arbitrarily subtracted.

Concurrent refreshes from multiple windows are coordinated through SQLite locking in a separate, table-free and data-free file named `agent-tracker.sqlite.refresh-lock.sqlite`. Locks are released even if a process exits abnormally. The file is reused and must not be deleted while the extension is running.

File lists and response candidates are processed in disk-backed temporary tables in the worker. File metadata batches are limited to 256 entries, query pages to 100 entries, and JSONL lines to 4 MiB by default. If a limit is exceeded or a format cannot be parsed, diagnostics are recorded and the previous valid statistics are preserved. Prompt, response, and tool bodies and OAuth tokens are not stored in the DB.

Only the **Data diagnostics** link appears at the bottom of the statistics view. Clicking it opens a separate **Agent Tracker Data Diagnostics** Webview showing file processing status and requests that need attention. If that view is already open, it is brought forward and its first page is queried again. Opening diagnostics or choosing **Reload** reads only the status stored in the DB; it does not revalidate or recalculate source logs. When a statistics refresh finishes, any open diagnostics view is also updated. **Requests to check** lists stored requests with quality warnings or refresh failures. Warnings alone do not exclude requests from statistics. Failed refreshes retain the previous valid values, and requests without duration are excluded from the duration average's sample. If a new file cannot be parsed from the start, only a file error is recorded; request statistics cannot be created.

Invalid time zone settings produce an on-screen notice and use the system time zone for queries. In daily and monthly statistics, requests without a start time appear under **Unknown time**, even when a date filter is applied.

The chart above the statistics table supports total tokens, average tokens, average duration, and request counts. Total and average token bars stack `Input / Output / Cache Write / Cache Read` in blue, orange, purple, and green to show both the overall value and its composition, with a color legend above. Each average token component is calculated from the same sample of completed requests. Hover over a segment to see its name and token count or average in the tooltip and detail view. Input excludes cached tokens. Bars with unknown composition use a neutral color. Keyboard focus on a whole bar reveals its total, composition, and average sample information.

Every grouping and chart metric shares the table's current page of 100 rows. If the table shows rows 1–100, the chart shows those same items; for rows 101–200, it shows the next set. Previous and next buttons beneath both the chart and table move together and show the same range. Daily and monthly periods are not combined, and projects and sessions are placed side by side on the horizontal axis. Long charts can be scrolled horizontally. Period, project, and session cells are truncated with an ellipsis after five lines; hover to see the full name. Changing the chart metric or page does not reread source logs.

Model charts and tables use tokens per model under the same period, project, and session filters. Charts show individual models on the current table page. Whether unknown requests with zero tokens appear in the chart follows the setting. Excluding empty usage does not pull items from the next page to fill the current one. Tables show every model individually in pages of 100 rows, calculating tokens, request counts, averages, and API costs per model. A request using multiple models counts toward each model's request total; duration is the entire duration of a request that includes that model. Skill statistics show four tables for skills, subagents, plugins, and models, with explanations below them. In every table, the bar beside **Overall percentage** is full for the most frequently used item in that category; other bars scale relative to it. The leading item and the denominator for overall percentages remain the same across pages.

## Validation

Test code under `tests/` is organized by execution role.

```text
tests/
├─ node/          Unit and integration tests running in Node
├─ vscode/        Real VS Code extension host, mouse, and keyboard checks
├─ fixtures/      Synthetic data, substitute processes, and prepared view states
├─ runners/       Test discovery and isolated execution environments
├─ benchmarks/    Performance and memory measurement tools
├─ .cache/        VS Code profiles, downloads, and temporary local verification files
└─ results/       Reports, screenshots, and measurements under benchmarks/
```

`.cache/` and `results/` are generated during execution and excluded from Git. They are also excluded from type checking, linting, and test discovery. The entire `tests/` directory is excluded from the VSIX. `tools/` contains the local VS Code toggle patch and live quota QA tools. Icons use the SVG and WOFF files included in the repository.

```sh
npm run check       # Type checking, lint, and fixture/worker/process/UI integration tests
npm run test:vscode # Light/dark Webview checks in an isolated real VS Code instance
npm run test:toggle # Actual click, persistence, and close checks in a patched local VS Code
npm run test:quota:live # Compare quota and display logic against signed-in Codex/Claude accounts
npm run benchmark   # 301 synthetic files and a large session with 2,000 requests
npm run benchmark:quota # Timing, memory, and process cleanup for synthetic App Server success/error/timeout/cancel cases
npm run benchmark:titles # A/B comparison of a TEMP title index and integration into the existing aggregate
npm run benchmark:transactions # Actual aggregation and DB replacement transaction measurements using synthetic JSONL
```

Adjust large benchmarks with the `BENCHMARK_FILES` and `BENCHMARK_TURNS` environment variables. Results are written to `tests/results/benchmarks/summary.json`; actual personal conversation logs are not used. See the [measurement guide (Korean)](QuotaBenchmark.md) for quota resource measurement options and limitations.

The title A/B benchmark places the same 2,000 requests in a long session and across multiple providers and sessions. After warmup, it compares 20 pairs with alternating execution order. Correctness is checked with `node:test` by comparing every aggregate result from the current product SQL and both candidates. Performance runs report time, TEMP allocation, and process RSS separately. Adjust the workload with `--cases`, `--pairs`, and `--warmups`, and preserve Markdown and raw JSON with `--report docs/RequestTitleAB.md`. See the [title A/B report (Korean)](RequestTitleAB.md) for the conditions and results.

The product uses option A, a TEMP partial index. `npm run benchmark:transactions -- --real --pairs 3 --report docs/RequestTitleTransactions.md` reads fixed copies of actual local conversation logs and compares initial aggregation, full rebuilds, and unchanged refreshes between an unindexed control and option A. Overall time, actual transaction time, TEMP pages, RSS, and result equivalence are recorded in Markdown, JSON, and JSONL. Source logs and the installed extension's DB are not modified; copies and experiment databases are deleted on exit. Without `--real`, the benchmark uses synthetic data and does not read personal files. See the [actual transaction report (Korean)](RequestTitleTransactions.md) for the selection rationale, complexity, and measurement limitations.

Run actual account validation with `$quota-qa` or the [quota-qa skill (Korean)](../.agents/skills/quota-qa/SKILL.md). `test:quota:live` compares Claude's OAuth usage response and Codex's actual App Server response against the product providers using the same responses. It also checks used/remaining percentage rounding, remaining quota bars, and Codex process termination. Results are written to `tests/results/quota-live.json` without storing tokens or account identifiers. Authentication errors, HTTP 429, timeouts, or mismatches from either provider produce exit code 1. HTTP 429 is not retried automatically. Ordinary `check` and CI validate the QA tools with synthetic inputs and do not call actual accounts. Comparisons against installed VS Code or provider websites are separate checks.

Use an option such as `npm run test:quota:live -- --provider=codex` to select a single provider. `--codex-executable=...`, `--codex-home=...`, and `--claude-home=...` match the extension's executable and data home settings. `--timeout-ms=30000` changes the timeout per provider. When running `node tools/quota/live-qa.cjs` directly, compile the current source first and specify `--real` explicitly.

`test:vscode` creates a separate profile and synthetic logs under `tests/.cache/vscode/`. On Windows, it prefers the installed VS Code; otherwise, it downloads a test instance. Set `VSCODE_TEST_VERSION` to select a downloaded version or `VSCODE_EXECUTABLE` to select an executable. In a Linux environment without a display, run `xvfb-run -a npm run test:vscode`. Results are written to `tests/results/vscode-smoke.json`.

`test:toggle` checks the patched installation without modifying it and sends actual mouse movements, clicks, and keyboard input in an isolated window. It sets the hover delay to 100 ms and observes for 1.5 seconds to verify that summary hover and the full card are separate, the summary is hidden while the card is open, and a card closed by repeated clicking does not reopen. Results and screenshots are written to `tests/results/statusbar-toggle.json` and `statusbar-toggle.png`. On an unpatched installation, run `node tests/vscode/statusbar-toggle.cjs --baseline` to reproduce the original bug where clicking closes and immediately recreates the card. A baseline report can be written to `statusbar-toggle-baseline.json`.

PR CI covers unit and integration tests on Windows, Linux, and macOS with Node 22 and 24, plus real extension host tests on Linux with the minimum supported VS Code 1.101.0 and stable. Verify jobs and version tags validate and preserve both a VSIX and an npm tarball for npx installation as artifacts. Automated publishing to npm or the Marketplace is not included.

## Current limitations

- The usage card uses `StatusBarItem.tooltip` and `MarkdownString`. Click-to-toggle requires the local VS Code patch, and dragging the card is unavailable. VS Code controls the card's position, size, and theme. The status bar uses font icons generated from the original SVGs. Automatic color inherits VS Code's status bar color; white, black, and custom colors apply to the entire usage item and refresh button together. Bars show remaining quota, while numbers follow `display.percentage`. See the [status bar popup document (Korean)](research/StatusBarPopup.md) for API research and implementation details.
- Claude OAuth usage uses a private endpoint. On HTTP 401, the extension rereads the CLI's stored credentials once. If the query still fails, it asks the user to sign in to the CLI again. It does not directly replace refresh tokens.
- Local JSONL files are not a stable provider API contract. Parent relationships or requests that cannot be verified are not arbitrarily merged; they appear in a separate diagnostics Webview. Fork history is excluded only for a sequential legacy prefix matching the parent.
- Actual account QA on 2026-10-08 confirmed that Claude and Codex server quota matched the product providers and status bar formatter, and that Codex query processes exited. Repeat it with `$quota-qa`. This QA does not observe installed VS Code windows or provider websites. Filter, chart, and diagnostics behavior in real VS Code light/dark themes is checked separately by automated tests; readability and remote environments require manual checks. Ordinary automated tests use synthetic fixtures and substitute App Server processes.
- Summary memory benchmarks report combined process RSS for the Node host and worker. Quota benchmarks measure child processes separately. Results from the default synthetic run must not be interpreted as memory measurements of the actual Codex App Server.

See the [design specification (Korean)](AgentTracker.md), [CI/CD plan (Korean)](CI-CD.md), and [implementation notes (Korean)](Implementation.md) for the design and validation requirements.
