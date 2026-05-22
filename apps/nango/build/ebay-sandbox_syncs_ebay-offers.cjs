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

// ebay-sandbox/syncs/ebay-offers.ts
var ebay_offers_exports = {};
__export(ebay_offers_exports, {
  default: () => ebay_offers_default
});
module.exports = __toCommonJS(ebay_offers_exports);
var import_zod = require("zod");
var CheckpointSchema = import_zod.z.object({
  fully_synced: import_zod.z.string()
});
var EbayOfferSchema = import_zod.z.object({
  id: import_zod.z.string(),
  offerId: import_zod.z.string(),
  sku: import_zod.z.string(),
  marketplaceId: import_zod.z.string(),
  format: import_zod.z.string().nullable().optional(),
  availableQuantity: import_zod.z.number().nullable().optional(),
  status: import_zod.z.string(),
  listingId: import_zod.z.string().nullable().optional(),
  pricingSummary: import_zod.z.object({
    price: import_zod.z.object({
      value: import_zod.z.string(),
      currency: import_zod.z.string()
    })
  }).nullable().optional()
});
var LIMIT = 100;
var sync = {
  type: "sync",
  description: "Pulls eBay offers via Sell Inventory API v1 with offset pagination",
  version: "1.0.0",
  frequency: "every 6 hours",
  autoStart: true,
  checkpoint: CheckpointSchema,
  models: {
    EbayOffer: EbayOfferSchema
  },
  exec: async (nango) => {
    let offset = 0;
    let total = Infinity;
    while (offset < total) {
      const res = await nango.get({
        endpoint: `/sell/inventory/v1/offer?limit=${LIMIT}&offset=${offset}`,
        retries: 3
      });
      const offers = res.data.offers ?? [];
      total = res.data.total ?? 0;
      const records = offers.map((o) => ({
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
        await nango.batchSave(records, "EbayOffer");
      }
      offset += LIMIT;
      if (offers.length < LIMIT) break;
    }
    await nango.saveCheckpoint({
      fully_synced: "true"
    });
  }
};
var ebay_offers_default = sync;
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiZWJheS1zYW5kYm94L3N5bmNzL2ViYXktb2ZmZXJzLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgeyBjcmVhdGVTeW5jIH0gZnJvbSAnbmFuZ28nO1xuaW1wb3J0IHsgeiB9IGZyb20gJ3pvZCc7XG5jb25zdCBDaGVja3BvaW50U2NoZW1hID0gei5vYmplY3Qoe1xuICBmdWxseV9zeW5jZWQ6IHouc3RyaW5nKClcbn0pO1xuY29uc3QgRWJheU9mZmVyU2NoZW1hID0gei5vYmplY3Qoe1xuICBpZDogei5zdHJpbmcoKSxcbiAgb2ZmZXJJZDogei5zdHJpbmcoKSxcbiAgc2t1OiB6LnN0cmluZygpLFxuICBtYXJrZXRwbGFjZUlkOiB6LnN0cmluZygpLFxuICBmb3JtYXQ6IHouc3RyaW5nKCkubnVsbGFibGUoKS5vcHRpb25hbCgpLFxuICBhdmFpbGFibGVRdWFudGl0eTogei5udW1iZXIoKS5udWxsYWJsZSgpLm9wdGlvbmFsKCksXG4gIHN0YXR1czogei5zdHJpbmcoKSxcbiAgbGlzdGluZ0lkOiB6LnN0cmluZygpLm51bGxhYmxlKCkub3B0aW9uYWwoKSxcbiAgcHJpY2luZ1N1bW1hcnk6IHoub2JqZWN0KHtcbiAgICBwcmljZTogei5vYmplY3Qoe1xuICAgICAgdmFsdWU6IHouc3RyaW5nKCksXG4gICAgICBjdXJyZW5jeTogei5zdHJpbmcoKVxuICAgIH0pXG4gIH0pLm51bGxhYmxlKCkub3B0aW9uYWwoKVxufSk7XG50eXBlIEViYXlPZmZlciA9IHouaW5mZXI8dHlwZW9mIEViYXlPZmZlclNjaGVtYT47XG5pbnRlcmZhY2UgT2ZmZXJzUmVzcG9uc2Uge1xuICBvZmZlcnM/OiBBcnJheTx7XG4gICAgb2ZmZXJJZDogc3RyaW5nO1xuICAgIHNrdTogc3RyaW5nO1xuICAgIG1hcmtldHBsYWNlSWQ6IHN0cmluZztcbiAgICBmb3JtYXQ/OiBzdHJpbmc7XG4gICAgYXZhaWxhYmxlUXVhbnRpdHk/OiBudW1iZXI7XG4gICAgc3RhdHVzOiBzdHJpbmc7XG4gICAgbGlzdGluZ0lkPzogc3RyaW5nO1xuICAgIHByaWNpbmdTdW1tYXJ5Pzoge1xuICAgICAgcHJpY2U6IHtcbiAgICAgICAgdmFsdWU6IHN0cmluZztcbiAgICAgICAgY3VycmVuY3k6IHN0cmluZztcbiAgICAgIH07XG4gICAgfTtcbiAgICBbazogc3RyaW5nXTogdW5rbm93bjtcbiAgfT47XG4gIHRvdGFsPzogbnVtYmVyO1xufVxuY29uc3QgTElNSVQgPSAxMDA7XG5jb25zdCBzeW5jID0ge1xuICB0eXBlOiBcInN5bmNcIixcbiAgZGVzY3JpcHRpb246ICdQdWxscyBlQmF5IG9mZmVycyB2aWEgU2VsbCBJbnZlbnRvcnkgQVBJIHYxIHdpdGggb2Zmc2V0IHBhZ2luYXRpb24nLFxuICB2ZXJzaW9uOiAnMS4wLjAnLFxuICBmcmVxdWVuY3k6ICdldmVyeSA2IGhvdXJzJyxcbiAgYXV0b1N0YXJ0OiB0cnVlLFxuICBjaGVja3BvaW50OiBDaGVja3BvaW50U2NoZW1hLFxuICBtb2RlbHM6IHtcbiAgICBFYmF5T2ZmZXI6IEViYXlPZmZlclNjaGVtYVxuICB9LFxuICBleGVjOiBhc3luYyBuYW5nbyA9PiB7XG4gICAgbGV0IG9mZnNldCA9IDA7XG4gICAgbGV0IHRvdGFsID0gSW5maW5pdHk7XG4gICAgd2hpbGUgKG9mZnNldCA8IHRvdGFsKSB7XG4gICAgICBjb25zdCByZXMgPSBhd2FpdCBuYW5nby5nZXQ8T2ZmZXJzUmVzcG9uc2U+KHtcbiAgICAgICAgZW5kcG9pbnQ6IGAvc2VsbC9pbnZlbnRvcnkvdjEvb2ZmZXI/bGltaXQ9JHtMSU1JVH0mb2Zmc2V0PSR7b2Zmc2V0fWAsXG4gICAgICAgIHJldHJpZXM6IDNcbiAgICAgIH0pO1xuICAgICAgY29uc3Qgb2ZmZXJzID0gcmVzLmRhdGEub2ZmZXJzID8/IFtdO1xuICAgICAgdG90YWwgPSByZXMuZGF0YS50b3RhbCA/PyAwO1xuICAgICAgY29uc3QgcmVjb3JkczogRWJheU9mZmVyW10gPSBvZmZlcnMubWFwKG8gPT4gKHtcbiAgICAgICAgaWQ6IG8ub2ZmZXJJZCxcbiAgICAgICAgb2ZmZXJJZDogby5vZmZlcklkLFxuICAgICAgICBza3U6IG8uc2t1LFxuICAgICAgICBtYXJrZXRwbGFjZUlkOiBvLm1hcmtldHBsYWNlSWQsXG4gICAgICAgIGZvcm1hdDogby5mb3JtYXQgPz8gbnVsbCxcbiAgICAgICAgYXZhaWxhYmxlUXVhbnRpdHk6IG8uYXZhaWxhYmxlUXVhbnRpdHkgPz8gbnVsbCxcbiAgICAgICAgc3RhdHVzOiBvLnN0YXR1cyxcbiAgICAgICAgbGlzdGluZ0lkOiBvLmxpc3RpbmdJZCA/PyBudWxsLFxuICAgICAgICBwcmljaW5nU3VtbWFyeTogby5wcmljaW5nU3VtbWFyeSA/PyBudWxsXG4gICAgICB9KSk7XG4gICAgICBpZiAocmVjb3Jkcy5sZW5ndGggPiAwKSB7XG4gICAgICAgIGF3YWl0IG5hbmdvLmJhdGNoU2F2ZShyZWNvcmRzLCAnRWJheU9mZmVyJyk7XG4gICAgICB9XG4gICAgICBvZmZzZXQgKz0gTElNSVQ7XG4gICAgICBpZiAob2ZmZXJzLmxlbmd0aCA8IExJTUlUKSBicmVhaztcbiAgICB9XG4gICAgYXdhaXQgbmFuZ28uc2F2ZUNoZWNrcG9pbnQoe1xuICAgICAgZnVsbHlfc3luY2VkOiAndHJ1ZSdcbiAgICB9KTtcbiAgfVxufTtcbmV4cG9ydCB0eXBlIE5hbmdvU3luY0xvY2FsID0gUGFyYW1ldGVyczwodHlwZW9mIHN5bmMpWydleGVjJ10+WzBdO1xuZXhwb3J0IGRlZmF1bHQgc3luYzsiXSwKICAibWFwcGluZ3MiOiAiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFDQSxpQkFBa0I7QUFDbEIsSUFBTSxtQkFBbUIsYUFBRSxPQUFPO0FBQUEsRUFDaEMsY0FBYyxhQUFFLE9BQU87QUFDekIsQ0FBQztBQUNELElBQU0sa0JBQWtCLGFBQUUsT0FBTztBQUFBLEVBQy9CLElBQUksYUFBRSxPQUFPO0FBQUEsRUFDYixTQUFTLGFBQUUsT0FBTztBQUFBLEVBQ2xCLEtBQUssYUFBRSxPQUFPO0FBQUEsRUFDZCxlQUFlLGFBQUUsT0FBTztBQUFBLEVBQ3hCLFFBQVEsYUFBRSxPQUFPLEVBQUUsU0FBUyxFQUFFLFNBQVM7QUFBQSxFQUN2QyxtQkFBbUIsYUFBRSxPQUFPLEVBQUUsU0FBUyxFQUFFLFNBQVM7QUFBQSxFQUNsRCxRQUFRLGFBQUUsT0FBTztBQUFBLEVBQ2pCLFdBQVcsYUFBRSxPQUFPLEVBQUUsU0FBUyxFQUFFLFNBQVM7QUFBQSxFQUMxQyxnQkFBZ0IsYUFBRSxPQUFPO0FBQUEsSUFDdkIsT0FBTyxhQUFFLE9BQU87QUFBQSxNQUNkLE9BQU8sYUFBRSxPQUFPO0FBQUEsTUFDaEIsVUFBVSxhQUFFLE9BQU87QUFBQSxJQUNyQixDQUFDO0FBQUEsRUFDSCxDQUFDLEVBQUUsU0FBUyxFQUFFLFNBQVM7QUFDekIsQ0FBQztBQXFCRCxJQUFNLFFBQVE7QUFDZCxJQUFNLE9BQU87QUFBQSxFQUNYLE1BQU07QUFBQSxFQUNOLGFBQWE7QUFBQSxFQUNiLFNBQVM7QUFBQSxFQUNULFdBQVc7QUFBQSxFQUNYLFdBQVc7QUFBQSxFQUNYLFlBQVk7QUFBQSxFQUNaLFFBQVE7QUFBQSxJQUNOLFdBQVc7QUFBQSxFQUNiO0FBQUEsRUFDQSxNQUFNLE9BQU0sVUFBUztBQUNuQixRQUFJLFNBQVM7QUFDYixRQUFJLFFBQVE7QUFDWixXQUFPLFNBQVMsT0FBTztBQUNyQixZQUFNLE1BQU0sTUFBTSxNQUFNLElBQW9CO0FBQUEsUUFDMUMsVUFBVSxrQ0FBa0MsS0FBSyxXQUFXLE1BQU07QUFBQSxRQUNsRSxTQUFTO0FBQUEsTUFDWCxDQUFDO0FBQ0QsWUFBTSxTQUFTLElBQUksS0FBSyxVQUFVLENBQUM7QUFDbkMsY0FBUSxJQUFJLEtBQUssU0FBUztBQUMxQixZQUFNLFVBQXVCLE9BQU8sSUFBSSxRQUFNO0FBQUEsUUFDNUMsSUFBSSxFQUFFO0FBQUEsUUFDTixTQUFTLEVBQUU7QUFBQSxRQUNYLEtBQUssRUFBRTtBQUFBLFFBQ1AsZUFBZSxFQUFFO0FBQUEsUUFDakIsUUFBUSxFQUFFLFVBQVU7QUFBQSxRQUNwQixtQkFBbUIsRUFBRSxxQkFBcUI7QUFBQSxRQUMxQyxRQUFRLEVBQUU7QUFBQSxRQUNWLFdBQVcsRUFBRSxhQUFhO0FBQUEsUUFDMUIsZ0JBQWdCLEVBQUUsa0JBQWtCO0FBQUEsTUFDdEMsRUFBRTtBQUNGLFVBQUksUUFBUSxTQUFTLEdBQUc7QUFDdEIsY0FBTSxNQUFNLFVBQVUsU0FBUyxXQUFXO0FBQUEsTUFDNUM7QUFDQSxnQkFBVTtBQUNWLFVBQUksT0FBTyxTQUFTLE1BQU87QUFBQSxJQUM3QjtBQUNBLFVBQU0sTUFBTSxlQUFlO0FBQUEsTUFDekIsY0FBYztBQUFBLElBQ2hCLENBQUM7QUFBQSxFQUNIO0FBQ0Y7QUFFQSxJQUFPLHNCQUFROyIsCiAgIm5hbWVzIjogW10KfQo=
