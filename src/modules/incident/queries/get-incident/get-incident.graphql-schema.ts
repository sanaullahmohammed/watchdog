const getIncidentSchema = `
  type Query {
    incident(id: ID!): IncidentDetail!
  }
`;

export default getIncidentSchema;
