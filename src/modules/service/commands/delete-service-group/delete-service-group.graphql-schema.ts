const serviceGroupDeleteSchema = `
  type Mutation {
    deleteServiceGroup(id: ID!): Boolean!
  }
`;

export default serviceGroupDeleteSchema;
