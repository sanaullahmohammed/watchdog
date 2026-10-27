Feature: Subscribe to a status page and be notified until unsubscribing

  Background:
    Given an organization with a public service and an active incident
    And the clock is past the incident's opening entry

  Scenario: a subscriber is notified until they unsubscribe
    When the first visitor subscribes
    And the first visitor opens the link in the confirmation email
    Then the first visitor's subscription is confirmed
    When the second visitor subscribes
    And the second visitor opens the link in the confirmation email
    And the clock is past the last confirmation
    And the operator posts the update "We are looking into it."
    And the notification pass runs until the first visitor has 1 notification and the second visitor has 1 notification
    Then the first visitor has exactly 1 notification
    And the second visitor has exactly 1 notification
    And the first visitor's notification is for that update
    And the second visitor's notification is for that update
    When the first visitor opens the unsubscribe link in the notification
    Then the unsubscribe link answered that they are unsubscribed
    When the operator posts the update "A fix is rolling out."
    And the notification pass runs until the second visitor has 2 notifications
    Then the second visitor has exactly 2 notifications
    And the second visitor's notifications hold "We are looking into it." once and "A fix is rolling out." once
    And the first visitor has exactly 1 notification
    And the first visitor has exactly 1 confirmation email

  Scenario: a subscriber who never confirms is sent nothing
    When the third visitor subscribes
    And the fourth visitor subscribes
    And the fourth visitor opens the link in the confirmation email
    And the clock is past the last confirmation
    And the operator posts the update "We are looking into it."
    And the notification pass runs until the fourth visitor has 1 notification
    Then the fourth visitor has exactly 1 notification
    And the fourth visitor's notification is for that update
    And the third visitor has exactly 1 confirmation email
    And the third visitor has exactly 0 notifications
