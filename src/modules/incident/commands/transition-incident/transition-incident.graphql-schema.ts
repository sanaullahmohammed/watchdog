const transitionIncidentSchema = `
  enum IncidentStatus {
    draft
    investigating
    identified
    monitoring
    resolved
  }

  input TransitionIncidentPayload {
    status: IncidentStatus!
    message: String
  }

  type Mutation {
    transitionIncident(id: ID!, input: TransitionIncidentPayload!): ID!
  }
`;

export default transitionIncidentSchema;
