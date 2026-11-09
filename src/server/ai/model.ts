import { INPUT_TOKEN_CAP, OUTPUT_TOKEN_CAP } from '../caps';
export const MODEL_ID = '@cf/ibm-granite/granite-4.0-h-micro';
export const DEPRECATED_MODELS: readonly string[] = ['@cf/meta/llama-3.2-3b-instruct', '@cf/qwen/qwen3-30b-a3b-fp8'];
export const INPUT_NEURONS_PER_MILLION = 1542;
export const OUTPUT_NEURONS_PER_MILLION = 10158;
export const estimateTokens = (text: string) => Math.ceil(text.length / 3.5);
export const neurons = (input: number, output: number) => (input * INPUT_NEURONS_PER_MILLION + output * OUTPUT_NEURONS_PER_MILLION) / 1e6;
// 2500 * 1542 / 1e6 + 220 * 10158 / 1e6 = 6.08976 < reserve 8.
// Bounded by the shared ledger's 9,500 / free 10,000 daily neurons: $0.
export const MAX_NEURONS = neurons(INPUT_TOKEN_CAP, OUTPUT_TOKEN_CAP);
