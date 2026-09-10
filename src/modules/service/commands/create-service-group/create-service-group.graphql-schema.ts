const serviceGroupCreateSchema = `
  input CreateServiceGroupPayload {
    name: String!
    slug: String!
    displayOrder: Int
  }

  type Mutation {
    createServiceGroup(input: CreateServiceGroupPayload!): ID!
  }
`;

export default serviceGroupCreateSchema;
