Feature: Public status stream
  A client holding an organization's status stream open is sent the page again
  whenever what the public sees changes, the same document the page answers.
  Story 4.6.

  Background:
    Given an organization with a public status page
    And it has public services "Checkout" and "Search"
    And a visitor holds the organization's status stream open

  Scenario: An incident reaches the open stream
    When an operator declares the incident "Checkout is slow" affecting "Checkout"
    Then the stream has been sent the status page as it is now
    And that page lists the incident "Checkout is slow"

  Scenario: A maintenance window reaches the open stream
    When an operator schedules the window "Search reindex" affecting "Search"
    Then the stream has been sent the status page as it is now
    And that page lists the window "Search reindex"

  Scenario: A service status change reaches the open stream
    When an operator overrides "Checkout" to "major_outage"
    Then the stream has been sent the status page as it is now
    And that page shows "Checkout" as "major_outage"
