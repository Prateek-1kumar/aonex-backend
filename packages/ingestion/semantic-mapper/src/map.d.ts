import type { MappedFactSet, MapperCorpus } from "./types.js";
import type { ExtractedFactSet } from "@aonex/ingestion-field-extractor";
export declare const MAPPER_VERSION = "deterministic-synonym@1.0.0";
/**
 * HLD §10 — map a fact set to canonical attribute paths.
 *
 * @param factSet - raw extracted facts from the Field Extractor
 * @param categoryPath - detected category (null if undetected)
 * @param corpus - attribute DB lookups passed as pure data by the worker
 */
export declare function map(factSet: ExtractedFactSet, categoryPath: string | null, corpus: MapperCorpus): MappedFactSet;
//# sourceMappingURL=map.d.ts.map