const updateMaintenanceSchema = `
  input UpdateMaintenancePayload {
    title: String
    description: String
    scheduledStartAt: String
    scheduledEndAt: String
    affectedServiceIds: [ID!]
  }

  type Mutation {
    updateMaintenance(id: ID!, input: UpdateMaintenancePayload!): ID!
  }
`;

export default updateMaintenanceSchema;
