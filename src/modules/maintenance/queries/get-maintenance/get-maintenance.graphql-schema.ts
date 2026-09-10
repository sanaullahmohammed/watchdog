const getMaintenanceSchema = `
  type Query {
    maintenanceWindow(id: ID!): Maintenance!
  }
`;

export default getMaintenanceSchema;
