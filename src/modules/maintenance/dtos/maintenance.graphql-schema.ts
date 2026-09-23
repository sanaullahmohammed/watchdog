const maintenanceSchema = `
  type Maintenance {
    id: ID!
    title: String!
    description: String
    status: MaintenanceStatus!
    scheduledStartAt: String!
    scheduledEndAt: String!
    startedAt: String
    completedAt: String
    affectedServiceIds: [ID!]!
  }
`;

export default maintenanceSchema;
