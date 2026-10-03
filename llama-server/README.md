# GPU版 llama-server

Jetson Orin（aarch64 / JetPack R36.x）で、kumuのローカル読解器と互換性のある
llama.cpp OpenAI互換サーバーを起動するための構成です。Dockerfileはモデルを含めません。
モデルはホストのディレクトリから読み取り専用でマウントします。

## 接続先での起動

`remote.json`の接続先で、次のように実行します。

```bash
cd /home/tamuto/workspaces/llama-server
mkdir -p models
# models/model.gguf をここへ配置（例: Qwen3-4BのGGUF）
docker compose build
MODEL_FILE=/models/model.gguf docker compose up -d
curl http://127.0.0.1:8080/health
```

接続先の既存イメージ `allbase:l4t-r36.3.0-cmake` を使います。別のJetson環境では、
対応するL4T CUDAイメージを `BASE_IMAGE` で指定してください。Orinの計算能力は87として
ビルドします。ビルド対象はllama.cpp `b10831`に固定し、更新時は `LLAMA_CPP_REF`を変更します。

## ローカルのkumuから使う

外部ネットワークへ8080を公開せず、SSHトンネルを使います。

```bash
ssh -N -L 8080:127.0.0.1:8080 tamuto@192.168.3.5
```

トンネルを別端末で維持した状態で、呼ぶ側の接続先を `http://127.0.0.1:8080/v1`、
modelを`kumu-reader`（Composeの既定alias）に設定します。
接続先のCompose設定はデフォルトで
コンテナ内部は0.0.0.0へbindしますが、ホスト側の公開ポートは127.0.0.1に限定しています。

## 設定変更

`.env`は秘密情報を置く用途ではありません。主に次を変更できます。

```dotenv
MODEL_FILE=/models/Qwen3-4B-Q4_K_M.gguf
MODEL_DIR=/home/tamuto/models
LLAMA_CPP_REF=b10831
CTX_SIZE=8192
GPU_LAYERS=999
```

モデルのライセンス、取得元、量子化形式は別途確認してください。

2026-09-07に接続先でQwen3-4Bを実測したところ、`/health`は正常、API応答は約11.3
token/s、`tegrastats`の推論中`GR3D_FREQ`は88～99%だった。GPUオフロードが無効な
CPU-only動作ではこのGPU負荷にならないため、CUDA経路で推論していることを確認できる。

## 常駐せず単発で読む

同じGPUイメージに`llama-cli`も含めています。接続先でプロンプトを1回だけ実行する場合は、
次のようにします。

```bash
cd /home/tamuto/workspaces/llama-server
docker compose build
docker run --rm --runtime nvidia \
  --entrypoint /usr/local/lib/llama.cpp/llama-cli \
  -v "$PWD/models:/models:ro" \
  kumu-llama-server:b10831 \
  -m /models/model.gguf -ngl 999 -c 4096 -n 256 \
  -p '横浜市のAI活用について、計画と実績を区別して説明してください。'
```

常駐サーバーはAPI利用やkumu接続に向き、CLIは調査メモの単発生成に向きます。

## メモリ調整

8GB共有メモリでは、`-ngl 999`（全層GPU）、`-np 1`（同時1枠）、`-c 8192`を既定にしています。
余裕が必要なら`-c 4096`へ下げます。より大きい7～8B級Q4モデルは重みだけで約4～5GBとなり、
KVキャッシュ・ランタイムと合わせてswapやOOMになる可能性が高いので、導入時は別モデル名・
別Composeプロジェクトで試してください。
