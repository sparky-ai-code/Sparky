// onnxruntime-web 1.22-dev ships without type declarations. Declare the parts the Kitten
// worker uses; the runtime itself is bundled from the pinned package.
declare module "onnxruntime-web" {
  export const env: { wasm: { wasmPaths: string; numThreads: number } };
  export const InferenceSession: {
    create(bytes: Uint8Array, options: { executionProviders: string[] }): Promise<unknown>;
  };
  export const Tensor: new (type: string, data: ArrayLike<number | bigint>, dims: number[]) => unknown;
}
