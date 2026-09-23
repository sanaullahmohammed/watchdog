const transitionIncidentSchema = `
  input TransitionIncidentPayload {
    status: IncidentStatus!
    message: String
  }

  type Mutation {
    transitionIncident(id: ID!, input: TransitionIncidentPayload!): ID!
  }
`;

export default transitionIncidentSchema;
