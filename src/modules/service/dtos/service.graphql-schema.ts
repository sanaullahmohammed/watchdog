const serviceSchema = `
  type Service {
    id: ID!
    serviceGroupId: ID
    name: String!
    slug: String!
    description: String
    manualStatusOverride: ServiceStatus
    isPublic: Boolean!
    displayOrder: Int!
    archivedAt: String
    lastKnownStatus: ServiceStatus!
  }
`;

export default serviceSchema;
