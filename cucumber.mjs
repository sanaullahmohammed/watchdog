// https://github.com/cucumber/cucumber-js/blob/main/docs/configuration.md
const config = {
  // Steps and support live under tests/. The boilerplate also required every
  // file in src/, which would import each *.integration.test.ts and run its
  // node:test suites inside Cucumber's process.
  require: ['cucumber.setup.js', 'tests/**/*.ts'],
  paths: ['tests/**/*.feature'],
  format: [
    'json:reports/cucumber-report.json',
    'html:reports/index.html',
    'summary',
    'progress-bar',
    '@cucumber/pretty-formatter',
  ],
  formatOptions: { snippetInterface: 'async-await' },
};

export default config;
