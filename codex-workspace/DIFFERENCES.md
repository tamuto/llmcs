# codex-workspace (Python 版) と TypeScript 版の差分

Python 版（`codex-workspace`）と TypeScript 版（[`@infodb/codex-workspace`](../codex-workspace-ts)）は同じ機能を目指していますが、
今は TypeScript 版（0.2.0）が先に進んでいます。ここに書いたものは、**Python 版で直す予定の箇所**です。
直したものは、この表から消し、版を上げます（予定: 0.3.0）。

Python 版を使っているプログラムでは、下の「呼ぶ側で探す箇所」で自分のコードを検索し、
回避策を書いているところや、未対応のせいで止まっているところを修正箇所として控えておいてください。
Python 版の API 名は**予定**で、直すときに変わることがあります。

| ID | 内容 | 状態 |
| --- | --- | --- |
| [PY-1](#py-1-access-token-で認証するsign-in-with-chatgpt) | access token で認証する（Sign in with ChatGPT） | 未対応 |
| [PY-2](#py-2-app-server-のプロセスに環境変数を渡す) | app-server のプロセスに環境変数を渡す | 未対応 |
| [PY-3](#py-3-initialize-で名乗るアプリを変える) | `initialize` で名乗るアプリを変える | 未対応（版も 0.1.0 のまま） |
| [PY-4](#py-4-起動し直してスレッドを続ける) | 起動し直して、スレッドを続ける | 未対応 |
| [PY-5](#py-5-プラン利用の使用量の上限を-usagelimiterror-にする) | プラン利用の使用量の上限を `UsageLimitError` にする | 未対応 |
| [PY-6](#py-6-ターンを途中で止める) | ターンを途中で止める（`turn/interrupt`） | 未対応（入れるか検討） |
| [PY-7](#py-7-turnstart-の入力に-text_elements-を付ける) | `turn/start` の入力に `text_elements` を付ける | 未対応 |
| [PY-8](#py-8-公開する名前を揃える) | 公開する名前を揃える | 未対応 |
| [PY-9](#py-9-テスト) | テスト | 未対応 |
| [PY-10](#py-10-同梱の-dockerfile-とビルドの文脈) | 同梱の Dockerfile のフォルダを公開し、ビルドの文脈を Dockerfile だけにする | 未対応（リビルドそのものはできる） |

呼ぶ側の書き換えが要るのは、回避策を書いている箇所だけです。どの項目も、既存の呼び方はそのまま動くように
足す予定です（壊す変更はしない）。

---

## PY-1: access token で認証する（Sign in with ChatGPT）

- **TypeScript 版**: `dockerCommand(ws, { accessTokenEnv: ACCESS_TOKEN_ENV })` で、認証のファイルはマウントせずに
  `-e ACCESS_TOKEN`（名前だけ。値は入れない）を付け、プラン利用の provider の設定（`chatgptPlanOverrides()`、`-c` で7つ）で起こす。
  `auth_volume`・`auth_file`・`access_token_env` は、どれか1つだけを渡す。
- **Python 版の今**: `docker_command` は `auth_volume` か `auth_file` しか受け取らない。auth.json（Codex 自身のサインイン）が要る。
- **予定の API**: `docker_command(ws, access_token_env=ACCESS_TOKEN_ENV)`、`chatgpt_plan_overrides(env_key="ACCESS_TOKEN")`、
  `ACCESS_TOKEN_ENV = "ACCESS_TOKEN"`。環境変数の名前は `^[A-Za-z_][A-Za-z0-9_]*$` でなければ `ValueError`。
- **呼ぶ側で探す箇所**: `docker_command(` に `config_overrides` で `model_provider` / `model_providers.` を自前で渡しているところ、
  `docker run` に `-e` を自前で足しているところ、Sign in with ChatGPT を使えずに auth.json を用意しているところ。
- **呼ぶ側の書き換え**: 自前の設定を消して、`access_token_env=` にする。値は PY-2 の `env=` で渡す。

## PY-2: app-server のプロセスに環境変数を渡す

- **TypeScript 版**: `WorkspaceSession.open(cmd, { env: { ACCESS_TOKEN: token } })`。今のプロセスの環境に重ねて渡す。値はログや例外に出さない。
- **Python 版の今**: `subprocess.Popen` に `env` を渡さない。呼ぶ側は `os.environ` を書き換えるしかない。
- **予定の API**: `WorkspaceSession(cmd, env={"ACCESS_TOKEN": token})`。
- **呼ぶ側で探す箇所**: `WorkspaceSession(` の前で `os.environ[...] =` / `os.environ.update(` / `os.putenv(` しているところ。
- **呼ぶ側の書き換え**: `env=` で渡し、`os.environ` を書き換えるのをやめる（ほかのスレッドや子プロセスにトークンが漏れなくなる）。

## PY-3: `initialize` で名乗るアプリを変える

- **TypeScript 版**: `clientInfo: { name, title?, version }` を渡せる。既定は `codex_workspace` と、パッケージの版（0.2.0）。
  Sign in with ChatGPT では、`name` を登録のときの `agent_name_hint` と同じにしなければならない。
- **Python 版の今**: `{"name": "codex_workspace", "version": "0.1.0"}` に固定（パッケージは 0.2.0 なのに、版が古いまま）。
- **予定の API**: `WorkspaceSession(cmd, client_info={"name": ..., "title": ..., "version": ...})`。既定の版はパッケージの版に揃える。
- **呼ぶ側で探す箇所**: `_request("initialize"` を上書きしている・`WorkspaceSession` を継承して `start` を差し替えているところ。
- **呼ぶ側の書き換え**: `client_info=` で渡す。

## PY-4: 起動し直してスレッドを続ける

- **TypeScript 版**: `await session.restart({ env })` で閉じて起こし直し（`env` を渡すと置き換える）、
  `await session.resumeThread(threadId)`（`thread/resume`）で同じスレッドを続ける。トークンの累計は数え直す。
  `startThread` は記録を残さない（`ephemeral`）スレッドなので、続けられるのは記録を残す使い方をしたときだけ。
- **Python 版の今**: どちらもない。access token を更新したら、セッションを作り直して新しいスレッドから頼み直すしかない。
- **予定の API**: `session.restart(env=...)`、`session.resume_thread(thread_id) -> str`。
- **呼ぶ側で探す箇所**: トークンの期限切れや app-server の終了（`WorkspaceError("app-server が終わりました")`）のあとに、
  `WorkspaceSession` を作り直しているところ。
- **呼ぶ側の書き換え**: `restart` と `resume_thread` にする。

## PY-5: プラン利用の使用量の上限を `UsageLimitError` にする

- **TypeScript 版**: `codexErrorInfo` が `usageLimitExceeded` / `rateLimitExceeded` のときに加えて、エラーの中に
  `subscription_sharing_usage_limit_exceeded`（独自の provider では API のエラーが本文のまま届く）があれば `UsageLimitError` にする。
- **Python 版の今**: `codexErrorInfo` しか見ない。プラン利用では、上限に当たってもただの `WorkspaceError` になる。
- **予定の API**: 変わらない（`_is_usage_limit` が見る範囲を広げるだけ）。
- **呼ぶ側で探す箇所**: `except WorkspaceError` のあとで、メッセージに `usage_limit` / `subscription_sharing` が入っているかを見ているところ。
- **呼ぶ側の書き換え**: `except UsageLimitError` にする。

## PY-6: ターンを途中で止める

- **TypeScript 版**: `runTurn(text, { signal })`。`AbortSignal` で中止すると `turn/interrupt` を送り、`status: "interrupted"` の結果を返す
  （例外にしない）。`turn/start` の応答より先に中止したときは、turn の id が分かってから送る。
- **Python 版の今**: ない。止めるには `turn_timeout` を待つか、プロセスを殺すしかない（作業場所が途中の状態で残る）。
- **予定の API**（検討中）: `run_turn(text, cancel=threading.Event())`。`cancel.set()` で `turn/interrupt` を送り、`status == "interrupted"` で返す。
- **呼ぶ側で探す箇所**: `run_turn` を別スレッドで動かして `close()` やプロセスの kill で止めているところ、`turn_timeout` を短くして止めているところ。
- **呼ぶ側の書き換え**: `cancel=` を渡して、`status == "interrupted"` を見る。

## PY-7: `turn/start` の入力に `text_elements` を付ける

- **TypeScript 版**: `input: [{ type: "text", text, text_elements: [] }]`。
- **Python 版の今**: `{"type": "text", "text": text}`（`text_elements` が無い）。今の app-server が必須にしているかは確かめていない。
- **予定**: TypeScript 版と同じにする。
- **呼ぶ側**: 書き換えは要らない。

## PY-8: 公開する名前を揃える

| TypeScript 版 | Python 版の今 | 予定 |
| --- | --- | --- |
| `CONTAINER_AUTH` | 定義はあるが `__all__` に無い | 公開する |
| `parseCreated` | `parse_created` は定義はあるが `__all__` に無い | 公開する |
| `parseUsage` | `_usage`（非公開） | `parse_usage` として公開する |
| `ACCESS_TOKEN_ENV`、`chatgptPlanOverrides` | 無い | PY-1 で足す |
| `DOCKER_CONTEXT` | 無い（`importlib.resources` で読む） | PY-10 で足す |

- **呼ぶ側で探す箇所**: `from codex_workspace.session import` で非公開の名前（`_usage`、`CONTAINER_AUTH` など）を読んでいるところ。
- **呼ぶ側の書き換え**: `from codex_workspace import ...` にする。

## PY-9: テスト

TypeScript 版（`test/session.test.ts`、15件）にあって、Python 版（`tests/test_session.py`、7件）に無いもの:

- access token で起こす `docker_command`（PY-1）
- 環境変数・アプリの名乗りを渡し、起動し直してスレッドを続ける（PY-2・3・4）
- プラン利用の使用量の上限（PY-5）
- 中止すると `turn/interrupt` を送る（PY-6）
- 1回の頼みごとが上限の時間を超えたら例外にする
- 起動できないコマンドは `WorkspaceError` にする
- app-server が途中で終わったら例外にする

偽の app-server（`tests/fake_app_server.py`）も、TypeScript 版の `test/fake-app-server.mjs` に合わせて
`thread/resume`・`turn/interrupt`・環境変数の記録を足します。

## PY-10: 同梱の Dockerfile とビルドの文脈

Dockerfile は両方ともパッケージに同梱していて、入れた先で `ensure_image()` / `ensureImage()` を呼べば作り直せます
（無いときと、`max_age` / `maxAgeMs` より古いとき。すぐに作り直すには `max_age=timedelta(0)` / `maxAgeMs: 0`）。
wheel に `codex_workspace/Dockerfile` が入り、入れた先の site-packages から `docker build` されることは確かめています。
違うのは次の2つです。

- **TypeScript 版**: Dockerfile は `docker/` に Dockerfile だけを置き、その場所を `DOCKER_CONTEXT` で公開している。
  呼ぶ側は、`docker build -t <独自のタグ> --build-arg CODEX_REFRESH=... <DOCKER_CONTEXT>` のように自分でも作れる。
- **Python 版の今**: Dockerfile をパッケージのフォルダ（`codex_workspace/`）にそのまま置き、そのフォルダをビルドの文脈にしている。
  `session.py` や `__pycache__/` も文脈に送られる（イメージには入らないので、動きは同じ）。場所を公開していないので、
  呼ぶ側が自分で作るには `importlib.resources.files("codex_workspace")` を自分で書く。
- **予定**: Dockerfile を `codex_workspace/docker/Dockerfile` に移して、文脈を Dockerfile だけにし、
  `docker_context()`（`with docker_context() as path:` で使う、`importlib.resources.as_file` の薄い包み）を公開する。
  TypeScript 版のテスト「Dockerfile は Python 版と同じものを使う」が読む場所も合わせて直す。
- **呼ぶ側で探す箇所**: `importlib.resources.files("codex_workspace")` や `site-packages/codex_workspace` を自分で組み立てて
  `docker build` しているところ、`src/codex_workspace` を指定して手で `docker build` している手順書（README・スクリプト・CI）。
- **呼ぶ側の書き換え**: `docker_context()` を使う。手で作る手順の場所は `src/codex_workspace/docker` に変わる。
