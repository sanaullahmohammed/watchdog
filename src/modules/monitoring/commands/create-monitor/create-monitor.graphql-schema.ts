const monitorCreateSchema = `
  input CreateMonitorPayload {
    serviceId: ID!
    "http, tcp, keyword or ssl_expiry. A String: the handler refuses any other."
    type: String!
    name: String!
    target: String!
    intervalSeconds: Int
    timeoutSeconds: Int
    failureThreshold: Int
    enabled: Boolean
    config: MonitorConfigInput
  }

  type Mutation {
    createMonitor(input: CreateMonitorPayload!): ID!
  }
`;

export default monitorCreateSchema;
