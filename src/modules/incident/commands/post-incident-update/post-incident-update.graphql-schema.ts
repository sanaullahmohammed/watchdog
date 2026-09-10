const postIncidentUpdateSchema = `
  input PostIncidentUpdatePayload {
    message: String!
  }

  type Mutation {
    postIncidentUpdate(id: ID!, input: PostIncidentUpdatePayload!): ID!
  }
`;

export default postIncidentUpdateSchema;
