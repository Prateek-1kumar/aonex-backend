/** HLD §10.3 — mapping confidence component weights */
export declare const MAPPING_WEIGHTS: {
    readonly channelMapping: 0.4;
    readonly synonym: 0.18;
    readonly embedding: 0.15;
    readonly typeCompat: 0.1;
    readonly unitCompat: 0.07;
    readonly categoryCompat: 0.06;
    readonly tenantCorrection: 0.04;
};
export interface CandidateScore {
    key: string;
    channelMapping: number;
    synonym: number;
    embedding: number;
    typeCompat: number;
    unitCompat: number;
    categoryCompat: number;
    tenantCorrection: number;
    total: number;
}
export declare function computeScore(components: Omit<CandidateScore, "total">): CandidateScore;
export declare function resolveApproval(score: number): {
    approved: boolean;
    mappingMethod: string;
    warning: boolean;
};
//# sourceMappingURL=scorer.d.ts.map