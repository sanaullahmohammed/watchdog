const publicStatusPageSchema = `
  type PublicStatusOrganization {
    name: String!
    slug: String!
  }

  type PublicStatusPage {
    organization: PublicStatusOrganization!
  }

  type Query {
    publicStatusPage(orgSlug: ID!): PublicStatusPage!
  }
`;

export default publicStatusPageSchema;
