# llmcs

LLM に関するクライアントとサーバをまとめるプロジェクトです。

| ディレクトリ | 内容 | 実行環境 |
| --- | --- | --- |
| `embedding-server/` | 文をベクトルにする HTTP サーバ（sentence-transformers、OpenAI 互換の `/v1/embeddings`） | Docker |
| `llama-server/` | llama.cpp の OpenAI 互換サーバ。Jetson 用（`compose.yaml`）と CPU 用（`compose.cpu.yaml`） | Docker |

どのサーバも OpenAI と同じ形で呼べるようにし、呼ぶ側は URL とモデル名だけを知っていればよいように
します。ホスト側は `127.0.0.1` にだけ公開します。

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
