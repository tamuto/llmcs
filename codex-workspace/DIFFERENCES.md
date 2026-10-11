# codex-workspace (Python 版) と TypeScript 版の差分

Python 版（`codex-workspace`）と TypeScript 版（[`@infodb/codex-workspace`](../codex-workspace-ts)）は同じ機能を目指しています。
Python 版 0.3.0 で、TypeScript 版 0.2.0 にあった機能を揃えました（下の「0.3.0 で揃えたもの」）。
今残っている違いは、言語に合わせた書き方だけです。

片方にだけ機能を入れたときは、ここの「今の差分」に書き足し、もう片方で揃えたら「揃えたもの」へ移します。

## 今の差分（言語に合わせたもの）

| Python 版 | TypeScript 版 |
| --- | --- |
| 名前は snake_case（`run_turn`、`exit_code`、`access_token_env`） | camelCase（`runTurn`、`exitCode`、`accessTokenEnv`） |
| 時間は秒（`turn_timeout`、`request_timeout`、`max_age=timedelta`） | ミリ秒（`turnTimeoutMs`、`requestTimeoutMs`、`maxAgeMs`） |
| `with WorkspaceSession(cmd) as s:`（同期、`__init__` は起こさない） | `await using s = await WorkspaceSession.open(cmd)`（非同期） |
| 中止は `run_turn(text, cancel=threading.Event())` | `runTurn(text, { signal })`（`AbortSignal`） |
| Dockerfile のフォルダは `with docker_context() as path:` | `DOCKER_CONTEXT`（文字列） |
| 引数の誤りは `ValueError` | `TypeError` |
| 配布は uv の git 依存（タグ `codex-workspace-v<版>`） | npm（`@infodb/codex-workspace`） |

Dockerfile は同じ内容で、同じイメージ（`llmcs-codex-workspace:local`）を使います（両方のテストで確かめています）。

---

## 0.3.0 で揃えたもの（呼ぶ側で書き換える箇所）

Python 版を 0.3.0 に上げるときは、下の「探す箇所」で自分のコードを検索してください。
**壊れる変更は PY-10 の Dockerfile の場所と、非公開だった `_usage` の名前だけ**です。ほかは足しただけなので、
今の呼び方のまま動きます。回避策を書いていたところを、新しい API に置き換えてください。

| ID | 内容 | 壊れるか |
| --- | --- | --- |
| [PY-1](#py-1-access-token-で認証するsign-in-with-chatgpt) | access token で認証する（Sign in with ChatGPT） | いいえ |
| [PY-2](#py-2-app-server-のプロセスに環境変数を渡す) | app-server のプロセスに環境変数を渡す | いいえ |
| [PY-3](#py-3-initialize-で名乗るアプリを変える) | `initialize` で名乗るアプリを変える | いいえ（既定の版が 0.1.0 から 0.3.0 に） |
| [PY-4](#py-4-起動し直してスレッドを続ける) | 起動し直して、スレッドを続ける | いいえ |
| [PY-5](#py-5-プラン利用の使用量の上限を-usagelimiterror-にする) | プラン利用の使用量の上限を `UsageLimitError` にする | いいえ（例外の型が細かくなる） |
| [PY-6](#py-6-ターンを途中で止める) | ターンを途中で止める（`turn/interrupt`） | いいえ |
| [PY-7](#py-7-turnstart-の入力に-text_elements-を付ける) | `turn/start` の入力に `text_elements` を付ける | いいえ |
| [PY-8](#py-8-公開する名前を揃える) | 公開する名前を揃える | `_usage` を読んでいたら |
| [PY-9](#py-9-テスト) | テスト（7件 → 17件） | — |
| [PY-10](#py-10-同梱の-dockerfile-とビルドの文脈) | Dockerfile を `docker/` に移し、`docker_context()` を公開する | 場所を直に指していたら |

### PY-1: access token で認証する（Sign in with ChatGPT）

- **API**: `docker_command(ws, access_token_env=ACCESS_TOKEN_ENV)`。認証のファイルはマウントせず、`-e ACCESS_TOKEN`
  （名前だけ）と、プラン利用の provider の設定（`chatgpt_plan_overrides()`、`-c` で7つ）を付ける。
  `auth_volume`・`auth_file`・`access_token_env` はどれか1つ。名前が環境変数の名前でなければ `ValueError`。
- **探す箇所**: `docker_command(` に `config_overrides` で `model_provider` / `model_providers.` を自前で渡しているところ、
  `docker run` に `-e` を自前で足しているところ、Sign in with ChatGPT を使えずに auth.json を用意しているところ。
- **書き換え**: 自前の設定を消して `access_token_env=` にする。値は PY-2 の `env=` で渡す。

### PY-2: app-server のプロセスに環境変数を渡す

- **API**: `WorkspaceSession(cmd, env={"ACCESS_TOKEN": token})`。今のプロセスの環境に重ねて渡す。値はログや例外に出さない。
- **探す箇所**: `WorkspaceSession(` の前で `os.environ[...] =` / `os.environ.update(` / `os.putenv(` しているところ。
- **書き換え**: `env=` で渡し、`os.environ` を書き換えるのをやめる。

### PY-3: `initialize` で名乗るアプリを変える

- **API**: `WorkspaceSession(cmd, client_info={"name": ..., "title": ..., "version": ...})`。既定は
  `{"name": "codex_workspace", "version": "0.3.0"}`（前は版が `0.1.0` のままだった）。
  Sign in with ChatGPT では、`name` を登録のときの `agent_name_hint` と同じにしなければならない。
- **探す箇所**: `WorkspaceSession` を継承して `start` を差し替えている・`_request("initialize"` を呼んでいるところ。
- **書き換え**: `client_info=` で渡す。

### PY-4: 起動し直してスレッドを続ける

- **API**: `session.restart(env=...)` で閉じて起こし直し（`env` を渡すと置き換える）、
  `session.resume_thread(thread_id)`（`thread/resume`）で同じスレッドを続ける。トークンの累計は数え直す。
  `start_thread` は記録を残さない（`ephemeral`）スレッドなので、続けられるのは記録を残す使い方をしたときだけ。
- **探す箇所**: トークンの期限切れや `WorkspaceError("app-server が終わりました")` のあとに、
  `WorkspaceSession` を作り直しているところ。
- **書き換え**: `restart` と `resume_thread` にする。

### PY-5: プラン利用の使用量の上限を `UsageLimitError` にする

- **振る舞い**: `codexErrorInfo` が `usageLimitExceeded` / `rateLimitExceeded` のときに加えて、エラーの中に
  `subscription_sharing_usage_limit_exceeded` があれば `UsageLimitError` にする（前はただの `WorkspaceError`）。
- **探す箇所**: `except WorkspaceError` のあとで、メッセージに `usage_limit` / `subscription_sharing` が入っているかを見ているところ。
- **書き換え**: `except UsageLimitError` にする。

### PY-6: ターンを途中で止める

- **API**: `run_turn(text, cancel=threading.Event())`。ほかのスレッドから `cancel.set()` すると `turn/interrupt` を送り、
  `status == "interrupted"` の結果を返す（例外にしない）。`turn/start` の応答より先に set したときは、turn の id が分かってから送る。
- **探す箇所**: `run_turn` を別スレッドで動かして `close()` やプロセスの kill で止めているところ、`turn_timeout` を短くして止めているところ。
- **書き換え**: `cancel=` を渡して、`status == "interrupted"` を見る。

### PY-7: `turn/start` の入力に `text_elements` を付ける

- **振る舞い**: `input: [{"type": "text", "text": text, "text_elements": []}]`（TypeScript 版と同じ）。
- **書き換え**: 要らない。

### PY-8: 公開する名前を揃える

`from codex_workspace import ...` で次を読めるようにした: `ACCESS_TOKEN_ENV`、`CONTAINER_AUTH`、`chatgpt_plan_overrides`、
`docker_context`、`parse_created`、`parse_usage`（非公開だった `_usage` の名前を変えたもの）。

- **探す箇所**: `from codex_workspace.session import` で非公開の名前（`_usage` など）を読んでいるところ。
- **書き換え**: `from codex_workspace import ...` にする。`_usage` は `parse_usage` にする。

### PY-9: テスト

TypeScript 版と同じ場面を確かめる（access token、環境変数と名乗り、起動し直し、プラン利用の上限、中止、
時間切れ、起動の失敗、app-server が途中で終わる、同梱の Dockerfile が TypeScript 版と同じ）。

### PY-10: 同梱の Dockerfile とビルドの文脈

- **振る舞い**: Dockerfile を `codex_workspace/Dockerfile` から `codex_workspace/docker/Dockerfile` に移し、
  ビルドの文脈を Dockerfile だけのフォルダにした（前は `session.py` や `__pycache__/` も送っていた）。
  `ensure_image()` は前と同じように使える。`with docker_context() as path:` で、そのフォルダを得られる。
- **探す箇所**: `importlib.resources.files("codex_workspace")` や `site-packages/codex_workspace` を自分で組み立てて
  `docker build` しているところ、`src/codex_workspace` を指定して手で `docker build` している手順書（README・スクリプト・CI）。
- **書き換え**: `docker_context()` を使う。手で作る場所は `src/codex_workspace/docker` にする。
