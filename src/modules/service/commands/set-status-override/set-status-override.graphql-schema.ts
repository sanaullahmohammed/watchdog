const setStatusOverrideSchema = `
  input SetStatusOverridePayload {
    status: ServiceStatus!
  }

  type Mutation {
    setServiceStatusOverride(id: ID!, input: SetStatusOverridePayload!): Boolean!
  }
`;

export default setStatusOverrideSchema;
