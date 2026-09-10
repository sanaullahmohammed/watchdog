const incidentCreateSchema = `
  enum IncidentImpact {
    none
    minor
    major
    critical
  }

  input AffectedServiceInput {
    serviceId: ID!
    impact: IncidentImpact!
  }

  input CreateIncidentPayload {
    title: String!
    impact: IncidentImpact!
    startedAt: String
    affectedServices: [AffectedServiceInput!]
  }

  type Mutation {
    createIncident(input: CreateIncidentPayload!): ID!
  }
`;

export default incidentCreateSchema;
