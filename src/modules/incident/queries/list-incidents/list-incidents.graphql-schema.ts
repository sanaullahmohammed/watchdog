const listIncidentsSchema = `
  input IncidentFilter {
    includeDrafts: Boolean
    publicOnly: Boolean
    status: IncidentStatus
  }

  type Query {
    incidents(filter: IncidentFilter): [Incident!]!
  }
`;

export default listIncidentsSchema;
