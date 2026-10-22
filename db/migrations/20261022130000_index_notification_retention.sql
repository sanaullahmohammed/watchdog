-- migrate:up
-- Indexes for the retention prune (story 6.9), one per rule. Each predicate is
-- the prune's own, so the planner can use the index without proving it.
create index notification_deliveries_final_idx
on notification_deliveries (org_id, created_at)
where status in ('sent', 'failed', 'abandoned');

create index subscribers_unsubscribed_idx
on subscribers (org_id, updated_at)
where status = 'unsubscribed';

create index subscribers_pending_expiry_idx
on subscribers (org_id, confirmation_expires_at)
where status = 'pending';

-- migrate:down
drop index subscribers_pending_expiry_idx;
drop index subscribers_unsubscribed_idx;
drop index notification_deliveries_final_idx;
