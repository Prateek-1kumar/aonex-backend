import type { ExtractedFactSet, ExtractedFact } from "@aonex/ingestion-field-extractor";
import type { AttributeDefinition, AttributeSynonym, AttributeMapping, MappingOverride } from "@aonex/db";
export interface MappedFact extends ExtractedFact {
    /** Assigned by this mapper run — may remain null if below threshold */
    canonicalPath: string | null;
    mappingMethod: string | null;
    /** Top-3 candidates with scores — stored in extracted_facts.mapping_candidates */
    mappingCandidates: Array<{
        key: string;
        score: number;
    }> | null;
    approved: boolean;
}
export interface MappedFactSet {
    original: ExtractedFactSet;
    facts: MappedFact[];
    mapperVersion: string;
    categoryPath: string | null;
    mappedAt: Date;
}
/** Inputs loaded by the worker from the DB and passed as pure data. */
export interface MapperCorpus {
    knownAttrs: AttributeDefinition[];
    synonyms: AttributeSynonym[];
    channelMappings: AttributeMapping[];
    overrides: MappingOverride[];
}
//# sourceMappingURL=types.d.ts.map