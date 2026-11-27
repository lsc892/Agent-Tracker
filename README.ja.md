<p align="center">
  <a href="README.md">English</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.zh.md">简体中文</a> |
  <strong><a href="README.ja.md">日本語</a></strong> |
  <a href="README.es.md">Español</a> |
  <a href="README.fr.md">Français</a>
</p>

# Agent Tracker

Claude・Codex の現在の使用量とリセットまでの時間を表示し、AIエージェントの利用記録をもとにトークン使用量と作業の所要時間を追跡する VS Code 拡張機能です。

## 主な機能

### ステータスバーで使用量を確認

- **現在の使用量** — VS Code のステータスバーで、Claude・Codex のサブスクリプション使用率とリセットまでの時間を確認できます。
- **詳細カード** — クリックすると、5時間・週間の使用量、リセット時刻、Codex の利用可能な使用量リセット回数などを表示します。
- **自動・手動更新** — 既定では15分ごとに取得します。更新ボタンで直ちに取得することもできます。

<p align="center">
  <img src="resource/readme/at-1.png" alt="ステータスバーと使用量の詳細カード">
</p>

### 会話・期間・モデル別にトークンと時間を比較

- **トークン・時間の統計** — 会話・日・月・プロジェクト・モデル別の合計トークン数、リクエスト当たりの平均トークン数、平均所要時間を表とグラフで確認できます。
- **利用記録** — スキル・プラグイン・サブエージェント・モデルの利用回数と割合を確認できます。
- **使い方の改善** — モデルの変更やスキル・プラグインの導入前後で、リクエスト当たりの平均トークン数と時間を比較し、エージェントの使い方を調整できます。

<p align="center">
  <img src="resource/readme/at-2.png" alt="モデル別の平均トークン数とスキル利用統計">
</p>

カードの **使用統計**、またはコマンドパレットの **Agent Tracker：使用統計を開く** から開きます。統計は画面を開く際にローカルの会話ログから計算します。

## インストールとアンインストール

### インストールと更新

- **動作環境：** Node.js **22.15 以降**、VS Code **1.101 以降**、ターミナルで実行できる `code` コマンド
- **ログイン：** 利用するプロバイダーのCLI（Claude Code または Codex CLI）で事前にログイン

インストールと更新には同じコマンドを使います。

```sh
npx agent-tracker-vscode@latest
```

完了したら、VS Code のコマンドパレットで **Developer: Reload Window** を実行してください。
Agent Tracker に使用量カードのクリック動作の更新が表示されたら、VS Code を完全に終了し、少し待ってから開き直してください。対応する Windows・Linux のローカル環境では、終了時にパッチが適用されます。

<details>
<summary>追加オプション：グローバルインストール・プロファイル指定・macOS設定</summary>

**グローバルインストールと更新**

```sh
npm install -g agent-tracker-vscode@latest
agent-tracker-vscode
```

**特定のプロファイルにインストール：** VS Code で作成済みのプロファイル名を指定します。

```sh
npx agent-tracker-vscode@latest --profile "Work"
```

**macOS：** `code` コマンドがない場合は、先に VS Code のコマンドパレットで **Shell Command: Install 'code' command in PATH** を実行してください。

</details>

### アンインストール

VS Code の拡張機能一覧から **Agent Tracker → アンインストール** を選ぶか、次を実行します。

```sh
code --uninstall-extension AgentTracker.agent-tracker
```

特定のプロファイルにインストールした場合は、削除コマンドにも `--profile "Work"` を付けます。グローバルにインストールした npm パッケージも削除する場合は、次を実行します。

```sh
npm uninstall -g agent-tracker-vscode
```

npm パッケージと VS Code 拡張機能はそれぞれアンインストールします。

## VS Code 拡張機能の設定

カードの **設定** をクリックするか、VS Code の設定で `@ext:AgentTracker.agent-tracker` を検索します。
以下の設定キーにはすべて `agentTracker.` 接頭辞が付きます。

| 設定 | 既定値 | 説明 |
| --- | --- | --- |
| `language` | `auto` | VS Code の言語に従う。韓国語・英語・簡体字中国語・日本語・スペイン語・フランス語を選択可能 |
| `claude.enabled` / `codex.enabled` | `true` | プロバイダー別の使用量取得・ログ統計の追跡 |
| `quota.refreshPolicy` | `automatic` | 自動で取得。`manual` は更新ボタンを押したときのみ取得 |
| `quota.pollingIntervalSeconds` | `900` | 自動取得の間隔（秒）。最小30秒、非アクティブなウィンドウでは一時停止 |
| `display.percentage` | `used` | バーと数値で使用率を表示。使用率は左から増え、`remaining` は残量が右端から減る |
| `display.detail` | `detailed` | 7日・5時間の使用量を表示。`compact` は5時間のみ表示 |
| `display.colorMode` | `automatic` | テーマの色を使用。`white`・`black`・`custom` も選択可能 |
| `display.customColor` | `#ffffff` | `custom` モードで使用する HEX カラー |
| `codex.showReserve` | `false` | アカウントで提供される GPT Reserve の使用量を表示 |
| `codex.showResetCredits` | `true` | アカウントで提供される使用量リセット回数と次の有効期限を表示 |
| `usage.enabled` | `true` | ローカル会話ログのトークン・時間統計を有効化 |
| `usage.skillsEnabled` | `true` | スキル・プラグイン・サブエージェント・モデルの利用回数を集計 |
| `usage.showApiCosts` | `false` | API 推定費用（USD）を表示。サブスクリプション利用は0と表示 |
| `usage.excludeEmptyUsage` | `true` | モデル・トークン情報がどちらもないリクエストをグラフと平均から除外。表には残す |
| `usage.timezone` | システムのタイムゾーン | 日・月統計の基準タイムゾーン。例：`Asia/Seoul` |
| `dataHome` | `~` | `.claude`・`.codex` を含む共通の親フォルダー。ユーザー設定で指定 |
| `claude.cleanupPeriodDays` | `null` | Claude のログ保持日数。1以上で Claude の設定に反映し、`null` は既存の値を維持 |
| `codex.executable` | `codex` | Codex CLI コマンドまたは実行ファイルのパス |

**Agent Tracker：統計計算データを削除** で集計結果を初期化できます。元の会話ログは保持され、統計画面を再度開くと再計算します。

## 更新内容

<details open>
<summary>v0.3.0</summary>

- **統計更新の性能改善** — JSONLログを1回の読み込みで集計し、大量のログは複数ファイルを並列処理します。重複した応答は適切な記録を選び、寄与分の差だけを合計に反映します。
- **DB保存・検索の最適化** — 変更されたリクエストのみを更新し、複数セッションの保存と日別集計をまとめて処理します。重複検索を減らし、表・グラフ・総行数で同じ検索結果を共有します。
- **Codexサブエージェントの使用量を合算** — 子・孫エージェントの使用量を親リクエストに合算します。リクエスト識別子のない子も生成履歴で関連付け、深い親子関係や循環・親の欠落への対応を改善しました。
- **移動したログの統計更新を修正** — 元の識別子と内容を確認して新しいパスに関連付け、古いパスの記録を整理します。移動後に追加された使用量も継続して反映します。
- **使用量カードとアクセシビリティの改善** — ホバーでカード全体を表示し、ローカルworkbenchパッチ適用時はクリックで同じカードを固定・解除する動作を復元しました。簡易表示でも、読み上げ用の要約はCodexから先に週間・5時間の残量とリセット時刻を案内します。
- **使用量取得の互換性改善** — Claude・Codex応答の使用量ウィンドウを100個に制限する処理を削除し、通信時の拡張バージョンを実際のインストール済みバージョンに合わせました。
- **未対応言語の既定表示を修正** — VS Codeの言語が未対応の場合は英語で表示します。
- **拡張アイコンの更新** — アイコンを変更し、画像ファイルのサイズを削減しました。

[v0.2.0からの処理段階別アルゴリズム改善・測定結果・制約（韓国語）](docs/Performance-v0.3.0.ko.md)

</details>

<details>
<summary>v0.2.0</summary>

- **DB性能の改善** — インデックスで期間・プロジェクト別の検索を最適化し、日別の事前集計（rollup）でモデル別統計と平均値の計算を改善しました。
- **Codex圧縮ログに対応** — CodexがZstd（`.jsonl.zst`）で圧縮した過去の会話も統計に含めます。
- **元の会話削除後も統計を保持** — Claudeによる古い会話の自動削除などに備え、元の会話が削除されてもDB内の有効な統計を既定で保持します。
- **グラフの見やすさを改善** — プロバイダー別表示にも各社の色を表示し、表の見出しをクリックして昇順・降順を切り替えられます。
- **ページあたりの行数を調整** — 統計画面でページごとに表示する行数を調整できます。

</details>

## 使用量統計の収集方法

Agent Tracker は、ローカルにある Claude・Codex の JSONL ログから統計に必要なフィールドを読み取ります。Codex の Zstd 圧縮ログにも対応しています。プロジェクトキーは、Claude ではプロジェクトのログディレクトリ、Codex ではログのルートディレクトリの親から取得します。

### ログから読み取るフィールド

| 用途 | Claude | Codex |
| --- | --- | --- |
| セッションとスレッド | メインログの `sessionId` を使い、省略されている場合はファイル名を使います。サブエージェントのログは、所属するセッションのフォルダーとファイル名で識別します。 | `session_meta` の `payload.id` または `token_usage_record` の `payload.thread_id` でスレッドを識別します。`payload.session_id` がなければ、スレッド ID をセッション ID として使います。 |
| モデルと応答 | `assistant` 行の `message.model`、`message.id`、`requestId` を読み取ります。`isApiErrorMessage` は、トークン数がゼロのエラー応答を除外するために使います。 | 使用量の行、またはセッションやターンのコンテキストから `payload.model` を読み取ります。`payload.turn_id` と `payload.response_id` で応答を識別します。 |
| 入力・出力・キャッシュのトークン数 | `message.usage` の `input_tokens`、`output_tokens`、`cache_read_input_tokens`、`cache_creation_input_tokens` を読み取ります。 | `payload.usage` の `input_tokens` と `output_tokens` を読み取ります。キャッシュのトークン数は `cached_input_tokens` と `cache_write_input_tokens`、または `input_tokens_details.cached_tokens` と `input_tokens_details.cache_write_tokens` から取得します。 |
| 累計値と親スレッドへの参照 | — | `payload.thread_token_usage`、`payload.turn_token_usage`、旧形式の `token_count` イベントにある `payload.info.total_token_usage` と `payload.info.last_token_usage` を読み取ります。`session_meta` では `forked_from_id` や直接または入れ子になった `parent_thread_id` を確認します。 |
| 時刻 | 行の `timestamp` を読み取ります。 | 行の `timestamp` または `payload.timestamp` と、イベントの `payload.started_at`、`payload.completed_at` を読み取ります。 |

### ログの解析と日別集計

1. JSONL を1行ずつ処理し、あらかじめ指定されたパスのフィールドを抽出します。1行が読み込みブロックをまたぐ場合は、JSON の解析状態と抽出済みの値を引き継ぎます。画像の Base64 データは読み込み時にスキップします。
2. Claude は同じセッション内の `(message.id, requestId)`、Codex は同じスレッド内の `(turn_id, response_id)` で重複を判定します。Claude で同じメッセージに確認できるリクエスト ID が1種類だけなら、ID が欠けている記録も比較します。重複した場合は、入力・出力トークン数の合計が最も大きい記録を1件だけ集計します。Claude は通常の入力にキャッシュの読み取り・書き込み分を加え、Codex はログに記録された入力トークンの総数を使います。
3. Codex の旧形式の記録は親スレッドと照合し、コピーされた履歴を除いて、残りの累計値から確認できた増分を合算します。スレッドの累計に応答の合計だけでは説明できない増分がある場合は、ターンの累計や旧形式の記録で確認してから加算します。
4. 各スレッドの最初のタイムスタンプを統計のタイムゾーンで日付に変換し、日別に集計します。最初と最後の時刻が異なる場合は、その差を記録上の所要時間とします。この時間には待機時間も含まれます。

### SQLite のテーブル

| テーブル | 保存する内容 |
| --- | --- |
| `source_file` | ログのパス、セッションとスレッドの ID、更新時刻、パーサーのバージョン、処理状況、元のファイルの欠落状況。 |
| `usage_request_daily` | プロバイダー、セッション、プロジェクト、現地の日付をキーとするトークン数・所要時間・費用の合計とサンプル数。 |
| `usage_model_daily` | 同じ日別集計キーにモデルキーを加えた、モデル別の合計とサンプル数。 |
| `projects`、`sessions` | プロジェクトとセッションの表示名。 |
| `session_billing` | プロバイダーとセッションごとにユーザーが指定した課金方式。 |
| `usage_rollup_meta` | 日別集計に使うタイムゾーンと形式のバージョン。 |
| `usage_capability_daily` | 以前のスキーマから移行したツールの利用回数。ツールの統計画面で参照します。 |

統計画面では、選択した期間で日別データを絞り込み、プロバイダー別またはモデル別の行を指定されたグループごとに集計します。平均値は、保存した合計と対応するサンプル数から計算します。
