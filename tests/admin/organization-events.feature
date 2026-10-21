Feature: Organization events subscription
  An operator with the admin dashboard open is told over a GraphQL
  subscription whenever something in their organization changes, admin-only
  changes included, and re-reads what changed. Story 4.7.

  Background:
    Given an operator signed in to an organization of their own
    And the organization has a service "Checkout"
    And the operator is subscribed to the organization's events

  Scenario: A declared incident reaches the subscription
    When the operator declares the incident "Checkout is slow" on "Checkout"
    Then the subscription is sent "incident.created" for that incident

  Scenario: A monitor's draft incident reaches the subscription
    When a monitor opens a draft incident on "Checkout"
    Then the subscription is sent "incident.draft_created" for that incident

  Scenario: A service status change reaches the subscription
    When the operator sets the status of "Checkout" to "major_outage"
    Then the subscription is sent "service.status_changed" for the service "Checkout"
