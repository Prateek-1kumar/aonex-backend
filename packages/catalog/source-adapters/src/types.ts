import type { TenantId, ChannelId, ArtifactId } from "@aonex/types";

export interface AdaptContext {
  tenantId:                 TenantId;
  channelId:                ChannelId;
  channelDefaultCurrency:   string | null;
  channelDefaultLocale:     string | null;
  attributeDefinitions:     AttributeDefinition[];
  attributeSynonyms:        AttributeSynonym[];
}

export interface AttributeDefinition { canonicalKey: string; canonicalUnit: string | null; dataType: string; reconciliationPath: "sync" | "async_debounced"; }
export interface AttributeSynonym { canonicalKey: string; synonym: string; sourceMarketplace: string | null; }

export interface CanonicalObservation {
  attributeCode:   string;
  target:          "parent" | "variant";
  variantAxes?:    Record<string, string>;
  channelCode:     string;
  localeCode:      string;
  source:          string;
  sourceRecordId:  string;
  value:           unknown;
  confidence:      number;
  observedAt:      Date;
  extras?:         Record<string, unknown>;
}

export interface PricingObservation {
  productHint:     string;
  variantAxes?:    Record<string, string>;
  channelCode:     string;
  locale:          string;
  source:          string;
  sourceRecordId:  string;
  currency:        string;
  tiers:           Array<{ kind: string; amount?: number; total?: number; [k: string]: unknown }>;
  pricePerUnit?:   { value: number; unit: string };
  observedAt:      Date;
  artifactId?:     ArtifactId;
  extras?:         Record<string, unknown>;
}

export interface InventoryObservation {
  productHint:     string;
  variantAxes?:    Record<string, string>;
  channelCode:     string;
  locationId?:     string;
  qty:             number;
  clickCollectEligible?: boolean;
  purchaseLimit?:  number;
  backorderAllowed?: boolean;
  source:          string;
  sourceRecordId:  string;
  observedAt:      Date;
  artifactId?:     ArtifactId;
}

export interface AdapterOutput {
  observations:           CanonicalObservation[];
  pricingObservations:    PricingObservation[];
  inventoryObservations:  InventoryObservation[];
  identityHint:           IdentityHint;
  rawPayload:             unknown;
}

export interface IdentityHint {
  gtin?: string;
  mpn?: string;
  brand?: string;
  titleForFuzzy?: string;
  variantAxes?:   Record<string, string>;
  targetIsVariant: boolean;
}

export interface SourceAdapter {
  sourceKind: string;
  adapt(input: unknown, context: AdaptContext): AdapterOutput;
}
