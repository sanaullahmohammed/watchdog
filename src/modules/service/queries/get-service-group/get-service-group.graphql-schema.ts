const getServiceGroupSchema = `
  type Query {
    serviceGroup(id: ID!): ServiceGroup!
  }
`;

export default getServiceGroupSchema;
