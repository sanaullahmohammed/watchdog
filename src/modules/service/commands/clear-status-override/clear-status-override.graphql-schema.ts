const clearStatusOverrideSchema = `
  type Mutation {
    clearServiceStatusOverride(id: ID!): Boolean!
  }
`;

export default clearStatusOverrideSchema;
