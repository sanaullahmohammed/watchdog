const maintenanceSchema = `
  enum MaintenanceStatus {
    scheduled
    in_progress
    completed
  }

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
