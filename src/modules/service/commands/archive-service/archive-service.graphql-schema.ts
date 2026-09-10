const serviceArchiveSchema = `
  type Mutation {
    archiveService(id: ID!): Boolean!
  }
`;

export default serviceArchiveSchema;
