const serviceGroupUpdateSchema = `
  input UpdateServiceGroupPayload {
    name: String
    slug: String
    displayOrder: Int
  }

  type Mutation {
    updateServiceGroup(id: ID!, input: UpdateServiceGroupPayload!): ID!
  }
`;

export default serviceGroupUpdateSchema;
