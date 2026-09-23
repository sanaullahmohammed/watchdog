/**
 * The SDL side of the ladders in `status-inputs.ts`, declared once here for the
 * same reason the TypeScript ones live beside it: more than one module names
 * them, and modules may not import each other.
 *
 * Each was declared inside whichever slice happened to need it first, so the
 * public page's SDL borrowed `IncidentStatus` from a command slice and
 * `ServiceStatus` from the service module's admin DTOs. A type reached that way
 * grows whatever its owner needs next (Epic 3 retrospective, R-10).
 * `status-ladders.spec.ts` fails if a ladder here and its TypeScript
 * counterpart drift apart.
 *
 * `mergeTypeDefs` will not protect this. Its `throwOnConflict` guards
 * conflicting object and interface fields; two declarations of one enum are
 * merged by unioning their values, with no error, so a slice re-declaring a
 * ladder with an extra value would reach the served schema quietly.
 * `status-ladders.spec.ts` reads the merged schema and is what refuses it.
 */
const statusLaddersSchema = `
  enum ServiceStatus {
    operational
    degraded
    partial_outage
    major_outage
    maintenance
  }

  enum IncidentStatus {
    draft
    investigating
    identified
    monitoring
    resolved
  }

  enum IncidentImpact {
    none
    minor
    major
    critical
  }

  enum MaintenanceStatus {
    scheduled
    in_progress
    completed
  }

  "DOMAIN's rollup scale: computed from checks alone, never from incidents."
  enum UptimeDayStatus {
    operational
    degraded
    major_outage
  }
`;

export default statusLaddersSchema;
