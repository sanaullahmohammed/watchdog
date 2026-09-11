const getServiceSchema = `
  type Query {
    service(id: ID!): Service!
  }
`;

export default getServiceSchema;
