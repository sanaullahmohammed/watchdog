const timelineSchema = `
  type Query {
    incidentTimeline(id: ID!): [IncidentUpdate!]!
  }
`;

export default timelineSchema;
