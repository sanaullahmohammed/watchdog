/**
 * The admin dashboard's live channel (story 4.7, ARCHITECTURE 5.5). A signal,
 * not a copy of the change: the client re-reads through the ordinary queries.
 * A `resync` means notifications may have been lost and everything should be
 * re-read; its aggregate is the organization. Subscriptions only: queries and
 * mutations stay on HTTP `/graphql`.
 */
const organizationEventsSchema = `
  type OrganizationEvent {
    eventName: String!
    aggregateType: String!
    aggregateId: String!
    occurredAt: String!
  }

  type Subscription {
    organizationEvents: OrganizationEvent!
  }
`;

export default organizationEventsSchema;
