"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// ebay/syncs/ebay-orders.ts
var ebay_orders_exports = {};
__export(ebay_orders_exports, {
  default: () => ebay_orders_default
});
module.exports = __toCommonJS(ebay_orders_exports);
var import_zod = require("zod");
var CheckpointSchema = import_zod.z.object({
  created_after: import_zod.z.string()
});
var MoneySchema = import_zod.z.object({
  value: import_zod.z.string(),
  currency: import_zod.z.string()
});
var EbayOrderSchema = import_zod.z.object({
  id: import_zod.z.string(),
  orderId: import_zod.z.string(),
  legacyOrderId: import_zod.z.string().nullable().optional(),
  creationDate: import_zod.z.string(),
  lastModifiedDate: import_zod.z.string(),
  orderFulfillmentStatus: import_zod.z.string(),
  orderPaymentStatus: import_zod.z.string().nullable().optional(),
  pricingSummary: import_zod.z.object({
    total: MoneySchema
  }).nullable().optional()
});
var LIMIT = 50;
var sync = {
  type: "sync",
  description: "Pulls eBay orders via Sell Fulfillment API v1 with creationDate checkpoint",
  version: "1.0.0",
  frequency: "every 1 hour",
  autoStart: true,
  checkpoint: CheckpointSchema,
  models: {
    EbayOrder: EbayOrderSchema
  },
  exec: async (nango) => {
    const checkpoint = await nango.getCheckpoint();
    const createdAfter = checkpoint?.created_after ?? "";
    const filterParam = createdAfter ? `&filter=creationdate:[${createdAfter}..]` : "";
    let cursor;
    let latestDate = createdAfter;
    let fetched = 0;
    do {
      const offsetParam = cursor ? `&offset=${cursor}` : "";
      const res = await nango.get({
        endpoint: `/sell/fulfillment/v1/order?limit=${LIMIT}${filterParam}${offsetParam}`,
        retries: 3
      });
      const orders = res.data.orders ?? [];
      const records = orders.map((o) => ({
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
        await nango.batchSave(records, "EbayOrder");
        const last = records[records.length - 1];
        if (last && last.creationDate > latestDate) {
          latestDate = last.creationDate;
          await nango.saveCheckpoint({
            created_after: latestDate
          });
        }
      }
      fetched += orders.length;
      cursor = res.data.next ? String(fetched) : void 0;
    } while (cursor);
  }
};
var ebay_orders_default = sync;
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiZWJheS9zeW5jcy9lYmF5LW9yZGVycy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgY3JlYXRlU3luYyB9IGZyb20gJ25hbmdvJztcbmltcG9ydCB7IHogfSBmcm9tICd6b2QnO1xuY29uc3QgQ2hlY2twb2ludFNjaGVtYSA9IHoub2JqZWN0KHtcbiAgY3JlYXRlZF9hZnRlcjogei5zdHJpbmcoKVxufSk7XG5jb25zdCBNb25leVNjaGVtYSA9IHoub2JqZWN0KHtcbiAgdmFsdWU6IHouc3RyaW5nKCksXG4gIGN1cnJlbmN5OiB6LnN0cmluZygpXG59KTtcbmNvbnN0IEViYXlPcmRlclNjaGVtYSA9IHoub2JqZWN0KHtcbiAgaWQ6IHouc3RyaW5nKCksXG4gIG9yZGVySWQ6IHouc3RyaW5nKCksXG4gIGxlZ2FjeU9yZGVySWQ6IHouc3RyaW5nKCkubnVsbGFibGUoKS5vcHRpb25hbCgpLFxuICBjcmVhdGlvbkRhdGU6IHouc3RyaW5nKCksXG4gIGxhc3RNb2RpZmllZERhdGU6IHouc3RyaW5nKCksXG4gIG9yZGVyRnVsZmlsbG1lbnRTdGF0dXM6IHouc3RyaW5nKCksXG4gIG9yZGVyUGF5bWVudFN0YXR1czogei5zdHJpbmcoKS5udWxsYWJsZSgpLm9wdGlvbmFsKCksXG4gIHByaWNpbmdTdW1tYXJ5OiB6Lm9iamVjdCh7XG4gICAgdG90YWw6IE1vbmV5U2NoZW1hXG4gIH0pLm51bGxhYmxlKCkub3B0aW9uYWwoKVxufSk7XG50eXBlIEViYXlPcmRlciA9IHouaW5mZXI8dHlwZW9mIEViYXlPcmRlclNjaGVtYT47XG5pbnRlcmZhY2UgT3JkZXJzUmVzcG9uc2Uge1xuICBvcmRlcnM/OiBBcnJheTx7XG4gICAgb3JkZXJJZDogc3RyaW5nO1xuICAgIGxlZ2FjeU9yZGVySWQ/OiBzdHJpbmc7XG4gICAgY3JlYXRpb25EYXRlOiBzdHJpbmc7XG4gICAgbGFzdE1vZGlmaWVkRGF0ZTogc3RyaW5nO1xuICAgIG9yZGVyRnVsZmlsbG1lbnRTdGF0dXM6IHN0cmluZztcbiAgICBvcmRlclBheW1lbnRTdGF0dXM/OiBzdHJpbmc7XG4gICAgcHJpY2luZ1N1bW1hcnk/OiB7XG4gICAgICB0b3RhbDoge1xuICAgICAgICB2YWx1ZTogc3RyaW5nO1xuICAgICAgICBjdXJyZW5jeTogc3RyaW5nO1xuICAgICAgfTtcbiAgICB9O1xuICAgIFtrOiBzdHJpbmddOiB1bmtub3duO1xuICB9PjtcbiAgdG90YWw/OiBudW1iZXI7XG4gIG5leHQ/OiBzdHJpbmc7XG59XG5jb25zdCBMSU1JVCA9IDUwO1xuY29uc3Qgc3luYyA9IHtcbiAgdHlwZTogXCJzeW5jXCIsXG4gIGRlc2NyaXB0aW9uOiAnUHVsbHMgZUJheSBvcmRlcnMgdmlhIFNlbGwgRnVsZmlsbG1lbnQgQVBJIHYxIHdpdGggY3JlYXRpb25EYXRlIGNoZWNrcG9pbnQnLFxuICB2ZXJzaW9uOiAnMS4wLjAnLFxuICBmcmVxdWVuY3k6ICdldmVyeSAxIGhvdXInLFxuICBhdXRvU3RhcnQ6IHRydWUsXG4gIGNoZWNrcG9pbnQ6IENoZWNrcG9pbnRTY2hlbWEsXG4gIG1vZGVsczoge1xuICAgIEViYXlPcmRlcjogRWJheU9yZGVyU2NoZW1hXG4gIH0sXG4gIGV4ZWM6IGFzeW5jIG5hbmdvID0+IHtcbiAgICBjb25zdCBjaGVja3BvaW50ID0gYXdhaXQgbmFuZ28uZ2V0Q2hlY2twb2ludCgpO1xuICAgIGNvbnN0IGNyZWF0ZWRBZnRlciA9IGNoZWNrcG9pbnQ/LmNyZWF0ZWRfYWZ0ZXIgPz8gJyc7XG4gICAgY29uc3QgZmlsdGVyUGFyYW0gPSBjcmVhdGVkQWZ0ZXIgPyBgJmZpbHRlcj1jcmVhdGlvbmRhdGU6WyR7Y3JlYXRlZEFmdGVyfS4uXWAgOiAnJztcbiAgICBsZXQgY3Vyc29yOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gICAgbGV0IGxhdGVzdERhdGUgPSBjcmVhdGVkQWZ0ZXI7XG4gICAgbGV0IGZldGNoZWQgPSAwO1xuICAgIGRvIHtcbiAgICAgIGNvbnN0IG9mZnNldFBhcmFtID0gY3Vyc29yID8gYCZvZmZzZXQ9JHtjdXJzb3J9YCA6ICcnO1xuICAgICAgY29uc3QgcmVzID0gYXdhaXQgbmFuZ28uZ2V0PE9yZGVyc1Jlc3BvbnNlPih7XG4gICAgICAgIGVuZHBvaW50OiBgL3NlbGwvZnVsZmlsbG1lbnQvdjEvb3JkZXI/bGltaXQ9JHtMSU1JVH0ke2ZpbHRlclBhcmFtfSR7b2Zmc2V0UGFyYW19YCxcbiAgICAgICAgcmV0cmllczogM1xuICAgICAgfSk7XG4gICAgICBjb25zdCBvcmRlcnMgPSByZXMuZGF0YS5vcmRlcnMgPz8gW107XG4gICAgICBjb25zdCByZWNvcmRzOiBFYmF5T3JkZXJbXSA9IG9yZGVycy5tYXAobyA9PiAoe1xuICAgICAgICBpZDogby5vcmRlcklkLFxuICAgICAgICBvcmRlcklkOiBvLm9yZGVySWQsXG4gICAgICAgIGxlZ2FjeU9yZGVySWQ6IG8ubGVnYWN5T3JkZXJJZCA/PyBudWxsLFxuICAgICAgICBjcmVhdGlvbkRhdGU6IG8uY3JlYXRpb25EYXRlLFxuICAgICAgICBsYXN0TW9kaWZpZWREYXRlOiBvLmxhc3RNb2RpZmllZERhdGUsXG4gICAgICAgIG9yZGVyRnVsZmlsbG1lbnRTdGF0dXM6IG8ub3JkZXJGdWxmaWxsbWVudFN0YXR1cyxcbiAgICAgICAgb3JkZXJQYXltZW50U3RhdHVzOiBvLm9yZGVyUGF5bWVudFN0YXR1cyA/PyBudWxsLFxuICAgICAgICBwcmljaW5nU3VtbWFyeTogby5wcmljaW5nU3VtbWFyeSA/PyBudWxsXG4gICAgICB9KSk7XG4gICAgICBpZiAocmVjb3Jkcy5sZW5ndGggPiAwKSB7XG4gICAgICAgIGF3YWl0IG5hbmdvLmJhdGNoU2F2ZShyZWNvcmRzLCAnRWJheU9yZGVyJyk7XG4gICAgICAgIGNvbnN0IGxhc3QgPSByZWNvcmRzW3JlY29yZHMubGVuZ3RoIC0gMV07XG4gICAgICAgIGlmIChsYXN0ICYmIGxhc3QuY3JlYXRpb25EYXRlID4gbGF0ZXN0RGF0ZSkge1xuICAgICAgICAgIGxhdGVzdERhdGUgPSBsYXN0LmNyZWF0aW9uRGF0ZTtcbiAgICAgICAgICBhd2FpdCBuYW5nby5zYXZlQ2hlY2twb2ludCh7XG4gICAgICAgICAgICBjcmVhdGVkX2FmdGVyOiBsYXRlc3REYXRlXG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGZldGNoZWQgKz0gb3JkZXJzLmxlbmd0aDtcbiAgICAgIGN1cnNvciA9IHJlcy5kYXRhLm5leHQgPyBTdHJpbmcoZmV0Y2hlZCkgOiB1bmRlZmluZWQ7XG4gICAgfSB3aGlsZSAoY3Vyc29yKTtcbiAgfVxufTtcbmV4cG9ydCB0eXBlIE5hbmdvU3luY0xvY2FsID0gUGFyYW1ldGVyczwodHlwZW9mIHN5bmMpWydleGVjJ10+WzBdO1xuZXhwb3J0IGRlZmF1bHQgc3luYzsiXSwKICAibWFwcGluZ3MiOiAiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFDQSxpQkFBa0I7QUFDbEIsSUFBTSxtQkFBbUIsYUFBRSxPQUFPO0FBQUEsRUFDaEMsZUFBZSxhQUFFLE9BQU87QUFDMUIsQ0FBQztBQUNELElBQU0sY0FBYyxhQUFFLE9BQU87QUFBQSxFQUMzQixPQUFPLGFBQUUsT0FBTztBQUFBLEVBQ2hCLFVBQVUsYUFBRSxPQUFPO0FBQ3JCLENBQUM7QUFDRCxJQUFNLGtCQUFrQixhQUFFLE9BQU87QUFBQSxFQUMvQixJQUFJLGFBQUUsT0FBTztBQUFBLEVBQ2IsU0FBUyxhQUFFLE9BQU87QUFBQSxFQUNsQixlQUFlLGFBQUUsT0FBTyxFQUFFLFNBQVMsRUFBRSxTQUFTO0FBQUEsRUFDOUMsY0FBYyxhQUFFLE9BQU87QUFBQSxFQUN2QixrQkFBa0IsYUFBRSxPQUFPO0FBQUEsRUFDM0Isd0JBQXdCLGFBQUUsT0FBTztBQUFBLEVBQ2pDLG9CQUFvQixhQUFFLE9BQU8sRUFBRSxTQUFTLEVBQUUsU0FBUztBQUFBLEVBQ25ELGdCQUFnQixhQUFFLE9BQU87QUFBQSxJQUN2QixPQUFPO0FBQUEsRUFDVCxDQUFDLEVBQUUsU0FBUyxFQUFFLFNBQVM7QUFDekIsQ0FBQztBQXFCRCxJQUFNLFFBQVE7QUFDZCxJQUFNLE9BQU87QUFBQSxFQUNYLE1BQU07QUFBQSxFQUNOLGFBQWE7QUFBQSxFQUNiLFNBQVM7QUFBQSxFQUNULFdBQVc7QUFBQSxFQUNYLFdBQVc7QUFBQSxFQUNYLFlBQVk7QUFBQSxFQUNaLFFBQVE7QUFBQSxJQUNOLFdBQVc7QUFBQSxFQUNiO0FBQUEsRUFDQSxNQUFNLE9BQU0sVUFBUztBQUNuQixVQUFNLGFBQWEsTUFBTSxNQUFNLGNBQWM7QUFDN0MsVUFBTSxlQUFlLFlBQVksaUJBQWlCO0FBQ2xELFVBQU0sY0FBYyxlQUFlLHlCQUF5QixZQUFZLFFBQVE7QUFDaEYsUUFBSTtBQUNKLFFBQUksYUFBYTtBQUNqQixRQUFJLFVBQVU7QUFDZCxPQUFHO0FBQ0QsWUFBTSxjQUFjLFNBQVMsV0FBVyxNQUFNLEtBQUs7QUFDbkQsWUFBTSxNQUFNLE1BQU0sTUFBTSxJQUFvQjtBQUFBLFFBQzFDLFVBQVUsb0NBQW9DLEtBQUssR0FBRyxXQUFXLEdBQUcsV0FBVztBQUFBLFFBQy9FLFNBQVM7QUFBQSxNQUNYLENBQUM7QUFDRCxZQUFNLFNBQVMsSUFBSSxLQUFLLFVBQVUsQ0FBQztBQUNuQyxZQUFNLFVBQXVCLE9BQU8sSUFBSSxRQUFNO0FBQUEsUUFDNUMsSUFBSSxFQUFFO0FBQUEsUUFDTixTQUFTLEVBQUU7QUFBQSxRQUNYLGVBQWUsRUFBRSxpQkFBaUI7QUFBQSxRQUNsQyxjQUFjLEVBQUU7QUFBQSxRQUNoQixrQkFBa0IsRUFBRTtBQUFBLFFBQ3BCLHdCQUF3QixFQUFFO0FBQUEsUUFDMUIsb0JBQW9CLEVBQUUsc0JBQXNCO0FBQUEsUUFDNUMsZ0JBQWdCLEVBQUUsa0JBQWtCO0FBQUEsTUFDdEMsRUFBRTtBQUNGLFVBQUksUUFBUSxTQUFTLEdBQUc7QUFDdEIsY0FBTSxNQUFNLFVBQVUsU0FBUyxXQUFXO0FBQzFDLGNBQU0sT0FBTyxRQUFRLFFBQVEsU0FBUyxDQUFDO0FBQ3ZDLFlBQUksUUFBUSxLQUFLLGVBQWUsWUFBWTtBQUMxQyx1QkFBYSxLQUFLO0FBQ2xCLGdCQUFNLE1BQU0sZUFBZTtBQUFBLFlBQ3pCLGVBQWU7QUFBQSxVQUNqQixDQUFDO0FBQUEsUUFDSDtBQUFBLE1BQ0Y7QUFDQSxpQkFBVyxPQUFPO0FBQ2xCLGVBQVMsSUFBSSxLQUFLLE9BQU8sT0FBTyxPQUFPLElBQUk7QUFBQSxJQUM3QyxTQUFTO0FBQUEsRUFDWDtBQUNGO0FBRUEsSUFBTyxzQkFBUTsiLAogICJuYW1lcyI6IFtdCn0K
