const updateIncidentSchema = `
  input UpdateIncidentPayload {
    title: String
    impact: IncidentImpact
    affectedServices: [AffectedServiceInput!]
  }

  type Mutation {
    updateIncident(id: ID!, input: UpdateIncidentPayload!): ID!
  }
`;

export default updateIncidentSchema;
