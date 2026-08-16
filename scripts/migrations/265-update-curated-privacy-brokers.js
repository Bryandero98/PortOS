/**
 * Ensure updated curated privacy broker definitions are synced into privacy_brokers on upgrade (#4019).
 */
import { seedCuratedBrokers } from '../../server/services/privacyBrokers.js';

export default {
  async up() {
    await seedCuratedBrokers().catch(() => {});
  },
};
