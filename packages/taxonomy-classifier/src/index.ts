// @aonex/taxonomy-classifier — resolve product signals to a canonical node.

export { classify, buildIndex, tokenize, normLabel } from "./classify.js";
export type {
  ProductSignals,
  LeafEntry,
  ClassifierIndex,
  Candidate,
  ClassifyMethod,
  ClassifyResult,
  ClassifyOptions,
} from "./types.js";
