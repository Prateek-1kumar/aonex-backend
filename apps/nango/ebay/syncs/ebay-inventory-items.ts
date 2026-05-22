import { createSync } from 'nango';
import { z } from 'zod';

const CheckpointSchema = z.object({
  fully_synced: z.string()
});

const EbayInventoryItemSchema = z.object({
  id: z.string(),
  sku: z.string(),
  condition: z.string().nullable().optional(),
  locale: z.string().nullable().optional(),
  availability: z.object({
    shipToLocationAvailability: z.object({
      quantity: z.number()
    }).optional()
  }).nullable().optional(),
  product: z.object({
    title: z.string().optional(),
    description: z.string().optional()
  }).nullable().optional()
});

type EbayInventoryItem = z.infer<typeof EbayInventoryItemSchema>;

interface InventoryItemsResponse {
  inventoryItems?: Array<{ sku: string; [k: string]: unknown }>;
  total?: number;
  size?: number;
}

const LIMIT = 100;

const sync = createSync({
  description: 'Pulls eBay inventory items via Sell Inventory API v1 with offset pagination',
  version: '1.0.0',
  frequency: 'every 6 hours',
  autoStart: true,
  checkpoint: CheckpointSchema,
  models: { EbayInventoryItem: EbayInventoryItemSchema },

  exec: async (nango) => {
    let offset = 0;
    let total = Infinity;

    while (offset < total) {
      const res = await nango.get<InventoryItemsResponse>({
        endpoint: `/sell/inventory/v1/inventory_item?limit=${LIMIT}&offset=${offset}`,
        retries: 3
      });

      const items = res.data.inventoryItems ?? [];
      total = res.data.total ?? 0;

      const records: EbayInventoryItem[] = items.map((item) => ({
        id: item.sku,
        sku: item.sku,
        condition: (item['condition'] as string | undefined) ?? null,
        locale: (item['locale'] as string | undefined) ?? null,
        availability: (item['availability'] as EbayInventoryItem['availability']) ?? null,
        product: (item['product'] as EbayInventoryItem['product']) ?? null
      }));

      if (records.length > 0) {
        await nango.batchSave(records, 'EbayInventoryItem');
      }

      offset += LIMIT;
      if (items.length < LIMIT) break;
    }

    await nango.saveCheckpoint({ fully_synced: 'true' });
  }
});

export type NangoSyncLocal = Parameters<(typeof sync)['exec']>[0];
export default sync;
