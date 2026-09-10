const completeMaintenanceSchema = `
  type Mutation {
    completeMaintenance(id: ID!): Boolean!
  }
`;

export default completeMaintenanceSchema;
