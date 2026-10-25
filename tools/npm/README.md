# Agent Tracker for VS Code

Install the Agent Tracker extension to see Claude and Codex subscription quota
and local conversation usage in VS Code.

Requires Node.js 22.15+ and VS Code 1.101+ with the `code` command on PATH.

```sh
npx agent-tracker-vscode@latest
```

The installer includes the VSIX, installs it with the VS Code CLI, and verifies
the installed extension ID and version. Reload an open VS Code window with
**Developer: Reload Window**, then run **Agent Tracker: Open Dashboard**.

Run the same command with `@latest` to update. Install a specific version with
`npx agent-tracker-vscode@0.2.0`.

```sh
npx agent-tracker-vscode --help
npx agent-tracker-vscode --profile "Work"
npx agent-tracker-vscode --code code-insiders
npx agent-tracker-vscode --code "/path/to/code"
```

The default profile is used unless `--profile` is given. Create the named profile
in VS Code first; extension installation fails if it does not exist.
`--extensions-dir` and `--user-data-dir`
select separate VS Code directories when needed.

On macOS, use **Shell Command: Install 'code' command in PATH** in VS Code first.
On Windows, the official `code.cmd` launcher is supported, including installations
with versioned runtime directories.

Existing Claude/Codex CLI logins are used by the extension. The installer does
not log in to either provider. The optional workbench click-toggle patch is a
separate local setup step documented in the repository.

Source and full documentation: [Agent Tracker](https://github.com/lsc892/Agent-Tracker).

## 소스 역할

VSIX를 동봉한 npm 설치 CLI와 공개 패키지 구성을 관리한다.

- [cli.cjs](cli.cjs) — 동봉 VSIX의 무결성을 확인해 VS Code에 설치하고 설치 버전을 검증한다.
- [manifest.json](manifest.json) — 공개 npm 설치 패키지의 이름·실행 명령·포함 파일 기본값을 정의한다.
- [package.cjs](package.cjs) — 현재 VSIX와 설치 CLI를 검증된 파일 목록의 공개 npm 패키지로 구성한다.
