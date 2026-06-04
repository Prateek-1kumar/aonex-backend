// Nango sync script for the eBay sandbox `ebay-orders` model.
//
// Runs inside Nango's runtime: pages the Sell Fulfillment API v1 (/order)
// filtered by a creationDate checkpoint and batchSaves EbayOrder records
// into Nango's cache for the connection. Incremental: advances the
// created_after checkpoint per page. Default export is the createSync
// definition (frequency every 1h, autoStart).

import { createSync } from 'nango';
import { z } from 'zod';

const CheckpointSchema = z.object({
  created_after: z.string()
});

const MoneySchema = z.object({ value: z.string(), currency: z.string() });

const EbayOrderSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  legacyOrderId: z.string().nullable().optional(),
  creationDate: z.string(),
  lastModifiedDate: z.string(),
  orderFulfillmentStatus: z.string(),
  orderPaymentStatus: z.string().nullable().optional(),
  pricingSummary: z.object({ total: MoneySchema }).nullable().optional()
});

type EbayOrder = z.infer<typeof EbayOrderSchema>;

interface OrdersResponse {
  orders?: Array<{
    orderId: string;
    legacyOrderId?: string;
    creationDate: string;
    lastModifiedDate: string;
    orderFulfillmentStatus: string;
    orderPaymentStatus?: string;
    pricingSummary?: { total: { value: string; currency: string } };
    [k: string]: unknown;
  }>;
  total?: number;
  next?: string;
}

const LIMIT = 50;

const sync = createSync({
  description: 'Pulls eBay orders via Sell Fulfillment API v1 with creationDate checkpoint',
  version: '1.0.0',
  frequency: 'every 1 hour',
  autoStart: true,
  checkpoint: CheckpointSchema,
  models: { EbayOrder: EbayOrderSchema },

  exec: async (nango) => {
    const checkpoint = await nango.getCheckpoint();
    const createdAfter = checkpoint?.created_after ?? '';

    const filterParam = createdAfter
      ? `&filter=creationdate:[${createdAfter}..]`
      : '';

    let cursor: string | undefined;
    let latestDate = createdAfter;
    let fetched = 0;

    do {
      const offsetParam = cursor ? `&offset=${cursor}` : '';
      const res = await nango.get<OrdersResponse>({
        endpoint: `/sell/fulfillment/v1/order?limit=${LIMIT}${filterParam}${offsetParam}`,
        retries: 3
      });

      const orders = res.data.orders ?? [];

      const records: EbayOrder[] = orders.map((o) => ({
        id: o.orderId,
        orderId: o.orderId,
        legacyOrderId: o.legacyOrderId ?? null,
        creationDate: o.creationDate,
        lastModifiedDate: o.lastModifiedDate,
        orderFulfillmentStatus: o.orderFulfillmentStatus,
        orderPaymentStatus: o.orderPaymentStatus ?? null,
        pricingSummary: o.pricingSummary ?? null
      }));

      if (records.length > 0) {
        await nango.batchSave(records, 'EbayOrder');
        const last = records[records.length - 1];
        if (last && last.creationDate > latestDate) {
          latestDate = last.creationDate;
          await nango.saveCheckpoint({ created_after: latestDate });
        }
      }

      fetched += orders.length;
      cursor = res.data.next ? String(fetched) : undefined;
    } while (cursor);
  }
});

export type NangoSyncLocal = Parameters<(typeof sync)['exec']>[0];
export default sync;
