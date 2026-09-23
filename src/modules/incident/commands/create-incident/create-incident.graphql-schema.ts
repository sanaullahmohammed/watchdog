const incidentCreateSchema = `
  input AffectedServiceInput {
    serviceId: ID!
    impact: IncidentImpact!
  }

  input CreateIncidentPayload {
    title: String!
    impact: IncidentImpact!
    startedAt: String
    affectedServices: [AffectedServiceInput!]
    message: String
  }

  type Mutation {
    createIncident(input: CreateIncidentPayload!): ID!
  }
`;

export default incidentCreateSchema;
