const scheduleMaintenanceSchema = `
  input ScheduleMaintenancePayload {
    title: String!
    "Shown to customers on the public status page."
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
