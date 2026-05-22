import { createSync } from 'nango';
import { z } from 'zod';

const CheckpointSchema = z.object({
  fully_synced: z.string()
});

const EbayOfferSchema = z.object({
  id: z.string(),
  offerId: z.string(),
  sku: z.string(),
  marketplaceId: z.string(),
  format: z.string().nullable().optional(),
  availableQuantity: z.number().nullable().optional(),
  status: z.string(),
  listingId: z.string().nullable().optional(),
  pricingSummary: z.object({
    price: z.object({ value: z.string(), currency: z.string() })
  }).nullable().optional()
});

type EbayOffer = z.infer<typeof EbayOfferSchema>;

interface OffersResponse {
  offers?: Array<{
    offerId: string;
    sku: string;
    marketplaceId: string;
    format?: string;
    availableQuantity?: number;
    status: string;
    listingId?: string;
    pricingSummary?: { price: { value: string; currency: string } };
    [k: string]: unknown;
  }>;
  total?: number;
}

const LIMIT = 100;

const sync = createSync({
  description: 'Pulls eBay offers via Sell Inventory API v1 with offset pagination',
  version: '1.0.0',
  frequency: 'every 6 hours',
  autoStart: true,
  checkpoint: CheckpointSchema,
  models: { EbayOffer: EbayOfferSchema },

  exec: async (nango) => {
    let offset = 0;
    let total = Infinity;

    while (offset < total) {
      const res = await nango.get<OffersResponse>({
        endpoint: `/sell/inventory/v1/offer?limit=${LIMIT}&offset=${offset}`,
        retries: 3
      });

      const offers = res.data.offers ?? [];
      total = res.data.total ?? 0;

      const records: EbayOffer[] = offers.map((o) => ({
        id: o.offerId,
        offerId: o.offerId,
        sku: o.sku,
        marketplaceId: o.marketplaceId,
        format: o.format ?? null,
        availableQuantity: o.availableQuantity ?? null,
        status: o.status,
        listingId: o.listingId ?? null,
        pricingSummary: o.pricingSummary ?? null
      }));

      if (records.length > 0) {
        await nango.batchSave(records, 'EbayOffer');
      }

      offset += LIMIT;
      if (offers.length < LIMIT) break;
    }

    await nango.saveCheckpoint({ fully_synced: 'true' });
  }
});

export type NangoSyncLocal = Parameters<(typeof sync)['exec']>[0];
export default sync;
