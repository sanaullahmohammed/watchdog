/**
 * The page's own types. `PublicStatusIncidentUpdate` is deliberately not the
 * incident module's `IncidentUpdate`: a field added there for operators, an
 * author or an internal note, would otherwise become selectable anonymously
 * through `publicStatusPage` (Epic 3 retrospective, R-10). The status ladders
 * it names are declared once in `src/shared/domain/status-ladders.graphql-schema.ts`.
 */
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
    updates: [PublicStatusIncidentUpdate!]!
  }

  "An update as the page publishes it: no field an operator added."
  type PublicStatusIncidentUpdate {
    id: ID!
    status: IncidentStatus!
    message: String!
    createdAt: String!
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
