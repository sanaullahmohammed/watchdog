const serviceCreateSchema = `
  input CreateServicePayload {
    name: String!
    slug: String!
    "Shown to customers on the public status page."
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
