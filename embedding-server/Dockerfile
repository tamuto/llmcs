# 文をベクトルにする HTTP サーバ (server.py)。モデルはイメージに含めず、
# 初回の起動で /models (ボリューム) へ取得する。
#
# 既定は CPU。x86_64 の GPU マシンでは TORCH_INDEX と TORCH_VERSION を CUDA 版に替える
# (例: https://download.pytorch.org/whl/cu128 と 2.14.1+cu128)。CUDA のライブラリは
# torch の wheel に同梱されるので、ベースイメージは替えなくてよい。
# Jetson (aarch64 / L4T) はこの構成の対象外。
ARG BASE_IMAGE=python:3.12-slim
FROM ${BASE_IMAGE}

ARG TORCH_INDEX=https://download.pytorch.org/whl/cpu
ARG TORCH_VERSION=2.14.1+cpu

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/models

WORKDIR /app
RUN pip install --index-url "${TORCH_INDEX}" "torch==${TORCH_VERSION}"
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY server.py models.json ./

EXPOSE 8080
VOLUME ["/models"]
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080"]
