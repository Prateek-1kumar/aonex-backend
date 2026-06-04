// Public barrel for @aonex/vision-extractor.
//
// Re-exports the tier-3 vision surface: shouldEscalateToVision (when to fire),
// callVision (Groq Llama 3.2 90B Vision extraction from a screenshot), and
// createVisionCallModel (callModel-shaped adapter for the LLM extractor). Spec §6.6.

export {
  shouldEscalateToVision,
  type VisionEscalationSignal,
  type VisionEscalationDecision
} from "./signal-detector.js";
export {
  callVision,
  type VisionCallInput,
  type VisionCallResult,
  type VisionFetchImpl,
  VISION_EXTRACTOR_VERSION
} from "./vision.js";
export {
  createVisionCallModel,
  type CreateVisionCallModelInput,
} from "./call-model-adapter.js";
