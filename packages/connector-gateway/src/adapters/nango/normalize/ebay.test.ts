// Tests for normalizeEbayRecord: externalId precedence (orderId/offerId/sku),
// Nango metadata stripping, modifiedAt derivation, and the missing-id error.

import { describe, it, expect } from 'bun:test';
import { normalizeEbayRecord } from './ebay.js';

describe('normalizeEbayRecord', () => {
  it('uses sku as externalId for inventory items', () => {
    const raw = { sku: 'ITEM-123', condition: 'NEW', _nango_metadata: { deleted_at: null } };
    const result = normalizeEbayRecord(raw, { marketplace: 'ebay' });
    expect(result.externalId).toBe('ITEM-123');
    expect(result.marketplace).toBe('ebay');
    expect((result.raw as any)._nango_metadata).toBeUndefined();
  });

  it('uses orderId as externalId for orders', () => {
    const raw = {
      orderId: 'ORD-001',
      creationDate: '2024-01-15T10:00:00.000Z',
      lastModifiedDate: '2024-01-16T10:00:00.000Z'
    };
    const result = normalizeEbayRecord(raw, { marketplace: 'ebay' });
    expect(result.externalId).toBe('ORD-001');
    expect(result.modifiedAt).toEqual(new Date('2024-01-16T10:00:00.000Z'));
  });

  it('uses offerId as externalId for offers', () => {
    const raw = { offerId: 'OFF-999', sku: 'ITEM-123', status: 'PUBLISHED' };
    const result = normalizeEbayRecord(raw, { marketplace: 'ebay' });
    expect(result.externalId).toBe('OFF-999');
  });

  it('throws when no stable id is present', () => {
    expect(() => normalizeEbayRecord({ title: 'broken' }, { marketplace: 'ebay' })).toThrow(
      'eBay record missing stable id'
    );
  });
});
