const scheduleMaintenanceSchema = `
  input ScheduleMaintenancePayload {
    title: String!
    description: String
    scheduledStartAt: String!
    scheduledEndAt: String!
    affectedServiceIds: [ID!]
  }

  type Mutation {
    scheduleMaintenance(input: ScheduleMaintenancePayload!): ID!
  }
`;

export default scheduleMaintenanceSchema;
