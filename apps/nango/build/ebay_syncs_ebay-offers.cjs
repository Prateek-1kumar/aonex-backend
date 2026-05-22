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

// ebay/syncs/ebay-offers.ts
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiZWJheS9zeW5jcy9lYmF5LW9mZmVycy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgY3JlYXRlU3luYyB9IGZyb20gJ25hbmdvJztcbmltcG9ydCB7IHogfSBmcm9tICd6b2QnO1xuY29uc3QgQ2hlY2twb2ludFNjaGVtYSA9IHoub2JqZWN0KHtcbiAgZnVsbHlfc3luY2VkOiB6LnN0cmluZygpXG59KTtcbmNvbnN0IEViYXlPZmZlclNjaGVtYSA9IHoub2JqZWN0KHtcbiAgaWQ6IHouc3RyaW5nKCksXG4gIG9mZmVySWQ6IHouc3RyaW5nKCksXG4gIHNrdTogei5zdHJpbmcoKSxcbiAgbWFya2V0cGxhY2VJZDogei5zdHJpbmcoKSxcbiAgZm9ybWF0OiB6LnN0cmluZygpLm51bGxhYmxlKCkub3B0aW9uYWwoKSxcbiAgYXZhaWxhYmxlUXVhbnRpdHk6IHoubnVtYmVyKCkubnVsbGFibGUoKS5vcHRpb25hbCgpLFxuICBzdGF0dXM6IHouc3RyaW5nKCksXG4gIGxpc3RpbmdJZDogei5zdHJpbmcoKS5udWxsYWJsZSgpLm9wdGlvbmFsKCksXG4gIHByaWNpbmdTdW1tYXJ5OiB6Lm9iamVjdCh7XG4gICAgcHJpY2U6IHoub2JqZWN0KHtcbiAgICAgIHZhbHVlOiB6LnN0cmluZygpLFxuICAgICAgY3VycmVuY3k6IHouc3RyaW5nKClcbiAgICB9KVxuICB9KS5udWxsYWJsZSgpLm9wdGlvbmFsKClcbn0pO1xudHlwZSBFYmF5T2ZmZXIgPSB6LmluZmVyPHR5cGVvZiBFYmF5T2ZmZXJTY2hlbWE+O1xuaW50ZXJmYWNlIE9mZmVyc1Jlc3BvbnNlIHtcbiAgb2ZmZXJzPzogQXJyYXk8e1xuICAgIG9mZmVySWQ6IHN0cmluZztcbiAgICBza3U6IHN0cmluZztcbiAgICBtYXJrZXRwbGFjZUlkOiBzdHJpbmc7XG4gICAgZm9ybWF0Pzogc3RyaW5nO1xuICAgIGF2YWlsYWJsZVF1YW50aXR5PzogbnVtYmVyO1xuICAgIHN0YXR1czogc3RyaW5nO1xuICAgIGxpc3RpbmdJZD86IHN0cmluZztcbiAgICBwcmljaW5nU3VtbWFyeT86IHtcbiAgICAgIHByaWNlOiB7XG4gICAgICAgIHZhbHVlOiBzdHJpbmc7XG4gICAgICAgIGN1cnJlbmN5OiBzdHJpbmc7XG4gICAgICB9O1xuICAgIH07XG4gICAgW2s6IHN0cmluZ106IHVua25vd247XG4gIH0+O1xuICB0b3RhbD86IG51bWJlcjtcbn1cbmNvbnN0IExJTUlUID0gMTAwO1xuY29uc3Qgc3luYyA9IHtcbiAgdHlwZTogXCJzeW5jXCIsXG4gIGRlc2NyaXB0aW9uOiAnUHVsbHMgZUJheSBvZmZlcnMgdmlhIFNlbGwgSW52ZW50b3J5IEFQSSB2MSB3aXRoIG9mZnNldCBwYWdpbmF0aW9uJyxcbiAgdmVyc2lvbjogJzEuMC4wJyxcbiAgZnJlcXVlbmN5OiAnZXZlcnkgNiBob3VycycsXG4gIGF1dG9TdGFydDogdHJ1ZSxcbiAgY2hlY2twb2ludDogQ2hlY2twb2ludFNjaGVtYSxcbiAgbW9kZWxzOiB7XG4gICAgRWJheU9mZmVyOiBFYmF5T2ZmZXJTY2hlbWFcbiAgfSxcbiAgZXhlYzogYXN5bmMgbmFuZ28gPT4ge1xuICAgIGxldCBvZmZzZXQgPSAwO1xuICAgIGxldCB0b3RhbCA9IEluZmluaXR5O1xuICAgIHdoaWxlIChvZmZzZXQgPCB0b3RhbCkge1xuICAgICAgY29uc3QgcmVzID0gYXdhaXQgbmFuZ28uZ2V0PE9mZmVyc1Jlc3BvbnNlPih7XG4gICAgICAgIGVuZHBvaW50OiBgL3NlbGwvaW52ZW50b3J5L3YxL29mZmVyP2xpbWl0PSR7TElNSVR9Jm9mZnNldD0ke29mZnNldH1gLFxuICAgICAgICByZXRyaWVzOiAzXG4gICAgICB9KTtcbiAgICAgIGNvbnN0IG9mZmVycyA9IHJlcy5kYXRhLm9mZmVycyA/PyBbXTtcbiAgICAgIHRvdGFsID0gcmVzLmRhdGEudG90YWwgPz8gMDtcbiAgICAgIGNvbnN0IHJlY29yZHM6IEViYXlPZmZlcltdID0gb2ZmZXJzLm1hcChvID0+ICh7XG4gICAgICAgIGlkOiBvLm9mZmVySWQsXG4gICAgICAgIG9mZmVySWQ6IG8ub2ZmZXJJZCxcbiAgICAgICAgc2t1OiBvLnNrdSxcbiAgICAgICAgbWFya2V0cGxhY2VJZDogby5tYXJrZXRwbGFjZUlkLFxuICAgICAgICBmb3JtYXQ6IG8uZm9ybWF0ID8/IG51bGwsXG4gICAgICAgIGF2YWlsYWJsZVF1YW50aXR5OiBvLmF2YWlsYWJsZVF1YW50aXR5ID8/IG51bGwsXG4gICAgICAgIHN0YXR1czogby5zdGF0dXMsXG4gICAgICAgIGxpc3RpbmdJZDogby5saXN0aW5nSWQgPz8gbnVsbCxcbiAgICAgICAgcHJpY2luZ1N1bW1hcnk6IG8ucHJpY2luZ1N1bW1hcnkgPz8gbnVsbFxuICAgICAgfSkpO1xuICAgICAgaWYgKHJlY29yZHMubGVuZ3RoID4gMCkge1xuICAgICAgICBhd2FpdCBuYW5nby5iYXRjaFNhdmUocmVjb3JkcywgJ0ViYXlPZmZlcicpO1xuICAgICAgfVxuICAgICAgb2Zmc2V0ICs9IExJTUlUO1xuICAgICAgaWYgKG9mZmVycy5sZW5ndGggPCBMSU1JVCkgYnJlYWs7XG4gICAgfVxuICAgIGF3YWl0IG5hbmdvLnNhdmVDaGVja3BvaW50KHtcbiAgICAgIGZ1bGx5X3N5bmNlZDogJ3RydWUnXG4gICAgfSk7XG4gIH1cbn07XG5leHBvcnQgdHlwZSBOYW5nb1N5bmNMb2NhbCA9IFBhcmFtZXRlcnM8KHR5cGVvZiBzeW5jKVsnZXhlYyddPlswXTtcbmV4cG9ydCBkZWZhdWx0IHN5bmM7Il0sCiAgIm1hcHBpbmdzIjogIjs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQ0EsaUJBQWtCO0FBQ2xCLElBQU0sbUJBQW1CLGFBQUUsT0FBTztBQUFBLEVBQ2hDLGNBQWMsYUFBRSxPQUFPO0FBQ3pCLENBQUM7QUFDRCxJQUFNLGtCQUFrQixhQUFFLE9BQU87QUFBQSxFQUMvQixJQUFJLGFBQUUsT0FBTztBQUFBLEVBQ2IsU0FBUyxhQUFFLE9BQU87QUFBQSxFQUNsQixLQUFLLGFBQUUsT0FBTztBQUFBLEVBQ2QsZUFBZSxhQUFFLE9BQU87QUFBQSxFQUN4QixRQUFRLGFBQUUsT0FBTyxFQUFFLFNBQVMsRUFBRSxTQUFTO0FBQUEsRUFDdkMsbUJBQW1CLGFBQUUsT0FBTyxFQUFFLFNBQVMsRUFBRSxTQUFTO0FBQUEsRUFDbEQsUUFBUSxhQUFFLE9BQU87QUFBQSxFQUNqQixXQUFXLGFBQUUsT0FBTyxFQUFFLFNBQVMsRUFBRSxTQUFTO0FBQUEsRUFDMUMsZ0JBQWdCLGFBQUUsT0FBTztBQUFBLElBQ3ZCLE9BQU8sYUFBRSxPQUFPO0FBQUEsTUFDZCxPQUFPLGFBQUUsT0FBTztBQUFBLE1BQ2hCLFVBQVUsYUFBRSxPQUFPO0FBQUEsSUFDckIsQ0FBQztBQUFBLEVBQ0gsQ0FBQyxFQUFFLFNBQVMsRUFBRSxTQUFTO0FBQ3pCLENBQUM7QUFxQkQsSUFBTSxRQUFRO0FBQ2QsSUFBTSxPQUFPO0FBQUEsRUFDWCxNQUFNO0FBQUEsRUFDTixhQUFhO0FBQUEsRUFDYixTQUFTO0FBQUEsRUFDVCxXQUFXO0FBQUEsRUFDWCxXQUFXO0FBQUEsRUFDWCxZQUFZO0FBQUEsRUFDWixRQUFRO0FBQUEsSUFDTixXQUFXO0FBQUEsRUFDYjtBQUFBLEVBQ0EsTUFBTSxPQUFNLFVBQVM7QUFDbkIsUUFBSSxTQUFTO0FBQ2IsUUFBSSxRQUFRO0FBQ1osV0FBTyxTQUFTLE9BQU87QUFDckIsWUFBTSxNQUFNLE1BQU0sTUFBTSxJQUFvQjtBQUFBLFFBQzFDLFVBQVUsa0NBQWtDLEtBQUssV0FBVyxNQUFNO0FBQUEsUUFDbEUsU0FBUztBQUFBLE1BQ1gsQ0FBQztBQUNELFlBQU0sU0FBUyxJQUFJLEtBQUssVUFBVSxDQUFDO0FBQ25DLGNBQVEsSUFBSSxLQUFLLFNBQVM7QUFDMUIsWUFBTSxVQUF1QixPQUFPLElBQUksUUFBTTtBQUFBLFFBQzVDLElBQUksRUFBRTtBQUFBLFFBQ04sU0FBUyxFQUFFO0FBQUEsUUFDWCxLQUFLLEVBQUU7QUFBQSxRQUNQLGVBQWUsRUFBRTtBQUFBLFFBQ2pCLFFBQVEsRUFBRSxVQUFVO0FBQUEsUUFDcEIsbUJBQW1CLEVBQUUscUJBQXFCO0FBQUEsUUFDMUMsUUFBUSxFQUFFO0FBQUEsUUFDVixXQUFXLEVBQUUsYUFBYTtBQUFBLFFBQzFCLGdCQUFnQixFQUFFLGtCQUFrQjtBQUFBLE1BQ3RDLEVBQUU7QUFDRixVQUFJLFFBQVEsU0FBUyxHQUFHO0FBQ3RCLGNBQU0sTUFBTSxVQUFVLFNBQVMsV0FBVztBQUFBLE1BQzVDO0FBQ0EsZ0JBQVU7QUFDVixVQUFJLE9BQU8sU0FBUyxNQUFPO0FBQUEsSUFDN0I7QUFDQSxVQUFNLE1BQU0sZUFBZTtBQUFBLE1BQ3pCLGNBQWM7QUFBQSxJQUNoQixDQUFDO0FBQUEsRUFDSDtBQUNGO0FBRUEsSUFBTyxzQkFBUTsiLAogICJuYW1lcyI6IFtdCn0K
