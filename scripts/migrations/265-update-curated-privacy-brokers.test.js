/**
 * Test for migration 265 — ensure seedCuratedBrokers is invoked.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../server/services/privacyBrokers.js', () => ({
  seedCuratedBrokers: vi.fn().mockResolvedValue({ seeded: 52 }),
}));

import migration from './265-update-curated-privacy-brokers.js';
import { seedCuratedBrokers } from '../../server/services/privacyBrokers.js';

describe('migration 265 — update curated privacy brokers', () => {
  it('calls seedCuratedBrokers on up()', async () => {
    await migration.up();
    expect(seedCuratedBrokers).toHaveBeenCalled();
  });
});
