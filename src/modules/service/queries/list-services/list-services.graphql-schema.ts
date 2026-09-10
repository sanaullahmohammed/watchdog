const listServicesSchema = `
  input ServiceFilter {
    includeArchived: Boolean
    publicOnly: Boolean
  }

  type Query {
    services(filter: ServiceFilter): [Service!]!
  }
`;

export default listServicesSchema;
