const serviceUpdateSchema = `
  input UpdateServicePayload {
    name: String
    description: String
    isPublic: Boolean
    displayOrder: Int
  }

  type Mutation {
    updateService(id: ID!, input: UpdateServicePayload!): ID!
  }
`;

export default serviceUpdateSchema;
