# Jetson Orin / JetPack R36.x 用。既定値は接続先にあるL4Tビルド環境。
# 別のJetson環境では BASE_IMAGE を対応するL4T CUDAイメージに変更する。
ARG BASE_IMAGE=allbase:l4t-r36.3.0-cmake

FROM ${BASE_IMAGE} AS builder
ARG LLAMA_CPP_REF=b10831
ARG CUDA_ARCH=87

ENV DEBIAN_FRONTEND=noninteractive \
    CUDAARCHS=${CUDA_ARCH} \
    CMAKE_CUDA_ARCHITECTURES=${CUDA_ARCH}

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
RUN git clone --depth 1 --branch "${LLAMA_CPP_REF}" \
      https://github.com/ggml-org/llama.cpp.git llama.cpp

WORKDIR /build/llama.cpp
RUN cmake -S . -B build \
      -DGGML_CUDA=ON \
      -DGGML_NATIVE=OFF \
      -DGGML_CCACHE=OFF \
      -DLLAMA_CURL=OFF \
      -DCMAKE_CUDA_ARCHITECTURES=${CUDA_ARCH} \
    && cmake --build build --target llama-server -j"$(nproc)"

# CLIはサーバーのビルド成果物を再利用して追加する。
RUN cmake --build build --target llama-cli -j"$(nproc)"

FROM ${BASE_IMAGE} AS runtime
ARG LLAMA_CPP_REF=b10831

LABEL org.opencontainers.image.title="kumu llama.cpp server" \
      org.opencontainers.image.source="https://github.com/ggml-org/llama.cpp" \
      org.opencontainers.image.version="${LLAMA_CPP_REF}"

COPY --from=builder /build/llama.cpp/build/bin/ /usr/local/lib/llama.cpp/

ENV NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility \
    LD_LIBRARY_PATH=/usr/local/lib/llama.cpp:/usr/local/cuda/lib64:/usr/local/cuda/compat \
    MODEL_FILE=/models/model.gguf \
    HOST=0.0.0.0 \
    PORT=8080 \
    ALIAS=kumu-reader \
    CTX_SIZE=8192 \
    PARALLEL=1 \
    GPU_LAYERS=999

EXPOSE 8080
WORKDIR /models

ENTRYPOINT ["/bin/sh", "-c"]
CMD ["exec /usr/local/lib/llama.cpp/llama-server -m \"${MODEL_FILE}\" --alias \"${ALIAS}\" --host \"${HOST}\" --port \"${PORT}\" -c \"${CTX_SIZE}\" -np \"${PARALLEL}\" -ngl \"${GPU_LAYERS}\" --jinja --reasoning off --no-webui"]
