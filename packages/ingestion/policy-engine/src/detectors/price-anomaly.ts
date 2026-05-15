import type { Detector, ReviewTaskSignal, RouterInput } from "../types.js";

const MIN_SAMPLE = 10;
const HIGH_RATIO = 5;
const LOW_RATIO = 0.2;

export const detectPriceAnomaly: Detector = (input: RouterInput): ReviewTaskSignal | null => {
  if (!input.priceCluster || input.priceCluster.sampleCount < MIN_SAMPLE) return null;
  const price = input.payload.basePrice;
  if (price == null) return null;
  const median = input.priceCluster.medianPrice;
  if (!(price > median * HIGH_RATIO) && !(price < median * LOW_RATIO)) return null;
  return {
    signalKind: "price_anomaly",
    severity: "high",
    fieldName: "basePrice",
    clusterDimensions: {
      domain: input.domain,
      brand: input.payload.brand ?? "",
      category: input.payload.canonicalCategory ?? "",
    },
    payload: {
      evidence: { price, median, sample: input.priceCluster.sampleCount },
      reasonText: `Price ${price} is ${(price / median).toFixed(1)}× the cluster median ${median}`,
      affectedFields: ["basePrice"],
    },
  };
};
