const serviceRestoreSchema = `
  type Mutation {
    restoreService(id: ID!): Boolean!
  }
`;

export default serviceRestoreSchema;
