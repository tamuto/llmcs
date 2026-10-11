# llmcs

LLM に関するクライアントとサーバをまとめるプロジェクトです。

| ディレクトリ | 内容 | 実行環境 |
| --- | --- | --- |
| `embedding-server/` | 文をベクトルにする HTTP サーバ（sentence-transformers、OpenAI 互換の `/v1/embeddings`） | Docker |
| `codex-workspace/` | `codex app-server` を、作業場所だけをマウントしたコンテナで動かし、ファイルを書かせる部品 | Docker、Python 3.11 以上 |
| `codex-workspace-ts/` | `codex-workspace` の TypeScript 版（同じイメージを共有） | Docker、Node 22 以上 |
| `codex-app-server-client/` | `codex app-server` を stdio の JSON-RPC で呼ぶ Python クライアント | Python 3.11 以上 |
| `llama-server/` | llama.cpp の OpenAI 互換サーバ。Jetson 用（`compose.yaml`）と CPU 用（`compose.cpu.yaml`） | Docker |

Python のパッケージは、利用する側から uv の git 依存（`subdirectory` とタグ）で参照します。
タグはパッケージ名を頭に付けます（例: `codex-app-server-client-v0.2.0`）。
TypeScript のパッケージは npm レジストリに公開します（`@infodb/codex-workspace`）。

どのサーバも OpenAI と同じ形で呼べるようにし、呼ぶ側は URL とモデル名だけを知っていればよいように
します。ホスト側は `127.0.0.1` にだけ公開します。

## codex-app-server-client を検証する

```bash
cd codex-app-server-client
uv run pytest -q
uv run ruff check .
```

## Codex に作業場所を渡してファイルを書かせる（codex-workspace）

Codex 自身の囲い（bubblewrap）は、ユーザ名前空間を作れないコンテナの中では働かず、書き込みが全部
拒否されます。そこで、作業場所だけをマウントしたコンテナを囲いにして、その中では囲いなしで動かします。
作業場所のパスは、Docker のデーモンから見た場所（ホストの場所）で渡します。

```python
from codex_workspace import WorkspaceSession, docker_command, ensure_image

ensure_image()  # 無いか1日より古ければ作り直す (最新の Codex を入れる)
command = docker_command("/mnt/usb/assets/kotonoha/graph", auth_volume="denv-cc-remote_codex-state")
with WorkspaceSession(command, model="gpt-6.1-sol", effort="medium") as session:
    session.start_thread("作業の決まり (developer instructions)")
    result = session.run_turn("inbox/a.md を取り込んでください")
    print(result.changed, result.usage)   # 書き換えたファイルと、使ったトークン
    session.run_turn("次の誤りを直してください …")   # 同じスレッドに続けて頼む
```

アカウントの使用量は `session.usage()` で読めます（`account/rateLimits/read`）。続けて頼む処理では、頼む前に
見て、上限に近ければ頼まないようにします。上限に当たって失敗したターンは `UsageLimitError`
（`WorkspaceError` の一種）になるので、そこで続けるのをやめます。

```python
usage = session.usage()
usage.used(300), usage.used(10080)   # 5時間の窓と週の窓の、使った割合 (%)
```

```bash
cd codex-workspace
docker build -t llmcs-codex-workspace:local src/codex_workspace   # 手で作り直すとき
uv run pytest -q
uv run ruff check .
```

TypeScript 版（`codex-workspace-ts/`）も同じ使い方です。今は TypeScript 版が先に進んでいて、Python 版で直す予定の差分は
[codex-workspace/DIFFERENCES.md](codex-workspace/DIFFERENCES.md) にあります。

```ts
import { WorkspaceSession, dockerCommand, ensureImage } from "@infodb/codex-workspace";

await ensureImage();
await using session = await WorkspaceSession.open(
  dockerCommand("/mnt/usb/assets/kotonoha/graph", { authVolume: "denv-cc-remote_codex-state" }),
  { model: "gpt-6.1-sol", effort: "medium" },
);
await session.startThread("作業の決まり (developer instructions)");
const result = await session.runTurn("inbox/a.md を取り込んでください");
```

```bash
cd codex-workspace-ts
pnpm install
pnpm check   # 型検査・テスト・ビルド (dist/ はコミットする)
```

## 文をベクトルにする（embedding-server）

初回の起動でモデル（合わせて約3.5GB）をボリュームへ取得するので、使えるようになるまで数分かかります。

```bash
cd embedding-server
docker compose up -d --build
curl http://127.0.0.1:8081/v1/models
curl http://127.0.0.1:8081/v1/embeddings -H 'Content-Type: application/json' \
  -d '{"model": "bge-m3", "input": ["Vite+ 1.0 正式リリース"]}'

# 読み込むモデルを絞る、ポートを変える
MODELS=bge-m3 PORT=8082 docker compose up -d

# x86_64 の GPU マシンでは torch を CUDA 版にする（GPU をコンテナへ渡す設定は別に要る。未検証）
TORCH_INDEX=https://download.pytorch.org/whl/cu128 TORCH_VERSION=2.14.1+cu128 docker compose build
```

## llama-server を CPU で動かす

LLM（Qwen3.5-4B）と埋め込み（bge-m3）の2つを動かします。モデルは Hugging Face のコミットに固定して、
名前付きボリュームへ取得します。

```bash
docker volume create llmcs_llama_models
docker run --rm --user root -v llmcs_llama_models:/models curlimages/curl sh -c '
  cd /models &&
  curl -fL -o qwen3.5-4b-q4_k_m.gguf https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/e87f176479d0855a907a41277aca2f8ee7a09523/Qwen3.5-4B-Q4_K_M.gguf &&
  curl -fL -o bge-m3-q8_0.gguf https://huggingface.co/ggml-org/bge-m3-Q8_0-GGUF/resolve/9eba04c5d75ba5a1595e45de734d36bef4e5cb98/bge-m3-q8_0.gguf'

cd llama-server
docker compose -f compose.cpu.yaml up -d
curl http://127.0.0.1:8090/health   # LLM
curl http://127.0.0.1:8091/health   # 埋め込み
```

Jetson（aarch64 / JetPack）で GPU を使う構成は `llama-server/README.md` を参照してください。
