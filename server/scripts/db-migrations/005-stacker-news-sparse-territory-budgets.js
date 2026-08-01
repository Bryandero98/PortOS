/**
 * Early preview builds expanded omitted territory budgets to the global
 * defaults. Remove only that generated shape so account limits inherit again.
 */
export async function up(client) {
  await client.query(
    `UPDATE stacker_news_territories
     SET rules=rules-'actionBudget',updated_at=NOW()
     WHERE rules->'actionBudget'='{"maxPerHour":3,"maxPerDay":12,"minMinutesBetween":5}'::jsonb`,
  );
}
