// Database DDL is idempotently installed at boot by server/lib/db/schema.
// This marker makes the introduction explicit in each install's migration log.
export default {
  async up() {
    console.log('📰 Stacker News stewardship schema is managed by boot DDL');
    return { schema: 'stacker-news' };
  },
};
