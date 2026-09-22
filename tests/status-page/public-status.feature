Feature: Public status page
  Anyone holding an organization's link can read its status page, with no
  account and no session. FR17.

  Background:
    Given an organization with a public status page
    And it has public services "Checkout" and "Search"
    And an active incident "Checkout is slow" affecting "Checkout"
    And a scheduled maintenance window "Search reindex" affecting "Search"

  Scenario: A visitor with no credentials sees what is happening
    When a visitor opens the organization's status page with no credentials
    Then the page answers 200
    And it names the public service "Checkout" as "degraded"
    And it names the public service "Search" as "operational"
    And it shows the active incident "Checkout is slow"
    And it shows the scheduled window "Search reindex"
    And the overall status is "degraded"

  Scenario: What customers were never meant to see stays off the page
    Given a private service "Billing internals"
    And an archived service "Legacy API"
    And a draft incident "Monitor noise" the monitor has not confirmed
    And an active incident "Search is flaky" affecting "Search" and "Billing internals"
    And a scheduled maintenance window "Search upgrade" affecting "Search" and "Legacy API"
    And a critical incident "Ledger rebuild" affecting only "Billing internals"
    And a scheduled maintenance window "Legacy cleanup" affecting "Legacy API"
    When a visitor opens the organization's status page with no credentials
    Then the page answers 200
    And it lists the incident "Search is flaky" affecting only "Search"
    And it lists the window "Search upgrade" affecting only "Search"
    And it does not mention "Billing internals"
    And it does not mention "Legacy API"
    And it does not mention the id of "Billing internals"
    And it does not mention the id of "Legacy API"
    And it does not mention "Monitor noise"
    And it does not mention "Ledger rebuild"
    And it does not mention "Legacy cleanup"
    And the overall status is "degraded"

  Scenario: Every slug that names no page gets the same answer
    When a visitor opens the status page for a slug no organization has
    Then the page answers 404
    And the body is the one answer every miss gets
    And a slug over 100 characters gets that same answer
