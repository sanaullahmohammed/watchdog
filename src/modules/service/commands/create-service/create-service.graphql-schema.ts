const serviceCreateSchema = `
  input CreateServicePayload {
    name: String!
    slug: String!
    description: String
    isPublic: Boolean
    displayOrder: Int
    serviceGroupId: ID
  }

  type Mutation {
    createService(input: CreateServicePayload!): ID!
  }
`;

export default serviceCreateSchema;
