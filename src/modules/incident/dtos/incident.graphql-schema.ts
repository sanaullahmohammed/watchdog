const incidentSchema = `
  enum IncidentSource {
    manual
    monitoring
    ai_assisted
  }

  type IncidentUpdate {
    id: ID!
    status: IncidentStatus!
    message: String!
    createdAt: String!
  }

  type Incident {
    id: ID!
    title: String!
    status: IncidentStatus!
    impact: IncidentImpact!
    source: IncidentSource!
    startedAt: String!
    resolvedAt: String
  }
`;

export default incidentSchema;
