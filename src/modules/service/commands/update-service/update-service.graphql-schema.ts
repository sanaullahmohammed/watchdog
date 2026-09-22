const serviceUpdateSchema = `
  input UpdateServicePayload {
    name: String
    "Shown to customers on the public status page."
    description: String
    isPublic: Boolean
    displayOrder: Int
    serviceGroupId: ID
  }

  type Mutation {
    updateService(id: ID!, input: UpdateServicePayload!): ID!
  }
`;

export default serviceUpdateSchema;
