const monitorSchema = `
  type MonitorConfig {
    keyword: String
    warnDays: Int
  }

  type Monitor {
    id: ID!
    serviceId: ID!
    "http, tcp, keyword or ssl_expiry."
    type: String!
    name: String!
    target: String!
    intervalSeconds: Int!
    timeoutSeconds: Int!
    failureThreshold: Int!
    enabled: Boolean!
    config: MonitorConfig!
    consecutiveFailures: Int!
    lastCheckedAt: String
  }
`;

export default monitorSchema;
