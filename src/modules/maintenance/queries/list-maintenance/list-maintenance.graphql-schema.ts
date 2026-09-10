const listMaintenanceSchema = `
  input MaintenanceFilter {
    status: MaintenanceStatus
  }

  type Query {
    maintenanceWindows(filter: MaintenanceFilter): [Maintenance!]!
  }
`;

export default listMaintenanceSchema;
