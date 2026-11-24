#!/usr/bin/env bash
# Run from the repository root. Only the selected model and browser runtime are staged.
set -eu
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p site/ai-assets
curl --fail --location --retry 3 https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR_MDXNET_Main.onnx -o "$work/UVR_MDXNET_Main.onnx"
curl --fail --location --retry 3 https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-1.23.2.tgz -o "$work/ort.tgz"
(cd "$work"
 sha256sum -c <<'HASHES'
8289784cda38543ff431add4070662813311a8cccfc0112ca82f76d9dba2b4ca  UVR_MDXNET_Main.onnx
0b8707d7efab9a2bea63564d66cad79e897cfd0bd627e5ae000488ffc1c45c7d  ort.tgz
HASHES
 tar xzf ort.tgz package/dist/{ort.min.mjs,ort-wasm-simd-threaded.jsep.mjs,ort-wasm-simd-threaded.jsep.wasm}
)
cp "$work/UVR_MDXNET_Main.onnx" "$work"/package/dist/* site/ai-assets/
