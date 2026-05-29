// Phase 4 Task 9: count-weighted cross-source review aggregate.
// A 100-review source should outweigh a 5-review one when computing the
// cross-channel mean; empty input must return zeros (not NaN) so downstream
// rendering never breaks on a newly-created product with no reviews.

export interface SourceRating {
  source: string;
  avg: number;
  count: number;
}

export interface AggregateRating {
  average: number;
  count: number;
  bySource: SourceRating[];
}

/** Cross-source weighted mean: sum(avg_i * count_i) / sum(count_i). */
export function aggregateReviews(ratings: SourceRating[]): AggregateRating {
  const count = ratings.reduce((s, r) => s + r.count, 0);
  const average =
    count === 0 ? 0 : ratings.reduce((s, r) => s + r.avg * r.count, 0) / count;
  return { average, count, bySource: ratings };
}
