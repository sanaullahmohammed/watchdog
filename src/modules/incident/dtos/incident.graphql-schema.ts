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

  type AffectedService {
    serviceId: ID!
    impact: IncidentImpact!
  }

  type IncidentDetail {
    id: ID!
    title: String!
    status: IncidentStatus!
    impact: IncidentImpact!
    source: IncidentSource!
    startedAt: String!
    resolvedAt: String
    affectedServices: [AffectedService!]!
  }
`;

export default incidentSchema;
