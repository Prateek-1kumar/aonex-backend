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

// ebay-sandbox/syncs/ebay-orders.ts
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiZWJheS1zYW5kYm94L3N5bmNzL2ViYXktb3JkZXJzLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgeyBjcmVhdGVTeW5jIH0gZnJvbSAnbmFuZ28nO1xuaW1wb3J0IHsgeiB9IGZyb20gJ3pvZCc7XG5jb25zdCBDaGVja3BvaW50U2NoZW1hID0gei5vYmplY3Qoe1xuICBjcmVhdGVkX2FmdGVyOiB6LnN0cmluZygpXG59KTtcbmNvbnN0IE1vbmV5U2NoZW1hID0gei5vYmplY3Qoe1xuICB2YWx1ZTogei5zdHJpbmcoKSxcbiAgY3VycmVuY3k6IHouc3RyaW5nKClcbn0pO1xuY29uc3QgRWJheU9yZGVyU2NoZW1hID0gei5vYmplY3Qoe1xuICBpZDogei5zdHJpbmcoKSxcbiAgb3JkZXJJZDogei5zdHJpbmcoKSxcbiAgbGVnYWN5T3JkZXJJZDogei5zdHJpbmcoKS5udWxsYWJsZSgpLm9wdGlvbmFsKCksXG4gIGNyZWF0aW9uRGF0ZTogei5zdHJpbmcoKSxcbiAgbGFzdE1vZGlmaWVkRGF0ZTogei5zdHJpbmcoKSxcbiAgb3JkZXJGdWxmaWxsbWVudFN0YXR1czogei5zdHJpbmcoKSxcbiAgb3JkZXJQYXltZW50U3RhdHVzOiB6LnN0cmluZygpLm51bGxhYmxlKCkub3B0aW9uYWwoKSxcbiAgcHJpY2luZ1N1bW1hcnk6IHoub2JqZWN0KHtcbiAgICB0b3RhbDogTW9uZXlTY2hlbWFcbiAgfSkubnVsbGFibGUoKS5vcHRpb25hbCgpXG59KTtcbnR5cGUgRWJheU9yZGVyID0gei5pbmZlcjx0eXBlb2YgRWJheU9yZGVyU2NoZW1hPjtcbmludGVyZmFjZSBPcmRlcnNSZXNwb25zZSB7XG4gIG9yZGVycz86IEFycmF5PHtcbiAgICBvcmRlcklkOiBzdHJpbmc7XG4gICAgbGVnYWN5T3JkZXJJZD86IHN0cmluZztcbiAgICBjcmVhdGlvbkRhdGU6IHN0cmluZztcbiAgICBsYXN0TW9kaWZpZWREYXRlOiBzdHJpbmc7XG4gICAgb3JkZXJGdWxmaWxsbWVudFN0YXR1czogc3RyaW5nO1xuICAgIG9yZGVyUGF5bWVudFN0YXR1cz86IHN0cmluZztcbiAgICBwcmljaW5nU3VtbWFyeT86IHtcbiAgICAgIHRvdGFsOiB7XG4gICAgICAgIHZhbHVlOiBzdHJpbmc7XG4gICAgICAgIGN1cnJlbmN5OiBzdHJpbmc7XG4gICAgICB9O1xuICAgIH07XG4gICAgW2s6IHN0cmluZ106IHVua25vd247XG4gIH0+O1xuICB0b3RhbD86IG51bWJlcjtcbiAgbmV4dD86IHN0cmluZztcbn1cbmNvbnN0IExJTUlUID0gNTA7XG5jb25zdCBzeW5jID0ge1xuICB0eXBlOiBcInN5bmNcIixcbiAgZGVzY3JpcHRpb246ICdQdWxscyBlQmF5IG9yZGVycyB2aWEgU2VsbCBGdWxmaWxsbWVudCBBUEkgdjEgd2l0aCBjcmVhdGlvbkRhdGUgY2hlY2twb2ludCcsXG4gIHZlcnNpb246ICcxLjAuMCcsXG4gIGZyZXF1ZW5jeTogJ2V2ZXJ5IDEgaG91cicsXG4gIGF1dG9TdGFydDogdHJ1ZSxcbiAgY2hlY2twb2ludDogQ2hlY2twb2ludFNjaGVtYSxcbiAgbW9kZWxzOiB7XG4gICAgRWJheU9yZGVyOiBFYmF5T3JkZXJTY2hlbWFcbiAgfSxcbiAgZXhlYzogYXN5bmMgbmFuZ28gPT4ge1xuICAgIGNvbnN0IGNoZWNrcG9pbnQgPSBhd2FpdCBuYW5nby5nZXRDaGVja3BvaW50KCk7XG4gICAgY29uc3QgY3JlYXRlZEFmdGVyID0gY2hlY2twb2ludD8uY3JlYXRlZF9hZnRlciA/PyAnJztcbiAgICBjb25zdCBmaWx0ZXJQYXJhbSA9IGNyZWF0ZWRBZnRlciA/IGAmZmlsdGVyPWNyZWF0aW9uZGF0ZTpbJHtjcmVhdGVkQWZ0ZXJ9Li5dYCA6ICcnO1xuICAgIGxldCBjdXJzb3I6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICBsZXQgbGF0ZXN0RGF0ZSA9IGNyZWF0ZWRBZnRlcjtcbiAgICBsZXQgZmV0Y2hlZCA9IDA7XG4gICAgZG8ge1xuICAgICAgY29uc3Qgb2Zmc2V0UGFyYW0gPSBjdXJzb3IgPyBgJm9mZnNldD0ke2N1cnNvcn1gIDogJyc7XG4gICAgICBjb25zdCByZXMgPSBhd2FpdCBuYW5nby5nZXQ8T3JkZXJzUmVzcG9uc2U+KHtcbiAgICAgICAgZW5kcG9pbnQ6IGAvc2VsbC9mdWxmaWxsbWVudC92MS9vcmRlcj9saW1pdD0ke0xJTUlUfSR7ZmlsdGVyUGFyYW19JHtvZmZzZXRQYXJhbX1gLFxuICAgICAgICByZXRyaWVzOiAzXG4gICAgICB9KTtcbiAgICAgIGNvbnN0IG9yZGVycyA9IHJlcy5kYXRhLm9yZGVycyA/PyBbXTtcbiAgICAgIGNvbnN0IHJlY29yZHM6IEViYXlPcmRlcltdID0gb3JkZXJzLm1hcChvID0+ICh7XG4gICAgICAgIGlkOiBvLm9yZGVySWQsXG4gICAgICAgIG9yZGVySWQ6IG8ub3JkZXJJZCxcbiAgICAgICAgbGVnYWN5T3JkZXJJZDogby5sZWdhY3lPcmRlcklkID8/IG51bGwsXG4gICAgICAgIGNyZWF0aW9uRGF0ZTogby5jcmVhdGlvbkRhdGUsXG4gICAgICAgIGxhc3RNb2RpZmllZERhdGU6IG8ubGFzdE1vZGlmaWVkRGF0ZSxcbiAgICAgICAgb3JkZXJGdWxmaWxsbWVudFN0YXR1czogby5vcmRlckZ1bGZpbGxtZW50U3RhdHVzLFxuICAgICAgICBvcmRlclBheW1lbnRTdGF0dXM6IG8ub3JkZXJQYXltZW50U3RhdHVzID8/IG51bGwsXG4gICAgICAgIHByaWNpbmdTdW1tYXJ5OiBvLnByaWNpbmdTdW1tYXJ5ID8/IG51bGxcbiAgICAgIH0pKTtcbiAgICAgIGlmIChyZWNvcmRzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgYXdhaXQgbmFuZ28uYmF0Y2hTYXZlKHJlY29yZHMsICdFYmF5T3JkZXInKTtcbiAgICAgICAgY29uc3QgbGFzdCA9IHJlY29yZHNbcmVjb3Jkcy5sZW5ndGggLSAxXTtcbiAgICAgICAgaWYgKGxhc3QgJiYgbGFzdC5jcmVhdGlvbkRhdGUgPiBsYXRlc3REYXRlKSB7XG4gICAgICAgICAgbGF0ZXN0RGF0ZSA9IGxhc3QuY3JlYXRpb25EYXRlO1xuICAgICAgICAgIGF3YWl0IG5hbmdvLnNhdmVDaGVja3BvaW50KHtcbiAgICAgICAgICAgIGNyZWF0ZWRfYWZ0ZXI6IGxhdGVzdERhdGVcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgZmV0Y2hlZCArPSBvcmRlcnMubGVuZ3RoO1xuICAgICAgY3Vyc29yID0gcmVzLmRhdGEubmV4dCA/IFN0cmluZyhmZXRjaGVkKSA6IHVuZGVmaW5lZDtcbiAgICB9IHdoaWxlIChjdXJzb3IpO1xuICB9XG59O1xuZXhwb3J0IHR5cGUgTmFuZ29TeW5jTG9jYWwgPSBQYXJhbWV0ZXJzPCh0eXBlb2Ygc3luYylbJ2V4ZWMnXT5bMF07XG5leHBvcnQgZGVmYXVsdCBzeW5jOyJdLAogICJtYXBwaW5ncyI6ICI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUNBLGlCQUFrQjtBQUNsQixJQUFNLG1CQUFtQixhQUFFLE9BQU87QUFBQSxFQUNoQyxlQUFlLGFBQUUsT0FBTztBQUMxQixDQUFDO0FBQ0QsSUFBTSxjQUFjLGFBQUUsT0FBTztBQUFBLEVBQzNCLE9BQU8sYUFBRSxPQUFPO0FBQUEsRUFDaEIsVUFBVSxhQUFFLE9BQU87QUFDckIsQ0FBQztBQUNELElBQU0sa0JBQWtCLGFBQUUsT0FBTztBQUFBLEVBQy9CLElBQUksYUFBRSxPQUFPO0FBQUEsRUFDYixTQUFTLGFBQUUsT0FBTztBQUFBLEVBQ2xCLGVBQWUsYUFBRSxPQUFPLEVBQUUsU0FBUyxFQUFFLFNBQVM7QUFBQSxFQUM5QyxjQUFjLGFBQUUsT0FBTztBQUFBLEVBQ3ZCLGtCQUFrQixhQUFFLE9BQU87QUFBQSxFQUMzQix3QkFBd0IsYUFBRSxPQUFPO0FBQUEsRUFDakMsb0JBQW9CLGFBQUUsT0FBTyxFQUFFLFNBQVMsRUFBRSxTQUFTO0FBQUEsRUFDbkQsZ0JBQWdCLGFBQUUsT0FBTztBQUFBLElBQ3ZCLE9BQU87QUFBQSxFQUNULENBQUMsRUFBRSxTQUFTLEVBQUUsU0FBUztBQUN6QixDQUFDO0FBcUJELElBQU0sUUFBUTtBQUNkLElBQU0sT0FBTztBQUFBLEVBQ1gsTUFBTTtBQUFBLEVBQ04sYUFBYTtBQUFBLEVBQ2IsU0FBUztBQUFBLEVBQ1QsV0FBVztBQUFBLEVBQ1gsV0FBVztBQUFBLEVBQ1gsWUFBWTtBQUFBLEVBQ1osUUFBUTtBQUFBLElBQ04sV0FBVztBQUFBLEVBQ2I7QUFBQSxFQUNBLE1BQU0sT0FBTSxVQUFTO0FBQ25CLFVBQU0sYUFBYSxNQUFNLE1BQU0sY0FBYztBQUM3QyxVQUFNLGVBQWUsWUFBWSxpQkFBaUI7QUFDbEQsVUFBTSxjQUFjLGVBQWUseUJBQXlCLFlBQVksUUFBUTtBQUNoRixRQUFJO0FBQ0osUUFBSSxhQUFhO0FBQ2pCLFFBQUksVUFBVTtBQUNkLE9BQUc7QUFDRCxZQUFNLGNBQWMsU0FBUyxXQUFXLE1BQU0sS0FBSztBQUNuRCxZQUFNLE1BQU0sTUFBTSxNQUFNLElBQW9CO0FBQUEsUUFDMUMsVUFBVSxvQ0FBb0MsS0FBSyxHQUFHLFdBQVcsR0FBRyxXQUFXO0FBQUEsUUFDL0UsU0FBUztBQUFBLE1BQ1gsQ0FBQztBQUNELFlBQU0sU0FBUyxJQUFJLEtBQUssVUFBVSxDQUFDO0FBQ25DLFlBQU0sVUFBdUIsT0FBTyxJQUFJLFFBQU07QUFBQSxRQUM1QyxJQUFJLEVBQUU7QUFBQSxRQUNOLFNBQVMsRUFBRTtBQUFBLFFBQ1gsZUFBZSxFQUFFLGlCQUFpQjtBQUFBLFFBQ2xDLGNBQWMsRUFBRTtBQUFBLFFBQ2hCLGtCQUFrQixFQUFFO0FBQUEsUUFDcEIsd0JBQXdCLEVBQUU7QUFBQSxRQUMxQixvQkFBb0IsRUFBRSxzQkFBc0I7QUFBQSxRQUM1QyxnQkFBZ0IsRUFBRSxrQkFBa0I7QUFBQSxNQUN0QyxFQUFFO0FBQ0YsVUFBSSxRQUFRLFNBQVMsR0FBRztBQUN0QixjQUFNLE1BQU0sVUFBVSxTQUFTLFdBQVc7QUFDMUMsY0FBTSxPQUFPLFFBQVEsUUFBUSxTQUFTLENBQUM7QUFDdkMsWUFBSSxRQUFRLEtBQUssZUFBZSxZQUFZO0FBQzFDLHVCQUFhLEtBQUs7QUFDbEIsZ0JBQU0sTUFBTSxlQUFlO0FBQUEsWUFDekIsZUFBZTtBQUFBLFVBQ2pCLENBQUM7QUFBQSxRQUNIO0FBQUEsTUFDRjtBQUNBLGlCQUFXLE9BQU87QUFDbEIsZUFBUyxJQUFJLEtBQUssT0FBTyxPQUFPLE9BQU8sSUFBSTtBQUFBLElBQzdDLFNBQVM7QUFBQSxFQUNYO0FBQ0Y7QUFFQSxJQUFPLHNCQUFROyIsCiAgIm5hbWVzIjogW10KfQo=
