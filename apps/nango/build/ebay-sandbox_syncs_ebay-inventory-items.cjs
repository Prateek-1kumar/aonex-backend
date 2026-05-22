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

// ebay-sandbox/syncs/ebay-inventory-items.ts
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiZWJheS1zYW5kYm94L3N5bmNzL2ViYXktaW52ZW50b3J5LWl0ZW1zLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgeyBjcmVhdGVTeW5jIH0gZnJvbSAnbmFuZ28nO1xuaW1wb3J0IHsgeiB9IGZyb20gJ3pvZCc7XG5jb25zdCBDaGVja3BvaW50U2NoZW1hID0gei5vYmplY3Qoe1xuICBmdWxseV9zeW5jZWQ6IHouc3RyaW5nKClcbn0pO1xuY29uc3QgRWJheUludmVudG9yeUl0ZW1TY2hlbWEgPSB6Lm9iamVjdCh7XG4gIGlkOiB6LnN0cmluZygpLFxuICBza3U6IHouc3RyaW5nKCksXG4gIGNvbmRpdGlvbjogei5zdHJpbmcoKS5udWxsYWJsZSgpLm9wdGlvbmFsKCksXG4gIGxvY2FsZTogei5zdHJpbmcoKS5udWxsYWJsZSgpLm9wdGlvbmFsKCksXG4gIGF2YWlsYWJpbGl0eTogei5vYmplY3Qoe1xuICAgIHNoaXBUb0xvY2F0aW9uQXZhaWxhYmlsaXR5OiB6Lm9iamVjdCh7XG4gICAgICBxdWFudGl0eTogei5udW1iZXIoKVxuICAgIH0pLm9wdGlvbmFsKClcbiAgfSkubnVsbGFibGUoKS5vcHRpb25hbCgpLFxuICBwcm9kdWN0OiB6Lm9iamVjdCh7XG4gICAgdGl0bGU6IHouc3RyaW5nKCkub3B0aW9uYWwoKSxcbiAgICBkZXNjcmlwdGlvbjogei5zdHJpbmcoKS5vcHRpb25hbCgpXG4gIH0pLm51bGxhYmxlKCkub3B0aW9uYWwoKVxufSk7XG50eXBlIEViYXlJbnZlbnRvcnlJdGVtID0gei5pbmZlcjx0eXBlb2YgRWJheUludmVudG9yeUl0ZW1TY2hlbWE+O1xuaW50ZXJmYWNlIEludmVudG9yeUl0ZW1zUmVzcG9uc2Uge1xuICBpbnZlbnRvcnlJdGVtcz86IEFycmF5PHtcbiAgICBza3U6IHN0cmluZztcbiAgICBbazogc3RyaW5nXTogdW5rbm93bjtcbiAgfT47XG4gIHRvdGFsPzogbnVtYmVyO1xuICBzaXplPzogbnVtYmVyO1xufVxuY29uc3QgTElNSVQgPSAxMDA7XG5jb25zdCBzeW5jID0ge1xuICB0eXBlOiBcInN5bmNcIixcbiAgZGVzY3JpcHRpb246ICdQdWxscyBlQmF5IGludmVudG9yeSBpdGVtcyB2aWEgU2VsbCBJbnZlbnRvcnkgQVBJIHYxIHdpdGggb2Zmc2V0IHBhZ2luYXRpb24nLFxuICB2ZXJzaW9uOiAnMS4wLjAnLFxuICBmcmVxdWVuY3k6ICdldmVyeSA2IGhvdXJzJyxcbiAgYXV0b1N0YXJ0OiB0cnVlLFxuICBjaGVja3BvaW50OiBDaGVja3BvaW50U2NoZW1hLFxuICBtb2RlbHM6IHtcbiAgICBFYmF5SW52ZW50b3J5SXRlbTogRWJheUludmVudG9yeUl0ZW1TY2hlbWFcbiAgfSxcbiAgZXhlYzogYXN5bmMgbmFuZ28gPT4ge1xuICAgIGxldCBvZmZzZXQgPSAwO1xuICAgIGxldCB0b3RhbCA9IEluZmluaXR5O1xuICAgIHdoaWxlIChvZmZzZXQgPCB0b3RhbCkge1xuICAgICAgY29uc3QgcmVzID0gYXdhaXQgbmFuZ28uZ2V0PEludmVudG9yeUl0ZW1zUmVzcG9uc2U+KHtcbiAgICAgICAgZW5kcG9pbnQ6IGAvc2VsbC9pbnZlbnRvcnkvdjEvaW52ZW50b3J5X2l0ZW0/bGltaXQ9JHtMSU1JVH0mb2Zmc2V0PSR7b2Zmc2V0fWAsXG4gICAgICAgIHJldHJpZXM6IDNcbiAgICAgIH0pO1xuICAgICAgY29uc3QgaXRlbXMgPSByZXMuZGF0YS5pbnZlbnRvcnlJdGVtcyA/PyBbXTtcbiAgICAgIHRvdGFsID0gcmVzLmRhdGEudG90YWwgPz8gMDtcbiAgICAgIGNvbnN0IHJlY29yZHM6IEViYXlJbnZlbnRvcnlJdGVtW10gPSBpdGVtcy5tYXAoaXRlbSA9PiAoe1xuICAgICAgICBpZDogaXRlbS5za3UsXG4gICAgICAgIHNrdTogaXRlbS5za3UsXG4gICAgICAgIGNvbmRpdGlvbjogaXRlbVsnY29uZGl0aW9uJ10gYXMgc3RyaW5nIHwgdW5kZWZpbmVkID8/IG51bGwsXG4gICAgICAgIGxvY2FsZTogaXRlbVsnbG9jYWxlJ10gYXMgc3RyaW5nIHwgdW5kZWZpbmVkID8/IG51bGwsXG4gICAgICAgIGF2YWlsYWJpbGl0eTogaXRlbVsnYXZhaWxhYmlsaXR5J10gYXMgRWJheUludmVudG9yeUl0ZW1bJ2F2YWlsYWJpbGl0eSddID8/IG51bGwsXG4gICAgICAgIHByb2R1Y3Q6IGl0ZW1bJ3Byb2R1Y3QnXSBhcyBFYmF5SW52ZW50b3J5SXRlbVsncHJvZHVjdCddID8/IG51bGxcbiAgICAgIH0pKTtcbiAgICAgIGlmIChyZWNvcmRzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgYXdhaXQgbmFuZ28uYmF0Y2hTYXZlKHJlY29yZHMsICdFYmF5SW52ZW50b3J5SXRlbScpO1xuICAgICAgfVxuICAgICAgb2Zmc2V0ICs9IExJTUlUO1xuICAgICAgaWYgKGl0ZW1zLmxlbmd0aCA8IExJTUlUKSBicmVhaztcbiAgICB9XG4gICAgYXdhaXQgbmFuZ28uc2F2ZUNoZWNrcG9pbnQoe1xuICAgICAgZnVsbHlfc3luY2VkOiAndHJ1ZSdcbiAgICB9KTtcbiAgfVxufTtcbmV4cG9ydCB0eXBlIE5hbmdvU3luY0xvY2FsID0gUGFyYW1ldGVyczwodHlwZW9mIHN5bmMpWydleGVjJ10+WzBdO1xuZXhwb3J0IGRlZmF1bHQgc3luYzsiXSwKICAibWFwcGluZ3MiOiAiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFDQSxpQkFBa0I7QUFDbEIsSUFBTSxtQkFBbUIsYUFBRSxPQUFPO0FBQUEsRUFDaEMsY0FBYyxhQUFFLE9BQU87QUFDekIsQ0FBQztBQUNELElBQU0sMEJBQTBCLGFBQUUsT0FBTztBQUFBLEVBQ3ZDLElBQUksYUFBRSxPQUFPO0FBQUEsRUFDYixLQUFLLGFBQUUsT0FBTztBQUFBLEVBQ2QsV0FBVyxhQUFFLE9BQU8sRUFBRSxTQUFTLEVBQUUsU0FBUztBQUFBLEVBQzFDLFFBQVEsYUFBRSxPQUFPLEVBQUUsU0FBUyxFQUFFLFNBQVM7QUFBQSxFQUN2QyxjQUFjLGFBQUUsT0FBTztBQUFBLElBQ3JCLDRCQUE0QixhQUFFLE9BQU87QUFBQSxNQUNuQyxVQUFVLGFBQUUsT0FBTztBQUFBLElBQ3JCLENBQUMsRUFBRSxTQUFTO0FBQUEsRUFDZCxDQUFDLEVBQUUsU0FBUyxFQUFFLFNBQVM7QUFBQSxFQUN2QixTQUFTLGFBQUUsT0FBTztBQUFBLElBQ2hCLE9BQU8sYUFBRSxPQUFPLEVBQUUsU0FBUztBQUFBLElBQzNCLGFBQWEsYUFBRSxPQUFPLEVBQUUsU0FBUztBQUFBLEVBQ25DLENBQUMsRUFBRSxTQUFTLEVBQUUsU0FBUztBQUN6QixDQUFDO0FBVUQsSUFBTSxRQUFRO0FBQ2QsSUFBTSxPQUFPO0FBQUEsRUFDWCxNQUFNO0FBQUEsRUFDTixhQUFhO0FBQUEsRUFDYixTQUFTO0FBQUEsRUFDVCxXQUFXO0FBQUEsRUFDWCxXQUFXO0FBQUEsRUFDWCxZQUFZO0FBQUEsRUFDWixRQUFRO0FBQUEsSUFDTixtQkFBbUI7QUFBQSxFQUNyQjtBQUFBLEVBQ0EsTUFBTSxPQUFNLFVBQVM7QUFDbkIsUUFBSSxTQUFTO0FBQ2IsUUFBSSxRQUFRO0FBQ1osV0FBTyxTQUFTLE9BQU87QUFDckIsWUFBTSxNQUFNLE1BQU0sTUFBTSxJQUE0QjtBQUFBLFFBQ2xELFVBQVUsMkNBQTJDLEtBQUssV0FBVyxNQUFNO0FBQUEsUUFDM0UsU0FBUztBQUFBLE1BQ1gsQ0FBQztBQUNELFlBQU0sUUFBUSxJQUFJLEtBQUssa0JBQWtCLENBQUM7QUFDMUMsY0FBUSxJQUFJLEtBQUssU0FBUztBQUMxQixZQUFNLFVBQStCLE1BQU0sSUFBSSxXQUFTO0FBQUEsUUFDdEQsSUFBSSxLQUFLO0FBQUEsUUFDVCxLQUFLLEtBQUs7QUFBQSxRQUNWLFdBQVcsS0FBSyxXQUFXLEtBQTJCO0FBQUEsUUFDdEQsUUFBUSxLQUFLLFFBQVEsS0FBMkI7QUFBQSxRQUNoRCxjQUFjLEtBQUssY0FBYyxLQUEwQztBQUFBLFFBQzNFLFNBQVMsS0FBSyxTQUFTLEtBQXFDO0FBQUEsTUFDOUQsRUFBRTtBQUNGLFVBQUksUUFBUSxTQUFTLEdBQUc7QUFDdEIsY0FBTSxNQUFNLFVBQVUsU0FBUyxtQkFBbUI7QUFBQSxNQUNwRDtBQUNBLGdCQUFVO0FBQ1YsVUFBSSxNQUFNLFNBQVMsTUFBTztBQUFBLElBQzVCO0FBQ0EsVUFBTSxNQUFNLGVBQWU7QUFBQSxNQUN6QixjQUFjO0FBQUEsSUFDaEIsQ0FBQztBQUFBLEVBQ0g7QUFDRjtBQUVBLElBQU8sK0JBQVE7IiwKICAibmFtZXMiOiBbXQp9Cg==
