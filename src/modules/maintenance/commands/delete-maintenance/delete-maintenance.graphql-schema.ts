const deleteMaintenanceSchema = `
  type Mutation {
    deleteMaintenance(id: ID!): Boolean!
  }
`;

export default deleteMaintenanceSchema;
