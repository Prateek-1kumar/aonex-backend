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

// ebay/syncs/ebay-inventory-items.ts
var ebay_inventory_items_exports = {};
__export(ebay_inventory_items_exports, {
  default: () => ebay_inventory_items_default
});
module.exports = __toCommonJS(ebay_inventory_items_exports);
var import_zod = require("zod");
var CheckpointSchema = import_zod.z.object({
  fully_synced: import_zod.z.string()
});
var EbayInventoryItemSchema = import_zod.z.object({
  id: import_zod.z.string(),
  sku: import_zod.z.string(),
  condition: import_zod.z.string().nullable().optional(),
  locale: import_zod.z.string().nullable().optional(),
  availability: import_zod.z.object({
    shipToLocationAvailability: import_zod.z.object({
      quantity: import_zod.z.number()
    }).optional()
  }).nullable().optional(),
  product: import_zod.z.object({
    title: import_zod.z.string().optional(),
    description: import_zod.z.string().optional()
  }).nullable().optional()
});
var LIMIT = 100;
var sync = {
  type: "sync",
  description: "Pulls eBay inventory items via Sell Inventory API v1 with offset pagination",
  version: "1.0.0",
  frequency: "every 6 hours",
  autoStart: true,
  checkpoint: CheckpointSchema,
  models: {
    EbayInventoryItem: EbayInventoryItemSchema
  },
  exec: async (nango) => {
    let offset = 0;
    let total = Infinity;
    while (offset < total) {
      const res = await nango.get({
        endpoint: `/sell/inventory/v1/inventory_item?limit=${LIMIT}&offset=${offset}`,
        retries: 3
      });
      const items = res.data.inventoryItems ?? [];
      total = res.data.total ?? 0;
      const records = items.map((item) => ({
        id: item.sku,
        sku: item.sku,
        condition: item["condition"] ?? null,
        locale: item["locale"] ?? null,
        availability: item["availability"] ?? null,
        product: item["product"] ?? null
      }));
      if (records.length > 0) {
        await nango.batchSave(records, "EbayInventoryItem");
      }
      offset += LIMIT;
      if (items.length < LIMIT) break;
    }
    await nango.saveCheckpoint({
      fully_synced: "true"
    });
  }
};
var ebay_inventory_items_default = sync;
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiZWJheS9zeW5jcy9lYmF5LWludmVudG9yeS1pdGVtcy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgY3JlYXRlU3luYyB9IGZyb20gJ25hbmdvJztcbmltcG9ydCB7IHogfSBmcm9tICd6b2QnO1xuY29uc3QgQ2hlY2twb2ludFNjaGVtYSA9IHoub2JqZWN0KHtcbiAgZnVsbHlfc3luY2VkOiB6LnN0cmluZygpXG59KTtcbmNvbnN0IEViYXlJbnZlbnRvcnlJdGVtU2NoZW1hID0gei5vYmplY3Qoe1xuICBpZDogei5zdHJpbmcoKSxcbiAgc2t1OiB6LnN0cmluZygpLFxuICBjb25kaXRpb246IHouc3RyaW5nKCkubnVsbGFibGUoKS5vcHRpb25hbCgpLFxuICBsb2NhbGU6IHouc3RyaW5nKCkubnVsbGFibGUoKS5vcHRpb25hbCgpLFxuICBhdmFpbGFiaWxpdHk6IHoub2JqZWN0KHtcbiAgICBzaGlwVG9Mb2NhdGlvbkF2YWlsYWJpbGl0eTogei5vYmplY3Qoe1xuICAgICAgcXVhbnRpdHk6IHoubnVtYmVyKClcbiAgICB9KS5vcHRpb25hbCgpXG4gIH0pLm51bGxhYmxlKCkub3B0aW9uYWwoKSxcbiAgcHJvZHVjdDogei5vYmplY3Qoe1xuICAgIHRpdGxlOiB6LnN0cmluZygpLm9wdGlvbmFsKCksXG4gICAgZGVzY3JpcHRpb246IHouc3RyaW5nKCkub3B0aW9uYWwoKVxuICB9KS5udWxsYWJsZSgpLm9wdGlvbmFsKClcbn0pO1xudHlwZSBFYmF5SW52ZW50b3J5SXRlbSA9IHouaW5mZXI8dHlwZW9mIEViYXlJbnZlbnRvcnlJdGVtU2NoZW1hPjtcbmludGVyZmFjZSBJbnZlbnRvcnlJdGVtc1Jlc3BvbnNlIHtcbiAgaW52ZW50b3J5SXRlbXM/OiBBcnJheTx7XG4gICAgc2t1OiBzdHJpbmc7XG4gICAgW2s6IHN0cmluZ106IHVua25vd247XG4gIH0+O1xuICB0b3RhbD86IG51bWJlcjtcbiAgc2l6ZT86IG51bWJlcjtcbn1cbmNvbnN0IExJTUlUID0gMTAwO1xuY29uc3Qgc3luYyA9IHtcbiAgdHlwZTogXCJzeW5jXCIsXG4gIGRlc2NyaXB0aW9uOiAnUHVsbHMgZUJheSBpbnZlbnRvcnkgaXRlbXMgdmlhIFNlbGwgSW52ZW50b3J5IEFQSSB2MSB3aXRoIG9mZnNldCBwYWdpbmF0aW9uJyxcbiAgdmVyc2lvbjogJzEuMC4wJyxcbiAgZnJlcXVlbmN5OiAnZXZlcnkgNiBob3VycycsXG4gIGF1dG9TdGFydDogdHJ1ZSxcbiAgY2hlY2twb2ludDogQ2hlY2twb2ludFNjaGVtYSxcbiAgbW9kZWxzOiB7XG4gICAgRWJheUludmVudG9yeUl0ZW06IEViYXlJbnZlbnRvcnlJdGVtU2NoZW1hXG4gIH0sXG4gIGV4ZWM6IGFzeW5jIG5hbmdvID0+IHtcbiAgICBsZXQgb2Zmc2V0ID0gMDtcbiAgICBsZXQgdG90YWwgPSBJbmZpbml0eTtcbiAgICB3aGlsZSAob2Zmc2V0IDwgdG90YWwpIHtcbiAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IG5hbmdvLmdldDxJbnZlbnRvcnlJdGVtc1Jlc3BvbnNlPih7XG4gICAgICAgIGVuZHBvaW50OiBgL3NlbGwvaW52ZW50b3J5L3YxL2ludmVudG9yeV9pdGVtP2xpbWl0PSR7TElNSVR9Jm9mZnNldD0ke29mZnNldH1gLFxuICAgICAgICByZXRyaWVzOiAzXG4gICAgICB9KTtcbiAgICAgIGNvbnN0IGl0ZW1zID0gcmVzLmRhdGEuaW52ZW50b3J5SXRlbXMgPz8gW107XG4gICAgICB0b3RhbCA9IHJlcy5kYXRhLnRvdGFsID8/IDA7XG4gICAgICBjb25zdCByZWNvcmRzOiBFYmF5SW52ZW50b3J5SXRlbVtdID0gaXRlbXMubWFwKGl0ZW0gPT4gKHtcbiAgICAgICAgaWQ6IGl0ZW0uc2t1LFxuICAgICAgICBza3U6IGl0ZW0uc2t1LFxuICAgICAgICBjb25kaXRpb246IGl0ZW1bJ2NvbmRpdGlvbiddIGFzIHN0cmluZyB8IHVuZGVmaW5lZCA/PyBudWxsLFxuICAgICAgICBsb2NhbGU6IGl0ZW1bJ2xvY2FsZSddIGFzIHN0cmluZyB8IHVuZGVmaW5lZCA/PyBudWxsLFxuICAgICAgICBhdmFpbGFiaWxpdHk6IGl0ZW1bJ2F2YWlsYWJpbGl0eSddIGFzIEViYXlJbnZlbnRvcnlJdGVtWydhdmFpbGFiaWxpdHknXSA/PyBudWxsLFxuICAgICAgICBwcm9kdWN0OiBpdGVtWydwcm9kdWN0J10gYXMgRWJheUludmVudG9yeUl0ZW1bJ3Byb2R1Y3QnXSA/PyBudWxsXG4gICAgICB9KSk7XG4gICAgICBpZiAocmVjb3Jkcy5sZW5ndGggPiAwKSB7XG4gICAgICAgIGF3YWl0IG5hbmdvLmJhdGNoU2F2ZShyZWNvcmRzLCAnRWJheUludmVudG9yeUl0ZW0nKTtcbiAgICAgIH1cbiAgICAgIG9mZnNldCArPSBMSU1JVDtcbiAgICAgIGlmIChpdGVtcy5sZW5ndGggPCBMSU1JVCkgYnJlYWs7XG4gICAgfVxuICAgIGF3YWl0IG5hbmdvLnNhdmVDaGVja3BvaW50KHtcbiAgICAgIGZ1bGx5X3N5bmNlZDogJ3RydWUnXG4gICAgfSk7XG4gIH1cbn07XG5leHBvcnQgdHlwZSBOYW5nb1N5bmNMb2NhbCA9IFBhcmFtZXRlcnM8KHR5cGVvZiBzeW5jKVsnZXhlYyddPlswXTtcbmV4cG9ydCBkZWZhdWx0IHN5bmM7Il0sCiAgIm1hcHBpbmdzIjogIjs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQ0EsaUJBQWtCO0FBQ2xCLElBQU0sbUJBQW1CLGFBQUUsT0FBTztBQUFBLEVBQ2hDLGNBQWMsYUFBRSxPQUFPO0FBQ3pCLENBQUM7QUFDRCxJQUFNLDBCQUEwQixhQUFFLE9BQU87QUFBQSxFQUN2QyxJQUFJLGFBQUUsT0FBTztBQUFBLEVBQ2IsS0FBSyxhQUFFLE9BQU87QUFBQSxFQUNkLFdBQVcsYUFBRSxPQUFPLEVBQUUsU0FBUyxFQUFFLFNBQVM7QUFBQSxFQUMxQyxRQUFRLGFBQUUsT0FBTyxFQUFFLFNBQVMsRUFBRSxTQUFTO0FBQUEsRUFDdkMsY0FBYyxhQUFFLE9BQU87QUFBQSxJQUNyQiw0QkFBNEIsYUFBRSxPQUFPO0FBQUEsTUFDbkMsVUFBVSxhQUFFLE9BQU87QUFBQSxJQUNyQixDQUFDLEVBQUUsU0FBUztBQUFBLEVBQ2QsQ0FBQyxFQUFFLFNBQVMsRUFBRSxTQUFTO0FBQUEsRUFDdkIsU0FBUyxhQUFFLE9BQU87QUFBQSxJQUNoQixPQUFPLGFBQUUsT0FBTyxFQUFFLFNBQVM7QUFBQSxJQUMzQixhQUFhLGFBQUUsT0FBTyxFQUFFLFNBQVM7QUFBQSxFQUNuQyxDQUFDLEVBQUUsU0FBUyxFQUFFLFNBQVM7QUFDekIsQ0FBQztBQVVELElBQU0sUUFBUTtBQUNkLElBQU0sT0FBTztBQUFBLEVBQ1gsTUFBTTtBQUFBLEVBQ04sYUFBYTtBQUFBLEVBQ2IsU0FBUztBQUFBLEVBQ1QsV0FBVztBQUFBLEVBQ1gsV0FBVztBQUFBLEVBQ1gsWUFBWTtBQUFBLEVBQ1osUUFBUTtBQUFBLElBQ04sbUJBQW1CO0FBQUEsRUFDckI7QUFBQSxFQUNBLE1BQU0sT0FBTSxVQUFTO0FBQ25CLFFBQUksU0FBUztBQUNiLFFBQUksUUFBUTtBQUNaLFdBQU8sU0FBUyxPQUFPO0FBQ3JCLFlBQU0sTUFBTSxNQUFNLE1BQU0sSUFBNEI7QUFBQSxRQUNsRCxVQUFVLDJDQUEyQyxLQUFLLFdBQVcsTUFBTTtBQUFBLFFBQzNFLFNBQVM7QUFBQSxNQUNYLENBQUM7QUFDRCxZQUFNLFFBQVEsSUFBSSxLQUFLLGtCQUFrQixDQUFDO0FBQzFDLGNBQVEsSUFBSSxLQUFLLFNBQVM7QUFDMUIsWUFBTSxVQUErQixNQUFNLElBQUksV0FBUztBQUFBLFFBQ3RELElBQUksS0FBSztBQUFBLFFBQ1QsS0FBSyxLQUFLO0FBQUEsUUFDVixXQUFXLEtBQUssV0FBVyxLQUEyQjtBQUFBLFFBQ3RELFFBQVEsS0FBSyxRQUFRLEtBQTJCO0FBQUEsUUFDaEQsY0FBYyxLQUFLLGNBQWMsS0FBMEM7QUFBQSxRQUMzRSxTQUFTLEtBQUssU0FBUyxLQUFxQztBQUFBLE1BQzlELEVBQUU7QUFDRixVQUFJLFFBQVEsU0FBUyxHQUFHO0FBQ3RCLGNBQU0sTUFBTSxVQUFVLFNBQVMsbUJBQW1CO0FBQUEsTUFDcEQ7QUFDQSxnQkFBVTtBQUNWLFVBQUksTUFBTSxTQUFTLE1BQU87QUFBQSxJQUM1QjtBQUNBLFVBQU0sTUFBTSxlQUFlO0FBQUEsTUFDekIsY0FBYztBQUFBLElBQ2hCLENBQUM7QUFBQSxFQUNIO0FBQ0Y7QUFFQSxJQUFPLCtCQUFROyIsCiAgIm5hbWVzIjogW10KfQo=
