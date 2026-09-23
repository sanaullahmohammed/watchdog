const publicStatusPageSchema = `
  type PublicStatusOrganization {
    name: String!
    slug: String!
  }

  type PublicStatusService {
    id: ID!
    name: String!
    "Written by the operator for customers."
    description: String
    status: ServiceStatus!
    displayOrder: Int!
  }

  "Services that belong to no group arrive in a group with a null id, last."
  type PublicStatusGroup {
    id: ID
    name: String
    displayOrder: Int
    services: [PublicStatusService!]!
  }

  type PublicStatusIncident {
    id: ID!
    title: String!
    impact: IncidentImpact!
    status: IncidentStatus!
    startedAt: String!
    "Visible services only. Empty when the incident names none yet."
    affectedServiceIds: [ID!]!
    "Oldest first. A renderer showing the latest reads the end."
    updates: [IncidentUpdate!]!
  }

  type PublicStatusMaintenance {
    id: ID!
    title: String!
    "Written by the operator for customers."
    description: String
    status: MaintenanceStatus!
    scheduledStartAt: String!
    scheduledEndAt: String!
    startedAt: String
    "Visible services only. Empty when the window names none."
    affectedServiceIds: [ID!]!
  }

  "DOMAIN's rollup scale: computed from checks alone, never from incidents."
  enum UptimeDayStatus {
    operational
    degraded
    major_outage
  }

  type PublicStatusUptimeDay {
    date: String!
    "Null on a day the rollups have no row for: no checks ran."
    uptimeRatio: Float
    "What colours the day's bar. Null on a day with no checks."
    worstStatus: UptimeDayStatus
  }

  type PublicStatusUptimeService {
    serviceId: ID!
    "One entry per day in the window, oldest first."
    days: [PublicStatusUptimeDay!]!
  }

  "Shaped now, filled in Epic 5: services is empty until rollups exist."
  type PublicStatusUptime {
    windowDays: Int!
    services: [PublicStatusUptimeService!]!
  }

  type PublicStatusPage {
    organization: PublicStatusOrganization!
    "The worst of the visible services' statuses and the listed incidents' headline impact."
    overallStatus: ServiceStatus!
    generatedAt: String!
    groups: [PublicStatusGroup!]!
    activeIncidents: [PublicStatusIncident!]!
    maintenance: [PublicStatusMaintenance!]!
    uptime: PublicStatusUptime!
  }

  type Query {
    publicStatusPage(orgSlug: ID!): PublicStatusPage!
  }
`;

export default publicStatusPageSchema;
