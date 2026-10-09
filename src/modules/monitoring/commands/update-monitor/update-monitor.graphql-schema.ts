const monitorUpdateSchema = `
  input UpdateMonitorPayload {
    name: String
    target: String
    intervalSeconds: Int
    timeoutSeconds: Int
    failureThreshold: Int
    enabled: Boolean
    "Replaces the stored configuration whole."
    config: MonitorConfigInput
  }

  type Mutation {
    updateMonitor(id: ID!, input: UpdateMonitorPayload!): ID!
  }
`;

export default monitorUpdateSchema;
