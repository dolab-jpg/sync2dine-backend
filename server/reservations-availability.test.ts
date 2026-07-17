import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkTableAvailability } from './reservations-store';

describe('reservation availability', () => {
  it('returns available tables from disk when no supabase', async () => {
    const startsAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const result = await checkTableAvailability({ startsAt, partySize: 2 }, '00000000-0000-0000-0000-000000000001');
    assert.equal(result.ok, true);
    assert.ok(Array.isArray(result.availableTables));
  });
});
