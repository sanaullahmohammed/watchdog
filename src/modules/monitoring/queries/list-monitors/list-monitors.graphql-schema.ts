const listMonitorsSchema = `
  type Query {
    monitors(serviceId: ID!): [Monitor!]!
  }
`;

export default listMonitorsSchema;
